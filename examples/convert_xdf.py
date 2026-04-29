#!/usr/bin/env python3
# @author: @franckPrts
"""Convert an XDF recording to CSV (minimal CLI for collaborators).

Usage (from neuro-theater-eeg)::

    python examples/convert_xdf.py recording.xdf -o ./csv_out
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[1]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Export streams from an XDF file to CSV via exploration.XdfExplorer."
    )
    parser.add_argument(
        "xdf",
        type=Path,
        help="Path to the .xdf file",
    )
    parser.add_argument(
        "-o",
        "--output",
        type=Path,
        required=True,
        help="Output path: directory for per_stream, or .csv file for --single",
    )
    parser.add_argument(
        "--single",
        action="store_true",
        help="Write one combined wide CSV (--output must be a file path)",
    )
    parser.add_argument(
        "--types",
        nargs="*",
        metavar="TYPE",
        help="LSL stream types to include, e.g. EEG ACC (default: all)",
    )
    parser.add_argument(
        "--sources",
        nargs="*",
        metavar="ID",
        help="Filter by LSL source_id or stream name (default: all)",
    )
    args = parser.parse_args(argv)

    examples_root = _repo_root() / "examples"
    if str(examples_root) not in sys.path:
        sys.path.insert(0, str(examples_root))

    try:
        from exploration import XdfExplorer
    except ImportError as e:
        print(
            "Could not import exploration. Run this script from the repo root "
            "(neuro-theater-eeg) so examples/ is on disk.\n"
            f"Import error: {e}",
            file=sys.stderr,
        )
        return 1

    xdf_path = args.xdf.expanduser().resolve()
    if not xdf_path.is_file():
        print(f"Not a file: {xdf_path}", file=sys.stderr)
        return 1

    if args.single:
        out = args.output.expanduser()
        out.parent.mkdir(parents=True, exist_ok=True)
        base_csv = out
    else:
        out_dir = args.output.expanduser().resolve()
        out_dir.mkdir(parents=True, exist_ok=True)
        base_csv = out_dir / f"{xdf_path.stem}.csv"

    types = args.types if args.types else None
    sources = args.sources if args.sources else None
    output_mode = "single" if args.single else "per_stream"

    xdf = XdfExplorer(xdf_path)
    result = xdf.to_csv(
        base_csv,
        sources=sources,
        types=types,
        output=output_mode,
    )

    if output_mode == "single":
        print(result)
    else:
        for p in result:
            print(p)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
