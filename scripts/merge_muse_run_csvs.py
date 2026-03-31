#!/usr/bin/env python3
"""
Merge paired Muse recording CSVs (aux + EEG) for a single run index.

Aux files contain GYRO, ACC, PPG as stringified nested lists shaped [3][N] (3 axes ×
N samples per row). This script collapses each axis to one scalar per row using
``last`` or ``mean`` over the sample window.

PPG channel mapping (assumed LSL / Goofi order; adjust code if your stream differs):
  inner list index 0 → PPG_AMB, 1 → PPG_IR, 2 → PPG_GRN

EEG ``agg-*`` columns are stringified one-element lists; they are unpacked to floats.

The ``alpha`` column is the PowerBandEEG **alpha-band (7–12 Hz)** power vector from
Goofi, one value per EEG site. It is split into ``alpha_<site>`` columns in this
order: TP9, AFT, AF8, TP10, Right Aux. Shorter lists leave trailing sites as NaN;
extra values are ignored.

Timestamps are parsed as UTC, rounded to the nearest 0.1 ms (100 µs), deduplicated
per stream, then merged with an outer join so non-overlapping ranges show NaNs.

Example:
  python scripts/merge_muse_run_csvs.py --run 1 --input-dir examples/out
"""

from __future__ import annotations

import argparse
import ast
import sys
from pathlib import Path
from typing import Any, Literal

import pandas as pd

WindowReduce = Literal["last", "mean"]

# Order of values in the ``alpha`` CSV cell (PowerBandEEG alpha outlet → ExtendedTable).
ALPHA_ELECTRODE_LABELS = ("TP9", "AFT", "AF8", "TP10", "Right Aux")


def _alpha_electrode_column_names() -> tuple[str, ...]:
    return tuple(
        "alpha_" + label.replace(" ", "_") for label in ALPHA_ELECTRODE_LABELS
    )


ALPHA_ELECTRODE_COLS = _alpha_electrode_column_names()

OUT_COLS = [
    "timestamp",
    *ALPHA_ELECTRODE_COLS,
    "agg-alpha-sum",
    "agg-alpha-norm",
    "agg-alpha-std",
    "GYRO_X",
    "GYRO_Y",
    "GYRO_Z",
    "ACC_X",
    "ACC_Y",
    "ACC_Z",
    "PPG_AMB",
    "PPG_IR",
    "PPG_GRN",
]


def _snap_to_100us(series: pd.Series) -> pd.Series:
    """Round UTC datetimes to nearest 100 microseconds (0.1 ms)."""
    dt = pd.to_datetime(series, utc=True)
    ns = dt.astype("int64")
    rounded = ((ns + 50_000) // 100_000) * 100_000
    return pd.to_datetime(rounded, utc=True, unit="ns")


def _reduce_axis(vals: list[float], how: WindowReduce) -> float:
    if not vals:
        raise ValueError("empty axis")
    if how == "last":
        return float(vals[-1])
    return float(sum(vals) / len(vals))


def _unpack_3x_window(
    cell: Any, how: WindowReduce
) -> tuple[float, float, float] | None:
    """
    Parse [[axis0 samples], [axis1 samples], [axis2 samples]].
    Returns (x, y, z) or None if invalid.
    """
    if cell is None or (isinstance(cell, float) and pd.isna(cell)):
        return None
    if isinstance(cell, str):
        s = cell.strip()
        if not s:
            return None
        try:
            data = ast.literal_eval(s)
        except (SyntaxError, ValueError, MemoryError):
            return None
    elif isinstance(cell, (list, tuple)):
        data = cell
    else:
        return None
    if not isinstance(data, (list, tuple)) or len(data) != 3:
        return None
    out: list[float] = []
    for axis in data:
        if not isinstance(axis, (list, tuple)) or len(axis) < 1:
            return None
        try:
            nums = [float(x) for x in axis]
        except (TypeError, ValueError):
            return None
        try:
            out.append(_reduce_axis(nums, how))
        except ValueError:
            return None
    return out[0], out[1], out[2]


def _unpack_alpha_electrodes(cell: Any) -> dict[str, float]:
    """
    Parse the ``alpha`` CSV cell (list of per-electrode alpha-band powers).
    Values are assigned in ``ALPHA_ELECTRODE_LABELS`` order.
    """
    empty = {name: float("nan") for name in ALPHA_ELECTRODE_COLS}
    if cell is None or (isinstance(cell, float) and pd.isna(cell)):
        return empty.copy()
    s = str(cell).strip()
    if not s:
        return empty.copy()
    try:
        data = ast.literal_eval(s)
    except (SyntaxError, ValueError, MemoryError):
        return empty.copy()
    if not isinstance(data, (list, tuple)):
        return empty.copy()
    out = empty.copy()
    names = list(ALPHA_ELECTRODE_COLS)
    for i, col in enumerate(names):
        if i >= len(data):
            break
        try:
            out[col] = float(data[i])
        except (TypeError, ValueError):
            out[col] = float("nan")
    return out


def _agg_scalar(cell: Any) -> float:
    if cell is None or (isinstance(cell, float) and pd.isna(cell)):
        return float("nan")
    s = str(cell).strip()
    if not s:
        return float("nan")
    try:
        data = ast.literal_eval(s)
    except (SyntaxError, ValueError, MemoryError):
        try:
            return float(s)
        except ValueError:
            return float("nan")
    if isinstance(data, (list, tuple)) and len(data) >= 1:
        try:
            return float(data[0])
        except (TypeError, ValueError):
            return float("nan")
    if isinstance(data, (int, float)):
        return float(data)
    return float("nan")


def load_aux_csv(path: Path, *, window_reduce: WindowReduce) -> pd.DataFrame:
    df = pd.read_csv(path, header=0)
    rows: list[dict[str, Any]] = []
    bad = 0
    for _, row in df.iterrows():
        g = _unpack_3x_window(row.get("GYRO"), window_reduce)
        a = _unpack_3x_window(row.get("ACC"), window_reduce)
        p = _unpack_3x_window(row.get("PPG"), window_reduce)
        if g is None or a is None or p is None:
            bad += 1
            continue
        rows.append(
            {
                "timestamp": row.get("timestamp"),
                "GYRO_X": g[0],
                "GYRO_Y": g[1],
                "GYRO_Z": g[2],
                "ACC_X": a[0],
                "ACC_Y": a[1],
                "ACC_Z": a[2],
                "PPG_AMB": p[0],
                "PPG_IR": p[1],
                "PPG_GRN": p[2],
            }
        )
    if bad:
        print(f"  [aux] skipped {bad} row(s) with invalid GYRO/ACC/PPG cells", file=sys.stderr)
    out = pd.DataFrame(rows)
    if out.empty:
        return out
    out["timestamp"] = _snap_to_100us(out["timestamp"])
    out = out.groupby("timestamp", as_index=False).last()
    return out


def load_eeg_csv(path: Path) -> pd.DataFrame:
    df = pd.read_csv(path, header=0)
    band_rows = [_unpack_alpha_electrodes(x) for x in df["alpha"]]
    out = pd.DataFrame(band_rows)
    out["timestamp"] = df["timestamp"].values
    out["agg-alpha-sum"] = [_agg_scalar(x) for x in df["agg-alpha-sum"]]
    out["agg-alpha-norm"] = [_agg_scalar(x) for x in df["agg-alpha-norm"]]
    out["agg-alpha-std"] = [_agg_scalar(x) for x in df["agg-alpha-std"]]
    cols = ["timestamp", *ALPHA_ELECTRODE_COLS, "agg-alpha-sum", "agg-alpha-norm", "agg-alpha-std"]
    out = out[cols]
    out["timestamp"] = _snap_to_100us(out["timestamp"])
    out = out.groupby("timestamp", as_index=False).last()
    return out


def merge_aux_eeg(aux: pd.DataFrame, eeg: pd.DataFrame) -> pd.DataFrame:
    merged = pd.merge(aux, eeg, on="timestamp", how="outer", sort=False)
    merged = merged.sort_values("timestamp").reset_index(drop=True)
    for c in OUT_COLS:
        if c not in merged.columns:
            merged[c] = pd.NA
    return merged[OUT_COLS]


def _format_timestamp_csv(series: pd.Series) -> pd.Series:
    """ISO-8601 UTC with microsecond field (values lie on 100 µs grid)."""
    dt = pd.to_datetime(series, utc=True)
    # %f is zero-padded 6 digits; snapped times use steps of 100_000 ns = 0.1 ms
    return dt.dt.strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def resolve_run_paths(
    run: int,
    input_dir: Path,
    aux_override: Path | None,
    eeg_override: Path | None,
) -> tuple[Path, Path]:
    if aux_override is not None:
        aux_path = aux_override
    else:
        matches = sorted(input_dir.glob(f"run_{run}_aux_*.csv"))
        if len(matches) == 0:
            raise FileNotFoundError(
                f"No aux CSV under {input_dir} matching run_{run}_aux_*.csv"
            )
        if len(matches) > 1:
            raise FileNotFoundError(
                f"Multiple aux CSVs for run {run}; use --aux to pick one:\n"
                + "\n".join(f"  {m}" for m in matches)
            )
        aux_path = matches[0]

    if eeg_override is not None:
        eeg_path = eeg_override
    else:
        matches = sorted(input_dir.glob(f"run_{run}_eeg_*.csv"))
        if len(matches) == 0:
            raise FileNotFoundError(
                f"No eeg CSV under {input_dir} matching run_{run}_eeg_*.csv"
            )
        if len(matches) > 1:
            raise FileNotFoundError(
                f"Multiple eeg CSVs for run {run}; use --eeg to pick one:\n"
                + "\n".join(f"  {m}" for m in matches)
            )
        eeg_path = matches[0]

    return aux_path, eeg_path


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Merge Muse run_N_aux_*.csv and run_N_eeg_*.csv into one wide CSV."
    )
    parser.add_argument("--run", type=int, required=True, help="Run index N in filenames")
    parser.add_argument(
        "--input-dir",
        type=Path,
        default=Path("examples/out"),
        help="Directory containing run_N_aux_*.csv and run_N_eeg_*.csv",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=None,
        help="Output CSV path (default: <input-dir>/run_N_merged.csv)",
    )
    parser.add_argument("--aux", type=Path, default=None, help="Explicit aux CSV path")
    parser.add_argument("--eeg", type=Path, default=None, help="Explicit eeg CSV path")
    parser.add_argument(
        "--window-reduce",
        choices=("last", "mean"),
        default="last",
        help="How to collapse each axis sample window (default: last)",
    )
    args = parser.parse_args()
    input_dir = args.input_dir.resolve()
    if not input_dir.is_dir():
        print(f"Not a directory: {input_dir}", file=sys.stderr)
        return 1

    out_path = args.output
    if out_path is None:
        out_path = input_dir / f"run_{args.run}_merged.csv"
    else:
        out_path = out_path.resolve()

    try:
        aux_path, eeg_path = resolve_run_paths(
            args.run, input_dir, args.aux, args.eeg
        )
    except FileNotFoundError as e:
        print(e, file=sys.stderr)
        return 1

    wr: WindowReduce = "mean" if args.window_reduce == "mean" else "last"

    print(f"Aux: {aux_path}")
    print(f"EEG: {eeg_path}")

    aux_df = load_aux_csv(aux_path, window_reduce=wr)
    eeg_df = load_eeg_csv(eeg_path)
    merged = merge_aux_eeg(aux_df, eeg_df)
    merged = merged.copy()
    merged["timestamp"] = _format_timestamp_csv(merged["timestamp"])

    out_path.parent.mkdir(parents=True, exist_ok=True)
    merged.to_csv(out_path, index=False)
    print(f"Wrote {len(merged)} rows → {out_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
