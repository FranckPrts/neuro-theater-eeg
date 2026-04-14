"""
osc_recorder.py
---------------
Records incoming OSC messages to a timestamped JSON file.

Dependencies:
    pip install python-osc

Usage:
    python osc_recorder.py                          # default port 9000
    python osc_recorder.py --port 8000              # custom port
    python osc_recorder.py --port 9000 --out my_session.json
    python osc_recorder.py --filter /eeg            # only record /eeg/* addresses
"""

# @author: @franckPrts

import argparse
import json
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

from pythonosc import dispatcher, osc_server


# ── Global state ─────────────────────────────────────────────────────────────

messages = []
start_wall = None
recording = True


# ── Handlers ─────────────────────────────────────────────────────────────────

def handle_message(address, *args, _filter_prefix=None):
    """Called on every incoming OSC message."""
    if _filter_prefix and not address.startswith(_filter_prefix):
        return

    entry = {
        "t": time.time(),           # Unix epoch, float (µs precision)
        "address": address,
        "args": list(args),
    }
    messages.append(entry)

    # Live feedback
    args_preview = ", ".join(str(a) for a in args[:4])
    if len(args) > 4:
        args_preview += f" … (+{len(args) - 4})"
    print(f"  [{len(messages):>5}]  {address}  →  {args_preview}")


def build_dispatcher(filter_prefix=None):
    d = dispatcher.Dispatcher()

    # Wrap handler to bake in the filter
    def _handler(address, *args):
        handle_message(address, *args, _filter_prefix=filter_prefix)

    d.set_default_handler(_handler)
    return d


# ── Save ──────────────────────────────────────────────────────────────────────

def save(output_path: Path, port: int, filter_prefix: str | None):
    if not messages:
        print("\n⚠  No messages recorded — nothing saved.")
        return

    duration = messages[-1]["t"] - messages[0]["t"] if len(messages) > 1 else 0

    payload = {
        "meta": {
            "recorded_at": datetime.now(timezone.utc).isoformat(),
            "port": port,
            "filter": filter_prefix or "none (all addresses)",
            "message_count": len(messages),
            "duration_seconds": round(duration, 4),
            "schema_version": "1.0",
        },
        "messages": messages,
    }

    output_path.write_text(json.dumps(payload, indent=2))
    print(f"\n✓  Saved {len(messages)} messages ({duration:.2f}s) → {output_path}")


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Record OSC messages to JSON.")
    parser.add_argument("--port",   type=int,   default=9000,  help="UDP port to listen on (default: 9000)")
    parser.add_argument("--out",    type=str,   default=None,  help="Output file path (default: auto-named)")
    parser.add_argument("--filter", type=str,   default=None,  help="Only record addresses starting with this prefix, e.g. /eeg")
    args = parser.parse_args()

    # Auto-name output if not specified
    if args.out is None:
        ts = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
        output_path = Path(f"osc_recording_{ts}.json")
    else:
        output_path = Path(args.out)

    d = build_dispatcher(filter_prefix=args.filter)
    server = osc_server.ThreadingOSCUDPServer(("0.0.0.0", args.port), d)

    filter_msg = f"  filter : {args.filter}" if args.filter else "  filter : none (recording all addresses)"
    print(f"\n● OSC Recorder")
    print(f"  port   : {args.port}")
    print(filter_msg)
    print(f"  output : {output_path}")
    print(f"\n  Listening… press Ctrl+C to stop and save.\n")

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n■ Stopping…")
    finally:
        server.server_close()
        save(output_path, args.port, args.filter)


if __name__ == "__main__":
    main()
