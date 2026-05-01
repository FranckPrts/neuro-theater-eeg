"""
osc_proxy_failover.py
---------------------
Proxy OSC server with stale-stream failover.

Core behavior
-------------
- Listen for live OSC on UDP (default port 8001); emit proxied OSC (default port 8000).
- Detect stale streams (no packets, or frozen values); crossfade per address to fallback from JSON
  recordings; crossfade back when live data changes again.
- Fallbacks load from ``proxy_config.json`` → ``hardware_recordings`` (per headset) plus
  ``default_recording`` for addresses not covered by a per-hardware file.

**Multi-destination output** — optional ``output_ports`` array in ``proxy_config.json`` (e.g.
``[8000, 7999]``). ``--out-port`` on the CLI overrides the config when present; comma-separated
ports duplicate each emitted OSC packet to every listed UDP port on ``--out-host``.

OSC addresses are expected as ``/<hardware_id>/<stream>`` (see ``_extract_hardware_prefix``).

Session allowlist (optional)
----------------------------
Restrict live ingress, fallback tracks, and output to a fixed set of headset IDs (first path
segment). Two equivalent ways to enable:

**Config** — non-empty list (omit or use ``[]`` to allow all headsets)::

    "session": {
      "allowed_hardware": ["22FC", "1D1A", "2615"]
    }

**CLI** — overrides the config list when non-empty::

    python osc_proxy_failover.py --allowed-hardware 22FC,1D1A,2615

When a session allowlist is active:

- Live OSC for other headsets is dropped; ``fallback_tracks`` is filtered to the same IDs.
- **Bootstrap:** ``ProxyEngine.seed_streams_from_fallback()`` runs at startup. Every fallback
  address in scope gets a ``StreamState`` in ``FALLBACK`` mode immediately, so recording data is
  emitted for each allowed headset/stream even before that device sends live packets (devices
  not yet on the network still "exist" on the wire).
- **Live match:** When live OSC arrives for an address, ``ingest_live_message`` updates live
  samples; if values changed while in fallback, the engine switches to ``FADING_TO_LIVE`` so
  playback crossfades onto live (same path as recovering from stale live).

Without an allowlist, streams are created only after the first live packet per address (no
bootstrap).

Dependencies:
    pip install python-osc

Usage:
    python osc_proxy_failover.py
    python osc_proxy_failover.py --config proxy_config.json
    python osc_proxy_failover.py --in-port 8001 --out-port 8000 --recording recordings/random_recordings/session.json
    python osc_proxy_failover.py --in-port 8001 --out-port 8000,7999
    python osc_proxy_failover.py --config proxy_config.json --allowed-hardware 22FC,2265,1D1A
"""

from __future__ import annotations

import argparse
import json
import math
import signal
import sys
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from pythonosc import dispatcher, osc_server, udp_client


_stop = False


def request_stop(sig, frame):
    del sig, frame
    global _stop
    _stop = True
    print("\n■ Stop requested — shutting down proxy...")


signal.signal(signal.SIGINT, request_stop)


def _now() -> float:
    return time.perf_counter()


def _is_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _valid_float(value: Any) -> bool:
    if not _is_number(value):
        return False
    return math.isfinite(float(value))


def _median(values: list[float], fallback: float) -> float:
    if not values:
        return fallback
    items = sorted(values)
    n = len(items)
    mid = n // 2
    if n % 2 == 1:
        return items[mid]
    return 0.5 * (items[mid - 1] + items[mid])


def _lerp(a: float, b: float, t: float) -> float:
    return a + (b - a) * t


def blend_args(live_args: list[Any], fallback_args: list[Any], blend_t: float) -> list[Any]:
    """
    blend_t = 0.0 => live
    blend_t = 1.0 => fallback
    """
    if not live_args and not fallback_args:
        return []

    # Keep shape stable: use the shorter length where both sides can be blended.
    length = min(len(live_args), len(fallback_args))
    if length == 0:
        source = fallback_args if blend_t >= 0.5 else live_args
        return list(source)

    out: list[Any] = []
    for i in range(length):
        lv = live_args[i]
        fv = fallback_args[i]
        if _valid_float(lv) and _valid_float(fv):
            out.append(_lerp(float(lv), float(fv), blend_t))
        else:
            out.append(fv if blend_t >= 0.5 else lv)
    return out


def has_meaningful_change(previous: list[Any], current: list[Any], epsilon: float) -> bool:
    if len(previous) != len(current):
        return True
    if not previous and not current:
        return False

    for old, new in zip(previous, current):
        if _valid_float(old) and _valid_float(new):
            if abs(float(new) - float(old)) > epsilon:
                return True
        elif old != new:
            return True
    return False


@dataclass
class FallbackTrack:
    args_list: list[list[Any]]
    intervals: list[float]
    index: int = 0
    next_emit_at: float = 0.0

    def next_args(self) -> list[Any]:
        if not self.args_list:
            return []
        args = self.args_list[self.index]
        interval = self.intervals[self.index] if self.intervals else 0.05
        self.index = (self.index + 1) % len(self.args_list)
        self.next_emit_at = _now() + max(0.001, interval)
        return list(args)

    def reset_timing(self):
        self.next_emit_at = _now()


@dataclass
class StreamState:
    address: str
    stale_timeout: float
    epsilon: float
    live_last_args: list[Any] = field(default_factory=list)
    fallback_last_args: list[Any] = field(default_factory=list)
    last_input_at: float = 0.0
    last_change_at: float = 0.0
    last_emit_at: float = 0.0
    live_interval_ema: float | None = None
    mode: str = "LIVE"  # LIVE, FADING_TO_FALLBACK, FALLBACK, FADING_TO_LIVE
    fade_started_at: float = 0.0
    # True while this address was session-bootstrapped and no live packet has been applied yet;
    # cleared in ``ingest_live_message`` on first live sample (see ``ProxyEngine.seed_streams_from_fallback``).
    bootstrapped: bool = False

    def mark_live_message(self, args: list[Any], now: float):
        if self.last_input_at > 0:
            dt = now - self.last_input_at
            if dt > 0:
                if self.live_interval_ema is None:
                    self.live_interval_ema = dt
                else:
                    # Smooth but responsive.
                    self.live_interval_ema = (0.2 * dt) + (0.8 * self.live_interval_ema)

        changed = has_meaningful_change(self.live_last_args, args, self.epsilon)
        self.live_last_args = list(args)
        self.last_input_at = now
        if changed or self.last_change_at == 0:
            self.last_change_at = now
        return changed


class ProxyEngine:
    """Blend live OSC with per-address fallback tracks; optional session filter on headset IDs.

    ``allowed_hardware``: when set, only addresses ``/<id>/...`` with ``id`` in the frozenset are
    ingested or emitted; ``main()`` also filters ``fallback_tracks`` to those IDs. Call
    ``seed_streams_from_fallback()`` once after construction (see ``main``) so session runs
    bootstrap every fallback address before live data exists.
    """

    def __init__(
        self,
        out_host: str,
        out_ports: list[int],
        stale_default: float,
        epsilon_default: float,
        stale_overrides: dict[str, float],
        epsilon_overrides: dict[str, float],
        fade_to_fallback_s: float,
        fade_to_live_s: float,
        output_hz: float,
        fallback_tracks: dict[str, FallbackTrack],
        allowed_hardware: frozenset[str] | None = None,
    ):
        if not out_ports:
            raise ValueError("out_ports must be non-empty.")
        self._out_ports = list(out_ports)
        # Enable broadcast so default out-host can reach installation nodes.
        self._clients = [
            udp_client.SimpleUDPClient(out_host, port, allow_broadcast=True) for port in self._out_ports
        ]
        self.stale_default = stale_default
        self.epsilon_default = epsilon_default
        self.stale_overrides = stale_overrides
        self.epsilon_overrides = epsilon_overrides
        self.fade_to_fallback_s = fade_to_fallback_s
        self.fade_to_live_s = fade_to_live_s
        self.output_hz = max(1.0, output_hz)
        self.fallback_tracks = fallback_tracks
        self.allowed_hardware = allowed_hardware
        self.streams: dict[str, StreamState] = {}
        self.lock = threading.RLock()

    def _address_allowed(self, address: str) -> bool:
        if self.allowed_hardware is None:
            return True
        hw = _extract_hardware_prefix(address)
        return hw is not None and hw in self.allowed_hardware

    def _timeout_for(self, address: str) -> float:
        return float(self.stale_overrides.get(address, self.stale_default))

    def _epsilon_for(self, address: str) -> float:
        return float(self.epsilon_overrides.get(address, self.epsilon_default))

    def ensure_stream(self, address: str) -> StreamState:
        state = self.streams.get(address)
        if state is None:
            state = StreamState(
                address=address,
                stale_timeout=self._timeout_for(address),
                epsilon=self._epsilon_for(address),
            )
            self.streams[address] = state
        return state

    def seed_streams_from_fallback(self) -> int:
        """Eagerly open streams for session allowlist runs.

        If ``allowed_hardware`` is ``None``, returns 0 and does nothing.

        Otherwise, for each key in ``fallback_tracks`` (already restricted to allowed IDs in
        ``main``), ensures a ``StreamState`` exists, sets ``mode`` to ``FALLBACK`` and
        ``bootstrapped`` True when no live input has been seen yet (``last_input_at == 0``).
        ``tick()`` then drives OSC from the recording until the first live packet for that
        address triggers a fade/match via ``ingest_live_message``.

        Returns:
            Number of streams seeded (one per eligible fallback address without prior live).
        """
        if self.allowed_hardware is None:
            return 0
        n = 0
        with self.lock:
            for address in self.fallback_tracks.keys():
                if not self._address_allowed(address):
                    continue
                state = self.ensure_stream(address)
                if state.last_input_at > 0:
                    continue
                state.bootstrapped = True
                state.mode = "FALLBACK"
                track = self.fallback_tracks.get(address)
                if track:
                    track.reset_timing()
                n += 1
        return n

    def _switch_mode(self, state: StreamState, new_mode: str, reason: str):
        if state.mode == new_mode:
            return
        state.mode = new_mode
        state.fade_started_at = _now()
        print(f"[{state.address}] mode={new_mode} reason={reason}")
        if new_mode in {"FADING_TO_FALLBACK", "FALLBACK"}:
            track = self.fallback_tracks.get(state.address)
            if track:
                track.reset_timing()

    def ingest_live_message(self, address: str, args: list[Any]):
        """Record one live OSC message; may trigger crossfade from fallback to live."""
        if not self._address_allowed(address):
            return
        now = _now()
        with self.lock:
            state = self.ensure_stream(address)
            state.bootstrapped = False
            changed = state.mark_live_message(args, now)
            # Recovery trigger: any meaningful new change while in fallback side.
            if changed and state.mode in {"FALLBACK", "FADING_TO_FALLBACK"}:
                self._switch_mode(state, "FADING_TO_LIVE", "live_changed")

    def _is_stale(self, state: StreamState, now: float) -> bool:
        # Stale means either no packets for timeout, or no meaningful value change for timeout.
        if state.last_input_at == 0:
            return False
        silent_too_long = (now - state.last_input_at) >= state.stale_timeout
        frozen_too_long = (now - state.last_change_at) >= state.stale_timeout
        return silent_too_long or frozen_too_long

    def _blend_for_state(self, state: StreamState, now: float) -> float:
        if state.mode == "LIVE":
            return 0.0
        if state.mode == "FALLBACK":
            return 1.0
        if state.mode == "FADING_TO_FALLBACK":
            t = (now - state.fade_started_at) / max(0.001, self.fade_to_fallback_s)
            if t >= 1.0:
                state.mode = "FALLBACK"
                return 1.0
            return max(0.0, min(1.0, t))
        if state.mode == "FADING_TO_LIVE":
            t = (now - state.fade_started_at) / max(0.001, self.fade_to_live_s)
            if t >= 1.0:
                state.mode = "LIVE"
                return 0.0
            # Reverse blend during fade back.
            return 1.0 - max(0.0, min(1.0, t))
        return 0.0

    def _target_emit_interval(self, state: StreamState, track: FallbackTrack | None) -> float:
        live_interval = state.live_interval_ema if state.live_interval_ema is not None else (1.0 / self.output_hz)
        if track and track.intervals:
            fallback_interval = _median(track.intervals, live_interval)
            return min(live_interval, fallback_interval)
        return live_interval

    def tick(self):
        """Emit blended OSC for each known stream at pacing derived from live EMA and fallback."""
        now = _now()
        with self.lock:
            for address, state in self.streams.items():
                if not self._address_allowed(address):
                    continue
                track = self.fallback_tracks.get(address)
                stale = self._is_stale(state, now)

                if stale and state.mode in {"LIVE", "FADING_TO_LIVE"} and track and track.args_list:
                    self._switch_mode(state, "FADING_TO_FALLBACK", "stale_detected")
                elif (
                    (not stale)
                    and state.last_input_at > 0
                    and state.mode in {"FALLBACK", "FADING_TO_FALLBACK"}
                ):
                    # Live recovered after fallback (not bootstrapped-awaiting-live: last_input_at stays 0 there).
                    self._switch_mode(state, "FADING_TO_LIVE", "stream_fresh")

                interval = self._target_emit_interval(state, track)
                if state.last_emit_at > 0 and (now - state.last_emit_at) < max(0.001, interval):
                    continue

                fallback_args: list[Any] = []
                if track and track.args_list:
                    if track.next_emit_at == 0 or now >= track.next_emit_at:
                        state.fallback_last_args = track.next_args()
                    fallback_args = state.fallback_last_args

                blend_t = self._blend_for_state(state, now)

                if blend_t <= 0.0:
                    out_args = list(state.live_last_args)
                elif blend_t >= 1.0:
                    out_args = list(fallback_args if fallback_args else state.live_last_args)
                else:
                    out_args = blend_args(state.live_last_args, fallback_args, blend_t)

                if not out_args:
                    continue

                emitted = False
                for port, client in zip(self._out_ports, self._clients):
                    try:
                        client.send_message(address, out_args)
                        emitted = True
                    except Exception as exc:
                        print(f"[ERR] send {address} (port {port}): {exc}", file=sys.stderr)
                if emitted:
                    state.last_emit_at = now


def build_fallback_tracks(recording_path: Path) -> dict[str, FallbackTrack]:
    data = json.loads(recording_path.read_text())
    if isinstance(data, dict) and "messages" in data:
        messages = data["messages"]
    elif isinstance(data, list):
        messages = data
    else:
        raise ValueError("Unsupported recording format. Expected list or {meta, messages}.")

    per_address: dict[str, list[dict[str, Any]]] = {}
    for msg in messages:
        address = msg.get("address")
        args = msg.get("args")
        t = msg.get("t")
        if not isinstance(address, str) or not isinstance(args, list) or not _is_number(t):
            continue
        per_address.setdefault(address, []).append({"t": float(t), "args": args})

    tracks: dict[str, FallbackTrack] = {}
    for address, items in per_address.items():
        items.sort(key=lambda x: x["t"])
        args_list = [list(x["args"]) for x in items]
        if not args_list:
            continue

        intervals: list[float] = []
        if len(items) == 1:
            intervals = [0.05]
        else:
            for i in range(len(items)):
                t0 = items[i]["t"]
                t1 = items[(i + 1) % len(items)]["t"]
                dt = t1 - t0
                if i == len(items) - 1:
                    # wrap-around interval from end back to start
                    duration = items[-1]["t"] - items[0]["t"]
                    dt = duration / max(1, len(items) - 1)
                intervals.append(max(0.001, dt))

        tracks[address] = FallbackTrack(args_list=args_list, intervals=intervals)

    if not tracks:
        raise ValueError("Recording contains no valid OSC messages.")
    return tracks


def _resolve_path(raw: str, script_dir: Path) -> Path:
    path = Path(raw)
    if not path.is_absolute():
        path = (script_dir / path).resolve()
    return path


def _extract_hardware_prefix(address: str) -> str | None:
    # Expected OSC shape: /<hardware>/<stream>
    if not address.startswith("/"):
        return None
    parts = address.split("/")
    if len(parts) < 3:
        return None
    return parts[1] or None


def parse_allowed_hardware_from_config(config: dict[str, Any]) -> frozenset[str] | None:
    """Read ``session.allowed_hardware`` from proxy JSON.

    Returns:
        Frozenset of headset IDs, or ``None`` if session is absent or the list is empty
        (meaning: no restriction, all hardware allowed).

    Raises:
        ValueError: invalid ``session`` shape or ``allowed_hardware`` element types.
    """
    session = config.get("session")
    if session is None:
        return None
    if not isinstance(session, dict):
        raise ValueError("'session' must be an object with 'allowed_hardware'.")
    raw = session.get("allowed_hardware", [])
    if raw is None or raw == []:
        return None
    if not isinstance(raw, list):
        raise ValueError("'session.allowed_hardware' must be a list of strings.")
    out: set[str] = set()
    for item in raw:
        if not isinstance(item, str):
            raise ValueError("'session.allowed_hardware' entries must be strings.")
        s = item.strip()
        if s:
            out.add(s)
    return frozenset(out) if out else None


def parse_allowed_hardware_cli(value: str | None) -> frozenset[str] | None:
    """Parse ``--allowed-hardware`` (comma-separated IDs). Empty or whitespace → ``None`` (use config)."""
    if value is None or not str(value).strip():
        return None
    parts = [p.strip() for p in str(value).split(",")]
    out = {p for p in parts if p}
    return frozenset(out) if out else None


def filter_fallback_tracks_by_session(
    tracks: dict[str, FallbackTrack], allowed_hardware: frozenset[str]
) -> tuple[dict[str, FallbackTrack], int, int]:
    """Keep only fallback tracks whose OSC hardware prefix is in ``allowed_hardware``.

    Returns:
        ``(kept_tracks, n_before, n_dropped)`` where ``n_dropped`` is the number of addresses
        removed from ``tracks``.
    """
    kept: dict[str, FallbackTrack] = {}
    for address, track in tracks.items():
        hw = _extract_hardware_prefix(address)
        if hw is not None and hw in allowed_hardware:
            kept[address] = track
    n_before = len(tracks)
    n_after = len(kept)
    return kept, n_before, n_before - n_after


def _resolve_default_recording(cli_recording: str | None, config: dict[str, Any], script_dir: Path) -> Path:
    raw = cli_recording or config.get("default_recording")
    if raw:
        return _resolve_path(str(raw), script_dir)

    recordings_dir = script_dir / "recordings"
    candidates: list[Path] = []
    if recordings_dir.exists():
        rnd = recordings_dir / "random_recordings"
        if rnd.exists():
            candidates.extend(rnd.glob("osc_recording_*.json"))
        candidates.extend(recordings_dir.glob("osc_recording_*.json"))
    if candidates:
        candidates.sort(key=lambda p: p.stat().st_mtime, reverse=True)
        return candidates[0]
    raise FileNotFoundError(
        "No fallback recording specified and none found under osc-io/recordings/random_recordings/ "
        "(or legacy osc-io/recordings/*.json)."
    )


def load_fallback_tracks(
    cli_recording: str | None,
    config: dict[str, Any],
    script_dir: Path,
) -> tuple[dict[str, FallbackTrack], dict[str, int], Path]:
    """
    Load fallback tracks from:

    1) Per-hardware recording map in ``config["hardware_recordings"]`` (only messages whose
       address prefix matches that hardware id are kept per file).
    2) Default recording (``--recording`` or ``config["default_recording"]``) for addresses
       not already filled.

    Session ``allowed_hardware`` filtering happens in ``main()`` after this call
    (see ``filter_fallback_tracks_by_session``).
    """
    combined: dict[str, FallbackTrack] = {}
    loaded_counts: dict[str, int] = {}

    hardware_recordings = config.get("hardware_recordings", {})
    if hardware_recordings and not isinstance(hardware_recordings, dict):
        raise ValueError("'hardware_recordings' must be a dictionary of {hardware_id: recording_path}.")

    # Load per-hardware tracks first (highest priority).
    for hardware_id, raw_path in hardware_recordings.items():
        hardware = str(hardware_id).strip()
        if not hardware:
            continue
        if not isinstance(raw_path, str) or not raw_path.strip():
            print(f"[WARN] hardware_recordings[{hardware!r}] has empty path; skipping.")
            continue

        recording_path = _resolve_path(raw_path, script_dir)
        if not recording_path.exists():
            print(f"[WARN] Missing hardware recording for {hardware}: {recording_path}")
            continue

        try:
            tracks = build_fallback_tracks(recording_path)
        except Exception as exc:
            print(f"[WARN] Failed loading hardware recording for {hardware}: {recording_path} ({exc})")
            continue

        expected_prefix = f"/{hardware}/"
        accepted = 0
        for address, track in tracks.items():
            hw_prefix = _extract_hardware_prefix(address)
            if hw_prefix == hardware:
                combined[address] = track
                accepted += 1

        loaded_counts[f"hardware:{hardware}"] = accepted
        print(f"[fallback] loaded {accepted} address tracks for hardware {hardware} from {recording_path}")

    # Load default recording and only fill missing addresses.
    default_recording_path = _resolve_default_recording(cli_recording, config, script_dir)
    if not default_recording_path.exists():
        raise FileNotFoundError(f"Fallback recording not found: {default_recording_path}")

    default_tracks = build_fallback_tracks(default_recording_path)
    default_added = 0
    for address, track in default_tracks.items():
        if address not in combined:
            combined[address] = track
            default_added += 1
    loaded_counts["default"] = default_added

    if not combined:
        raise ValueError("No valid fallback tracks loaded from hardware mappings or default recording.")

    return combined, loaded_counts, default_recording_path


def load_config(config_path: Path | None) -> dict[str, Any]:
    if config_path is None:
        return {}
    if not config_path.exists():
        raise FileNotFoundError(f"Config file not found: {config_path}")
    return json.loads(config_path.read_text())


def _normalize_output_port_list(ports: list[int]) -> list[int]:
    """Deduplicate UDP ports while preserving first-seen order."""
    seen: set[int] = set()
    out: list[int] = []
    for p in ports:
        if p not in seen:
            seen.add(p)
            out.append(p)
    return out


def _parse_single_output_port(token: str, *, context: str) -> int:
    s = token.strip()
    if not s:
        raise ValueError(f"{context}: empty port token.")
    try:
        p = int(s, 10)
    except ValueError as exc:
        raise ValueError(f"{context}: not an integer port: {token!r}") from exc
    if p < 1 or p > 65535:
        raise ValueError(f"{context}: port out of range 1–65535: {p}")
    return p


def parse_output_ports(value: str | None) -> list[int] | None:
    """Parse ``--out-port`` comma-separated list. Whitespace around commas is ignored.

    Returns:
        Non-empty list of ports, or ``None`` if ``value`` is None/blank (use config / default).
    """
    if value is None or not str(value).strip():
        return None
    parts = [p.strip() for p in str(value).split(",")]
    raw_ports = [_parse_single_output_port(p, context="--out-port") for p in parts if p.strip()]
    if not raw_ports:
        return None
    return _normalize_output_port_list(raw_ports)


def parse_output_ports_from_config(config: dict[str, Any]) -> list[int] | None:
    """Read ``output_ports`` from proxy JSON. Empty list means unset.

    Raises:
        ValueError: invalid type or non-integer elements.
    """
    raw = config.get("output_ports")
    if raw is None:
        return None
    if not isinstance(raw, list):
        raise ValueError("'output_ports' must be a JSON array of integers.")
    if not raw:
        return None
    ports: list[int] = []
    for i, item in enumerate(raw):
        if isinstance(item, bool) or not isinstance(item, int):
            raise ValueError(f"'output_ports'[{i}] must be an integer (got {type(item).__name__}).")
        ports.append(_parse_single_output_port(str(item), context="output_ports"))
    return _normalize_output_port_list(ports)


def resolve_output_ports(cli_value: str | None, config: dict[str, Any]) -> list[int]:
    """CLI ``--out-port`` wins when present; else ``output_ports`` in config; else ``[8000]``."""
    cli_ports = parse_output_ports(cli_value)
    if cli_ports is not None:
        return cli_ports
    cfg_ports = parse_output_ports_from_config(config)
    if cfg_ports is not None:
        return cfg_ports
    return [8000]


def main():
    parser = argparse.ArgumentParser(
        description="Proxy OSC with stale-stream failover.",
        epilog="With --allowed-hardware or session.allowed_hardware, fallback tracks are filtered "
        "and every in-scope address is bootstrapped so recording OSC is sent until live matches.",
    )
    parser.add_argument("--in-host", type=str, default="0.0.0.0", help="Live OSC input host (default: 0.0.0.0)")
    parser.add_argument("--in-port", type=int, default=8001, help="Live OSC input port (default: 8001)")
    parser.add_argument("--out-host", type=str, default="192.168.10.255", help="Proxy OSC output host (default: 255.255.255.255)")
    parser.add_argument(
        "--out-port",
        type=str,
        default=None,
        metavar="PORTS",
        help="Proxy OSC output port(s), comma-separated for duplicate sends (default: config "
        "output_ports or 8000). Example: 8000,7999",
    )
    parser.add_argument("--config", type=str, default=None, help="Path to proxy_config.json")
    parser.add_argument("--recording", type=str, default=None, help="Fallback recording JSON path")
    parser.add_argument(
        "--allowed-hardware",
        type=str,
        default=None,
        metavar="IDS",
        help="Comma-separated headset IDs; overrides session.allowed_hardware. Enables session "
        "filter + bootstrap (recording on wire until live). Example: 22FC,2265,1D1A",
    )
    args = parser.parse_args()

    script_dir = Path(__file__).resolve().parent
    config_path = Path(args.config).resolve() if args.config else (script_dir / "proxy_config.json")
    config = load_config(config_path if config_path.exists() else None)

    try:
        out_ports = resolve_output_ports(args.out_port, config)
    except ValueError as exc:
        print(f"✗ Invalid output ports: {exc}", file=sys.stderr)
        sys.exit(1)

    try:
        allowed_hardware = parse_allowed_hardware_cli(args.allowed_hardware)
        if allowed_hardware is None:
            allowed_hardware = parse_allowed_hardware_from_config(config)
    except ValueError as exc:
        print(f"✗ Invalid session config: {exc}", file=sys.stderr)
        sys.exit(1)

    try:
        fallback_tracks, fallback_source_counts, default_recording_path = load_fallback_tracks(
            cli_recording=args.recording,
            config=config,
            script_dir=script_dir,
        )
    except Exception as exc:
        print(f"✗ Could not load fallback recordings: {exc}", file=sys.stderr)
        sys.exit(1)

    if allowed_hardware is not None:
        n_before = len(fallback_tracks)
        fallback_tracks, _, dropped = filter_fallback_tracks_by_session(fallback_tracks, allowed_hardware)
        print(
            f"[session] fallback tracks filtered: {len(fallback_tracks)} kept, {dropped} dropped "
            f"(session allowlist, was {n_before} addresses)"
        )
        if not fallback_tracks:
            print("✗ Session allowlist removed all fallback tracks.", file=sys.stderr)
            sys.exit(1)

    stale_default = float(config.get("stale_timeout_default_seconds", 2.0))
    epsilon_default = float(config.get("change_epsilon_default", 1e-6))
    fade_to_fallback_s = float(config.get("fade_to_fallback_seconds", 2.0))
    fade_to_live_s = float(config.get("fade_to_live_seconds", 2.0))
    output_hz = float(config.get("proxy_tick_hz", 120.0))
    stale_overrides = {str(k): float(v) for k, v in config.get("stale_timeout_overrides", {}).items()}
    epsilon_overrides = {str(k): float(v) for k, v in config.get("change_epsilon_overrides", {}).items()}

    engine = ProxyEngine(
        out_host=args.out_host,
        out_ports=out_ports,
        stale_default=stale_default,
        epsilon_default=epsilon_default,
        stale_overrides=stale_overrides,
        epsilon_overrides=epsilon_overrides,
        fade_to_fallback_s=fade_to_fallback_s,
        fade_to_live_s=fade_to_live_s,
        output_hz=output_hz,
        fallback_tracks=fallback_tracks,
        allowed_hardware=allowed_hardware,
    )

    boot_count = engine.seed_streams_from_fallback()
    if boot_count:
        print(f"[session] bootstrapped {boot_count} streams from fallback (awaiting live where absent)")

    d = dispatcher.Dispatcher()

    def _handler(address: str, *osc_args):
        engine.ingest_live_message(address, list(osc_args))

    d.set_default_handler(_handler)

    server = osc_server.ThreadingOSCUDPServer((args.in_host, args.in_port), d)
    print("\n● OSC Proxy Failover")
    print(f"  live in         : {args.in_host}:{args.in_port}")
    out_dest = ", ".join(f"{args.out_host}:{p}" for p in out_ports)
    print(f"  proxy out       : {out_dest}")
    print(f"  fallback default: {default_recording_path}")
    print(f"  fallback tracks : {len(fallback_tracks)} addresses")
    for source_name, count in sorted(fallback_source_counts.items()):
        print(f"  {source_name:<15} {count} tracks")
    if allowed_hardware is not None:
        ids = ", ".join(sorted(allowed_hardware))
        print(f"  session allow   : {ids} (other OSC dropped)")
    print(f"  stale default   : {stale_default}s")
    print(f"  fade in/out     : {fade_to_fallback_s}s / {fade_to_live_s}s")
    print(f"  tick rate       : {output_hz} Hz")
    print("\n  Running... press Ctrl+C to stop.\n")
    print("\n  Have fun :)\n")

    server_thread = threading.Thread(target=server.serve_forever, daemon=True)
    server_thread.start()

    tick_sleep = 1.0 / max(1.0, output_hz)
    try:
        while not _stop:
            engine.tick()
            time.sleep(tick_sleep)
    finally:
        server.shutdown()
        server.server_close()
        print("✓ Proxy stopped.")


if __name__ == "__main__":
    main()
