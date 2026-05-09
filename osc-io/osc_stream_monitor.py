"""
osc_stream_monitor.py
---------------------
Live UDP OSC observer: packet rates, address histograms, optional per-message trace.

Use this to verify **proxied show data** (default proxy out **8000**) separately from
**status** traffic (**8888**, ``/nt/proxy/stream/.../status``). The TouchDesigner failover
patch expects status on **8888**, not 8000.

**Local TouchDesigner + subnet broadcast:** if ``osc_proxy_failover.py`` uses
``--out-host 192.168.x.255``, many systems do **not** deliver those datagrams back to
listeners on the same host. For TD on the proxy machine, set::

    --status-host 127.0.0.1

(or your machine's LAN IP) while keeping ``--out-host`` for the show.

Dependencies:
    pip install python-osc

Examples::

    python osc_stream_monitor.py --port 8000
    python osc_stream_monitor.py --port 8888 --status-only
    python osc_stream_monitor.py --ports 8000,8888
"""

from __future__ import annotations

import argparse
import signal
import sys
import threading
import time
from collections import Counter

from pythonosc import dispatcher, osc_server

_stop = threading.Event()


def _request_stop(*_args):
    _stop.set()
    print("\n■ Stop — summarizing and exit.", file=sys.stderr)


signal.signal(signal.SIGINT, _request_stop)
signal.signal(signal.SIGTERM, _request_stop)


class PortStats:
    def __init__(self, label: str):
        self.label = label
        self.lock = threading.Lock()
        self.total = 0
        self.by_address: Counter[str] = Counter()
        self.last_print = time.perf_counter()
        self.window_count = 0

    def record(self, address: str):
        with self.lock:
            self.total += 1
            self.window_count += 1
            self.by_address[address] += 1

    def drain_window(self) -> tuple[int, float]:
        with self.lock:
            n = self.window_count
            self.window_count = 0
            now = time.perf_counter()
            dt = max(1e-9, now - self.last_print)
            self.last_print = now
            return n, dt

    def top_addresses(self, k: int) -> list[tuple[str, int]]:
        with self.lock:
            return self.by_address.most_common(k)


def _make_handler(stats: PortStats, verbose: bool, status_only: bool):
    def _handler(address: str, *args):
        if status_only and not address.startswith("/nt/proxy/"):
            return
        stats.record(address)
        if verbose:
            prev = ", ".join(str(a) for a in args[:4])
            if len(args) > 4:
                prev += f" …(+{len(args) - 4})"
            print(f"  [{stats.label}] {address}  →  {prev}")

    return _handler


def _run_server(bind_host: str, port: int, stats: PortStats, verbose: bool, status_only: bool):
    d = dispatcher.Dispatcher()
    d.set_default_handler(_make_handler(stats, verbose, status_only))
    server = osc_server.ThreadingOSCUDPServer((bind_host, port), d)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, thread


def main():
    parser = argparse.ArgumentParser(
        description="Monitor OSC packet rate and addresses on one or more UDP ports.",
    )
    parser.add_argument("--bind", type=str, default="0.0.0.0", help="Listen address (default 0.0.0.0)")
    g = parser.add_mutually_exclusive_group()
    g.add_argument("--port", type=int, default=None, help="Single UDP port (default: 8000 if --ports omitted)")
    g.add_argument("--ports", type=str, default=None, help="Comma-separated UDP ports, e.g. 8000,8888")
    parser.add_argument(
        "--interval",
        type=float,
        default=2.0,
        help="Seconds between summary lines (default: 2)",
    )
    parser.add_argument("--top", type=int, default=8, help="How many addresses to show per port (default: 8)")
    parser.add_argument("-v", "--verbose", action="store_true", help="Print every message (noisy)")
    parser.add_argument(
        "--status-only",
        action="store_true",
        help="On each port, only count /nt/proxy/* (useful if something else also sends to 8888)",
    )
    args = parser.parse_args()

    if args.ports:
        ports = []
        for tok in args.ports.split(","):
            tok = tok.strip()
            if not tok:
                continue
            ports.append(int(tok, 10))
        if not ports:
            print("✗ No valid ports in --ports", file=sys.stderr)
            sys.exit(1)
    elif args.port is not None:
        ports = [args.port]
    else:
        ports = [8000]

    stats_map: dict[int, PortStats] = {p: PortStats(str(p)) for p in ports}
    servers: list[osc_server.ThreadingOSCUDPServer] = []

    for port in ports:
        try:
            srv, _th = _run_server(args.bind, port, stats_map[port], args.verbose, args.status_only)
            servers.append(srv)
        except OSError as exc:
            print(f"✗ Cannot bind {args.bind}:{port} — {exc}", file=sys.stderr)
            print("  Another process (TouchDesigner, second proxy, etc.) may already use this port.", file=sys.stderr)
            for s in servers:
                s.shutdown()
            sys.exit(1)

    print(f"● Listening  {args.bind}  ports={','.join(str(p) for p in ports)}  summary every {args.interval}s")
    print("  Ctrl+C to stop.\n")

    try:
        while not _stop.is_set():
            time.sleep(max(0.2, args.interval))
            if _stop.is_set():
                break
            parts: list[str] = []
            for port in ports:
                st = stats_map[port]
                n, dt = st.drain_window()
                hz = n / dt
                top = st.top_addresses(args.top)
                top_s = ", ".join(f"{a}×{c}" for a, c in top) if top else "(none)"
                parts.append(f"[{port}] {n} pkt / {dt:.2f}s ≈ {hz:.1f} Hz  total={st.total}  top: {top_s}")
            print("  " + "   |   ".join(parts))
    finally:
        for s in servers:
            try:
                s.shutdown()
            except Exception:
                pass
            try:
                s.server_close()
            except Exception:
                pass


if __name__ == "__main__":
    main()
