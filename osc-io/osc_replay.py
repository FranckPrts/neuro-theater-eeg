"""
osc_replay.py
-------------
Replays a JSON recording produced by osc_recorder.py with frame-accurate timing.

Dependencies:
    pip install python-osc

Usage:
    python osc_replay.py session.json                          # replay to localhost:9000
    python osc_replay.py session.json --host 192.168.1.5       # remote host
    python osc_replay.py session.json --port 8000              # custom port
    python osc_replay.py session.json --speed 0.5              # half speed
    python osc_replay.py session.json --speed 2.0              # double speed
    python osc_replay.py session.json --loop                   # loop indefinitely
    python osc_replay.py session.json --loop --loops 3         # loop 3 times
    python osc_replay.py session.json --start 5.0 --end 30.0   # replay a time window (seconds)
    python osc_replay.py session.json --dry-run                # print without sending
"""

# @author: @franckPrts

import argparse
import json
import signal
import sys
import time
from pathlib import Path

from pythonosc import udp_client


# ── Globals ───────────────────────────────────────────────────────────────────

_stop = False


def request_stop(sig, frame):
    global _stop
    print("\n■ Stop requested — finishing current loop…")
    _stop = True


signal.signal(signal.SIGINT, request_stop)


# ── Core replay ───────────────────────────────────────────────────────────────

def replay_once(
    messages: list[dict],
    client: udp_client.SimpleUDPClient | None,
    speed: float,
    dry_run: bool,
    loop_index: int,
    total_loops: int | None,
):
    """
    Replay a list of messages with wall-clock accurate timing.

    Args:
        messages:    Filtered, sorted list of OSC message dicts.
        client:      pythonosc UDP client (None for dry-run).
        speed:       Playback speed multiplier (1.0 = realtime).
        dry_run:     If True, print messages without sending.
        loop_index:  Current loop iteration (0-based).
        total_loops: Total loops to run, or None for infinite.
    """
    loop_label = f"∞" if total_loops is None else f"{loop_index + 1}/{total_loops}"
    print(f"\n▶  Loop {loop_label}  —  {len(messages)} messages  (speed ×{speed})\n")

    t0_wall = time.perf_counter()
    t0_rec  = messages[0]["t"]

    for i, msg in enumerate(messages):
        if _stop:
            break

        # How far into the recording this message sits (scaled by speed)
        rec_offset = (msg["t"] - t0_rec) / speed

        # How long we've actually been playing
        elapsed = time.perf_counter() - t0_wall

        # Sleep for any remaining gap (can be negative if we're behind — skip sleep)
        gap = rec_offset - elapsed
        if gap > 0.0005:                # 0.5 ms threshold to avoid busy-waiting on tiny gaps
            time.sleep(gap)

        address = msg["address"]
        args    = msg["args"]

        if dry_run:
            print(f"  [DRY {i+1:>5}]  t+{rec_offset:7.3f}s  {address}  →  {args}")
        else:
            try:
                # pythonosc expects individual args, not a list
                client.send_message(address, args)
                args_preview = ", ".join(str(a) for a in args[:4])
                print(f"  [{i+1:>5}]  t+{rec_offset:7.3f}s  {address}  →  {args_preview}")
            except Exception as e:
                print(f"  [ERR  ]  {address}  →  {e}", file=sys.stderr)


# ── Load & filter ─────────────────────────────────────────────────────────────

def load_messages(path: Path, start: float | None, end: float | None) -> list[dict]:
    data = json.loads(path.read_text())

    # Support both bare list and the {meta, messages} envelope from osc_recorder.py
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

    # Normalise: sort by timestamp just in case
    messages = sorted(messages, key=lambda m: m["t"])

    # Time-window filter (relative to first message)
    t0 = messages[0]["t"]
    if start is not None:
        messages = [m for m in messages if m["t"] - t0 >= start]
    if end is not None:
        messages = [m for m in messages if m["t"] - t0 <= end]

    if not messages:
        print("✗ No messages in the specified time window.", file=sys.stderr)
        sys.exit(1)

    return messages, meta


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Replay an OSC recording (JSON) with accurate timing.")
    parser.add_argument("file",              type=str,           help="Path to the .json recording")
    parser.add_argument("--host",            type=str,           default="127.0.0.1", help="Target host (default: 127.0.0.1)")
    parser.add_argument("--port",            type=int,           default=9000,        help="Target UDP port (default: 9000)")
    parser.add_argument("--speed",           type=float,         default=1.0,         help="Playback speed multiplier (default: 1.0)")
    parser.add_argument("--loop",            action="store_true",                     help="Loop playback indefinitely (or N times with --loops)")
    parser.add_argument("--loops",           type=int,           default=None,        help="Number of loops (requires --loop)")
    parser.add_argument("--start",           type=float,         default=None,        help="Start offset in seconds (relative to recording start)")
    parser.add_argument("--end",             type=float,         default=None,        help="End offset in seconds (relative to recording start)")
    parser.add_argument("--dry-run",         action="store_true",                     help="Print messages without sending over UDP")
    args = parser.parse_args()

    path = Path(args.file)
    if not path.exists():
        print(f"✗ File not found: {path}", file=sys.stderr)
        sys.exit(1)

    messages, meta = load_messages(path, args.start, args.end)

    # Print metadata if available
    if meta:
        print(f"\n● Recording metadata")
        for k, v in meta.items():
            print(f"  {k:<20} {v}")

    duration = (messages[-1]["t"] - messages[0]["t"]) / args.speed

    print(f"\n● Replay settings")
    print(f"  target    : {args.host}:{args.port}")
    print(f"  messages  : {len(messages)}")
    print(f"  duration  : {duration:.2f}s  (at speed ×{args.speed})")
    print(f"  loop      : {'∞' if args.loop and args.loops is None else args.loops if args.loop else 'no'}")
    print(f"  dry run   : {'yes' if args.dry_run else 'no'}")

    if args.dry_run:
        client = None
        print(f"\n  [DRY RUN — no UDP packets will be sent]\n")
    else:
        client = udp_client.SimpleUDPClient(args.host, args.port)
        print(f"\n  Sending…  press Ctrl+C to stop.\n")

    # ── Playback loop ──────────────────────────────────────────────────────────

    if args.loop:
        total = args.loops   # None = infinite
        i = 0
        while not _stop:
            if total is not None and i >= total:
                break
            replay_once(messages, client, args.speed, args.dry_run, i, total)
            i += 1
            if not _stop and (total is None or i < total):
                print("  ↺  Looping…")
    else:
        replay_once(messages, client, args.speed, args.dry_run, 0, 1)

    print("\n✓ Done.")


if __name__ == "__main__":
    main()
