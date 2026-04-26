"""
osc_replay_plot.py
------------------
Interactive 3-step UX for OSC recordings:

1) choose recording
2) choose stream target (headset-first or stream-type-first)
3) plot numeric args over time

Input format matches osc_recorder.py / osc_replay.py.

Dependencies (no python-osc required):

    pip install matplotlib numpy

Or from repo root:

    pip install -e ".[pyplot]"

Run from osc-io/ (recommended):

    cd osc-io && python osc_replay_plot.py
    python osc_replay_plot.py ../path/to/session.json

Quick examples:

    # Fully interactive (file + selection menu + plot)
    python osc_replay_plot.py

    # Skip file picker, keep stream menu
    python osc_replay_plot.py session.json

    # Directly target one OSC address (skip step 2 menu)
    python osc_replay_plot.py session.json --address /muse/eeg

    # Plot only a time window (seconds relative to first message)
    python osc_replay_plot.py session.json --start 10 --end 45

Selection UX (step 2):

- If recordings include multiple headsets, you can choose:
  - by headset label first, then stream under that headset, or
  - by stream type first (eeg/acc/gyro/...), then headset stream(s)
- In stream-type mode, you can choose one address or "all" addresses of that type.

Notes:

- Numeric-only args are plottable (int/float); mixed/string payloads are skipped.
- If arg widths differ for an address, rows are truncated to the minimum width.

# @author: @franckPrts
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import defaultdict
from pathlib import Path

# ── Load recording (same rules as osc_replay.py; standalone to avoid python-osc) ──


def load_messages(path: Path, start: float | None, end: float | None) -> tuple[list[dict], dict]:
    data = json.loads(path.read_text())

    if isinstance(data, list):
        messages = data
        meta = {}
    elif isinstance(data, dict) and "messages" in data:
        messages = data["messages"]
        meta = data.get("meta", {})
    else:
        print("✗ Unrecognised JSON format. Expected a list or {meta, messages} object.", file=sys.stderr)
        sys.exit(1)

    if not messages:
        print("✗ Recording contains no messages.", file=sys.stderr)
        sys.exit(1)

    messages = sorted(messages, key=lambda m: m["t"])
    t0 = messages[0]["t"]
    if start is not None:
        messages = [m for m in messages if m["t"] - t0 >= start]
    if end is not None:
        messages = [m for m in messages if m["t"] - t0 <= end]

    if not messages:
        print("✗ No messages in the specified time window.", file=sys.stderr)
        sys.exit(1)

    return messages, meta


def _script_dir() -> Path:
    return Path(__file__).resolve().parent


def discover_json_candidates() -> list[Path]:
    """*.json in cwd and osc-io/, de-duplicated by resolve()."""
    seen: set[Path] = set()
    out: list[Path] = []
    for base in (Path.cwd(), _script_dir()):
        if not base.exists():
            continue
        for p in sorted(base.glob("*.json")):
            rp = p.resolve()
            if rp in seen:
                continue
            out.append(p)
            seen.add(rp)
    return out


def prompt_recording_path(argv_path: str | None) -> Path:
    if argv_path:
        p = Path(argv_path).expanduser()
        if not p.exists():
            print(f"✗ File not found: {p}", file=sys.stderr)
            sys.exit(1)
        return p.resolve()

    print("\n● Step 1 — Choose recording\n")
    candidates = discover_json_candidates()
    if candidates:
        for i, p in enumerate(candidates):
            print(f"  [{i}]  {p}")
        print(f"  [{len(candidates)}]  Type a path manually\n")
        raw = input("Recording [0]: ").strip() or "0"
    else:
        print("  (no *.json in this directory or osc-io/)\n")
        raw = input("Path to .json recording: ").strip()
        if not raw:
            print("✗ No path given.", file=sys.stderr)
            sys.exit(1)

    if raw.isdigit() and candidates:
        idx = int(raw)
        if 0 <= idx < len(candidates):
            return candidates[idx].resolve()
        if idx == len(candidates):
            raw = input("Path to .json recording: ").strip()
            if not raw:
                print("✗ No path given.", file=sys.stderr)
                sys.exit(1)
        else:
            print(f"✗ Index out of range (0..{len(candidates) - 1}, or {len(candidates)} for custom path).", file=sys.stderr)
            sys.exit(1)

    p = Path(raw).expanduser()
    if not p.exists():
        print(f"✗ File not found: {p}", file=sys.stderr)
        sys.exit(1)
    return p.resolve()


def _numeric_row(args: list) -> list[float] | None:
    row: list[float] = []
    for a in args:
        if isinstance(a, bool):
            return None
        if isinstance(a, int) and not isinstance(a, bool):
            row.append(float(a))
        elif isinstance(a, float):
            row.append(a)
        else:
            return None
    return row


def stream_stats(messages: list[dict]) -> list[tuple[str, int, float | None]]:
    """
    Return sorted list of (address, count, approx_hz).
    approx_hz = count / duration for that address's first/last timestamp.
    """
    by_addr: dict[str, list[dict]] = defaultdict(list)
    for m in messages:
        by_addr[m["address"]].append(m)

    rows: list[tuple[str, int, float | None]] = []
    for addr in sorted(by_addr.keys()):
        msgs = by_addr[addr]
        n = len(msgs)
        dt = msgs[-1]["t"] - msgs[0]["t"]
        hz = (n - 1) / dt if n > 1 and dt > 0 else None
        rows.append((addr, n, hz))
    return rows


def _address_parts(address: str) -> list[str]:
    return [p for p in address.strip("/").split("/") if p]


def _address_headset(address: str) -> str:
    parts = _address_parts(address)
    return parts[0] if parts else "(root)"


def _address_stream_type(address: str) -> str:
    parts = _address_parts(address)
    if len(parts) >= 2:
        return parts[1]
    if len(parts) == 1:
        return parts[0]
    return "(root)"


def _parse_index(raw: str, *, allow_all: bool = False) -> int | None:
    text = raw.strip().lower()
    if allow_all and text in {"a", "all"}:
        return None
    try:
        return int(text)
    except ValueError:
        return -1


def _parse_index_list(raw: str, max_index: int) -> list[int]:
    """
    Parse stream selection tokens:
      - single: "3"
      - list:   "0,2,5"
      - range:  "1-4"
      - mixed:  "0,2-4,7"
      - all:    "a" / "all"
    Returns unique sorted indices.
    """
    text = raw.strip().lower()
    if text in {"a", "all"}:
        return list(range(max_index + 1))
    if not text:
        return []

    picked: set[int] = set()
    for token in [t.strip() for t in text.split(",") if t.strip()]:
        if "-" in token:
            parts = token.split("-", 1)
            if len(parts) != 2 or not parts[0].isdigit() or not parts[1].isdigit():
                return []
            lo = int(parts[0])
            hi = int(parts[1])
            if lo > hi:
                lo, hi = hi, lo
            if lo < 0 or hi > max_index:
                return []
            picked.update(range(lo, hi + 1))
            continue

        if not token.isdigit():
            return []
        idx = int(token)
        if idx < 0 or idx > max_index:
            return []
        picked.add(idx)

    return sorted(picked)


def prompt_stream_addresses(messages: list[dict], cli_address: str | None) -> list[str]:
    if cli_address:
        addrs = {m["address"] for m in messages}
        if cli_address not in addrs:
            print(f"✗ Address not in recording: {cli_address!r}", file=sys.stderr)
            sys.exit(1)
        return [cli_address]

    stats = stream_stats(messages)
    if not stats:
        print("✗ No OSC addresses found in recording.", file=sys.stderr)
        sys.exit(1)

    print("\n● Step 2 — Choose stream target\n")
    print("  [0]  by headset label  (headset → stream)")
    print("  [1]  by stream type    (type → headset stream[s])\n")
    mode = _parse_index(input("Mode [0]: ").strip() or "0")
    if mode not in (0, 1):
        print("✗ Enter 0 or 1.", file=sys.stderr)
        sys.exit(1)

    by_addr = {addr: (n, hz) for addr, n, hz in stats}

    if mode == 0:
        by_headset: dict[str, list[str]] = defaultdict(list)
        for addr, _, _ in stats:
            by_headset[_address_headset(addr)].append(addr)

        headsets = sorted(by_headset.keys())
        print("\n  Headsets:")
        for i, h in enumerate(headsets):
            print(f"  [{i}]  {h}  ({len(by_headset[h])} streams)")
        idx_h = _parse_index(input("\nHeadset index: ").strip())
        if idx_h is None or idx_h < 0 or idx_h >= len(headsets):
            print("✗ Invalid headset index.", file=sys.stderr)
            sys.exit(1)

        headset = headsets[idx_h]
        addrs = sorted(by_headset[headset], key=lambda a: (_address_stream_type(a), a))
        print(f"\n  Streams for headset '{headset}':")
        for i, addr in enumerate(addrs):
            n, hz = by_addr[addr]
            hz_s = f"{hz:.1f} Hz" if hz is not None else "n/a"
            stype = _address_stream_type(addr)
            preview = addr if len(addr) <= 72 else addr[:69] + "…"
            print(f"  [{i}]  [{stype}]  ({n} msgs, ~{hz_s})  {preview}")
        print("  [a]  all streams for this headset")
        print("\n  Select one or many streams: 0 | 0,2,4 | 1-3 | a")
        selected = _parse_index_list(input("\nStream selection: ").strip(), len(addrs) - 1)
        if not selected:
            print("✗ Invalid stream selection.", file=sys.stderr)
            sys.exit(1)
        return [addrs[i] for i in selected]

    by_type: dict[str, list[str]] = defaultdict(list)
    for addr, _, _ in stats:
        by_type[_address_stream_type(addr)].append(addr)

    stream_types = sorted(by_type.keys())
    print("\n  Stream types:")
    for i, stype in enumerate(stream_types):
        print(f"  [{i}]  {stype}  ({len(by_type[stype])} streams)")
    idx_t = _parse_index(input("\nType index: ").strip())
    if idx_t is None or idx_t < 0 or idx_t >= len(stream_types):
        print("✗ Invalid type index.", file=sys.stderr)
        sys.exit(1)

    chosen_type = stream_types[idx_t]
    addrs = sorted(by_type[chosen_type], key=lambda a: (_address_headset(a), a))
    print(f"\n  Streams for type '{chosen_type}':")
    for i, addr in enumerate(addrs):
        n, hz = by_addr[addr]
        hz_s = f"{hz:.1f} Hz" if hz is not None else "n/a"
        headset = _address_headset(addr)
        preview = addr if len(addr) <= 72 else addr[:69] + "…"
        print(f"  [{i}]  ({headset}, {n} msgs, ~{hz_s})  {preview}")
    print("  [a]  all streams of this type")
    print("\n  Select one or many streams: 0 | 0,2,4 | 1-3 | a")
    selected = _parse_index_list(input("\nStream selection: ").strip(), len(addrs) - 1)
    if not selected:
        print("✗ Invalid stream selection.", file=sys.stderr)
        sys.exit(1)
    return [addrs[i] for i in selected]


def build_plot_arrays(
    messages: list[dict],
    address: str,
    *,
    t0_global: float | None = None,
) -> tuple[list[float], list[list[float]], bool]:
    subset = [m for m in messages if m["address"] == address]
    if not subset:
        return [], [], False

    t0 = subset[0]["t"] if t0_global is None else t0_global

    times: list[float] = []
    rows: list[list[float]] = []
    widths: list[int] = []
    truncated = False
    for m in subset:
        r = _numeric_row(m.get("args", []))
        if r is not None:
            times.append(m["t"] - t0)
            rows.append(r)
            widths.append(len(r))

    if not rows:
        return times[:0], [], False

    w = min(widths)
    if w == 0:
        return times[:0], [], False
    if any(len(r) > w for r in rows):
        truncated = True
        rows = [r[:w] for r in rows]

    return times, rows, truncated


def run_plot(path: Path, address: str, messages: list[dict], meta: dict) -> None:
    import numpy as np
    import matplotlib.pyplot as plt

    times, rows, truncated = build_plot_arrays(messages, address)
    if not rows:
        print("✗ No numeric samples for this address (need int/float args).", file=sys.stderr)
        sys.exit(1)

    t = np.asarray(times, dtype=np.float64)
    y = np.asarray(rows, dtype=np.float64)

    print("\n● Step 3 — Plot\n")
    if truncated:
        print("  (note: arg rows had different lengths; truncated to minimum width)\n")

    fig, ax = plt.subplots(figsize=(10, 5))
    n_ch = y.shape[1]
    max_legend = 16
    for c in range(n_ch):
        label = f"ch{c}" if n_ch > 1 else "value"
        ax.plot(t, y[:, c], label=label if n_ch <= max_legend else None, linewidth=0.8)
    ax.set_xlabel("Time (s) from first sample")
    ax.set_ylabel("OSC args")
    title = f"{path.name}\n{address}"
    ax.set_title(title, fontsize=10)
    if n_ch <= max_legend and n_ch > 1:
        ax.legend(loc="upper right", fontsize=7, ncol=2)
    elif n_ch > max_legend:
        ax.text(0.01, 0.98, f"{n_ch} channels (legend omitted)", transform=ax.transAxes, va="top", fontsize=8)
    fig.tight_layout()
    plt.show()


def run_plot_many(path: Path, addresses: list[str], messages: list[dict], meta: dict) -> None:
    import numpy as np
    import matplotlib.pyplot as plt

    print("\n● Step 3 — Plot\n")
    t0_global = messages[0]["t"] if messages else 0.0
    fig, ax = plt.subplots(figsize=(11, 6))

    plotted = 0
    for addr in addresses:
        times, rows, _ = build_plot_arrays(messages, addr, t0_global=t0_global)
        if not rows:
            continue

        t = np.asarray(times, dtype=np.float64)
        y = np.asarray(rows, dtype=np.float64)
        n_ch = y.shape[1]
        for c in range(n_ch):
            label = f"{addr}:ch{c}" if n_ch > 1 else addr
            ax.plot(t, y[:, c], label=label, linewidth=0.85)
        plotted += 1

    ax.set_xlabel("Time (s) from recording start")
    ax.set_ylabel("OSC args")
    ax.set_title(f"{path.name} — {len(addresses)} selected stream(s)", fontsize=10)
    if plotted > 0:
        handles, labels = ax.get_legend_handles_labels()
        if len(labels) <= 20:
            ax.legend(loc="upper right", fontsize=7, ncol=2)
        else:
            ax.text(0.01, 0.98, f"{len(labels)} traces (legend hidden)", transform=ax.transAxes, va="top", fontsize=8)
    fig.tight_layout()
    plt.show()

    if plotted == 0:
        print("✗ None of the selected streams had numeric samples.", file=sys.stderr)
        sys.exit(1)


def main() -> None:
    parser = argparse.ArgumentParser(description="Plot one OSC address from a JSON recording (3-step UX).")
    parser.add_argument("file", nargs="?", default=None, help="Recording .json (optional; else menu)")
    parser.add_argument("--address", type=str, default=None, help="OSC address; skips stream menu")
    parser.add_argument("--start", type=float, default=None, help="Start offset in seconds (same as osc_replay.py)")
    parser.add_argument("--end", type=float, default=None, help="End offset in seconds")
    args = parser.parse_args()

    path = prompt_recording_path(args.file)
    messages, meta = load_messages(path, args.start, args.end)

    if meta:
        print(f"\n● Metadata")
        for k, v in meta.items():
            print(f"  {k:<22} {v}")

    addresses = prompt_stream_addresses(messages, args.address)
    run_plot_many(path, addresses, messages, meta)
    print("\n✓ Done.")


if __name__ == "__main__":
    main()
