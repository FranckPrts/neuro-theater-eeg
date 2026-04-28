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
from collections import Counter
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

def _hardware_id_from_address(address: str) -> str | None:
    if not address.startswith("/"):
        return None
    parts = address.split("/")
    if len(parts) < 3:
        return None
    return parts[1] or None


def summarize_messages(entries: list[dict]) -> dict:
    by_address = Counter()
    hardware_ids: set[str] = set()

    for entry in entries:
        address = entry.get("address")
        if not isinstance(address, str):
            continue
        by_address[address] += 1
        hardware_id = _hardware_id_from_address(address)
        if hardware_id is not None:
            hardware_ids.add(hardware_id)

    streams = [
        {"address": address, "count": count}
        for address, count in by_address.most_common()
    ]
    return {
        "hardware_present": sorted(hardware_ids),
        "unique_address_count": len(by_address),
        "streams": streams,
    }


def print_summary(meta: dict, output_path: Path):
    duration = float(meta["duration_seconds"])
    message_count = int(meta["message_count"])
    msg_per_sec = (message_count / duration) if duration > 0 else 0.0
    hardware = meta.get("hardware_present", [])
    streams = meta.get("streams", [])
    max_streams_to_print = 40

    print(f"\n✓  Saved recording → {output_path}")
    print("  Session summary:")
    print(f"    recorded_at : {meta['recorded_at']}")
    print(f"    duration    : {duration:.4f}s")
    print(f"    messages    : {message_count}")
    print(f"    rate        : {msg_per_sec:.2f} msg/s")
    print(f"    hardware    : {', '.join(hardware) if hardware else 'none detected'}")
    print(f"    addresses   : {meta['unique_address_count']} unique")
    print("    streams:")

    shown = min(len(streams), max_streams_to_print)
    for stream in streams[:shown]:
        print(f"      - {stream['address']}: {stream['count']}")

    if len(streams) > max_streams_to_print:
        remaining = len(streams) - max_streams_to_print
        print(f"      - ... and {remaining} more (see meta.streams in JSON)")


def save(output_path: Path, port: int, filter_prefix: str | None):
    if not messages:
        print("\n⚠  No messages recorded — nothing saved.")
        return

    duration = messages[-1]["t"] - messages[0]["t"] if len(messages) > 1 else 0
    summary = summarize_messages(messages)
    recorded_at = datetime.now(timezone.utc).isoformat()

    payload = {
        "meta": {
            "recorded_at": recorded_at,
            "port": port,
            "filter": filter_prefix or "none (all addresses)",
            "message_count": len(messages),
            "duration_seconds": round(duration, 4),
            "schema_version": "1.1",
            "hardware_present": summary["hardware_present"],
            "unique_address_count": summary["unique_address_count"],
            "streams": summary["streams"],
        },
        "messages": messages,
    }

    output_path.write_text(json.dumps(payload, indent=2))
    print_summary(payload["meta"], output_path)


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
        recordings_dir = Path(__file__).resolve().parent / "recordings"
        recordings_dir.mkdir(parents=True, exist_ok=True)
        output_path = recordings_dir / f"osc_recording_{ts}.json"
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
