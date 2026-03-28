"""
LSL live stream discovery and manual selection
-----------------------------------------------
Discover outlets on the network, print them with indices, subscribe to one,
and print occasional samples.

Activate the project conda env (default name ``neurotheater``), then install:

    source neuro-theater-eeg/run_env_neurtheater.sh

From ``neuro-theater-eeg/``, either install the package with the LSL extra:

    pip install -e ".[lsl]"

or install only the binding:

    pip install 'pylsl>=1.16.0'

If ``import pylsl`` fails, install a LabStreaming Layer build that provides
liblsl for your platform (see https://github.com/sccn/liblsl ).

Config (edit below):
    WAIT_SEC      — how long to listen for streams during discovery
    STREAM_INDEX  — which row to open (0-based), or None to type at prompt
    PRINT_EVERY   — print every Nth successful pull (reduces terminal spam)
"""

import sys

# ── CONFIG ────────────────────────────────────────────────────────────────────
WAIT_SEC = 5.0
STREAM_INDEX = 0  # set to None to choose interactively after the list prints
PRINT_EVERY = 50
PULL_TIMEOUT = 1.0
# ───────────────────────────────────────────────────────────────────────────────


def discover_streams(wait_sec: float):
    """Return streams found by LSL discovery (order = subscription indices)."""
    import pylsl

    return pylsl.resolve_streams(wait_time=wait_sec)


def print_streams(streams) -> None:
    """Print one line per stream with its index."""
    if not streams:
        print("No LSL streams found (is a source running?).")
        return
    for i, s in enumerate(streams):
        uid = s.uid()
        uid_short = (uid[:8] + "…") if len(uid) > 12 else uid
        print(
            f"  [{i}]  name={s.name()!r}  type={s.type()!r}  "
            f"channels={s.channel_count()}  rate={s.nominal_srate():.1f} Hz  "
            f"host={s.hostname()!r}  source_id={s.source_id()!r}  uid={uid_short!r}"
        )


def open_inlet(streams, index: int):
    """Open a StreamInlet for streams[index]."""
    import pylsl

    if not streams:
        raise ValueError("No streams to open.")
    if index < 0 or index >= len(streams):
        raise IndexError(f"Stream index {index} out of range (0..{len(streams) - 1}).")
    return pylsl.StreamInlet(streams[index])


def run_live(inlet, print_every: int, pull_timeout: float) -> None:
    """Pull samples in a loop; print a short line every ``print_every`` pulls."""
    n = 0
    print("Streaming (Ctrl+C to stop)…")
    while True:
        sample, ts = inlet.pull_sample(timeout=pull_timeout)
        if sample is None:
            continue
        n += 1
        if n % print_every != 0:
            continue
        preview = sample[:6]
        extra = " …" if len(sample) > len(preview) else ""
        print(f"  pull #{n}  LSL_time={ts:.6f}  values={preview}{extra}")


def main() -> int:
    try:
        streams = discover_streams(WAIT_SEC)
    except Exception as e:
        print(f"Discovery failed: {e}", file=sys.stderr)
        return 1

    print(f"Streams (waited {WAIT_SEC}s):")
    print_streams(streams)
    if not streams:
        return 0

    if STREAM_INDEX is None:
        raw = input("Stream index: ").strip()
        try:
            index = int(raw)
        except ValueError:
            print("Not an integer.", file=sys.stderr)
            return 1
    else:
        index = STREAM_INDEX

    try:
        inlet = open_inlet(streams, index)
    except (ValueError, IndexError) as e:
        print(e, file=sys.stderr)
        return 1

    try:
        run_live(inlet, PRINT_EVERY, PULL_TIMEOUT)
    except KeyboardInterrupt:
        print("\nStopped.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
