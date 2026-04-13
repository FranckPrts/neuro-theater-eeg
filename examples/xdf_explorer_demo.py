# %% Imports
"""Explore an XDF recording cell-by-cell.

In VS Code / Cursor: use “Run Cell” / “Run Above” on each `# %%` section.
Or run the whole file: ``python examples/xdf_explorer_demo.py`` (from repo root).

The block below adds the repo root to ``sys.path`` so ``import neurotheater`` works
without ``pip install -e .`` (your kernel must still have dependencies, e.g. ``pyxdf``).
"""

# @author: @franckPrts

from pathlib import Path
import sys

_REPO_ROOT = Path(__file__).resolve().parents[1]
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from pprint import pprint

from neurotheater import XdfExplorer

# %% Path — set your recording, then run the next cell
XDF_PATH = "../sample_data/25032026-4muses.xdf"

# %% Load file
xdf = XdfExplorer(XDF_PATH)
print(f"File: {xdf.path.name}")
print(f"Streams found: {len(xdf)}")

# %% Stream summary (one line per stream)
for i, row in enumerate(xdf.stream_summary()):
    print(
        f"[{i}] {row['name']!r:20s}  type={row['type']!r:15s}  "
        f"src={row['source_id']!r:42s}  "
        f"ch={row['channel_count']:>3}  shape={row['series_shape']}"
    )

# %% CSV export

#  %% Single file (sparse wide): all streams share one header; each row is one
#  raw sample from one stream, so other streams' channel columns are empty.
xdf.to_csv("out/run_wide.csv")

#  %% One wide CSV per stream (dense within each file: channel columns 0, 1, …).
xdf.to_csv(
    "out/run.csv",
    types=["EEG", "GYRO", "PPG", "ACC"],
    output="per_stream",
)




# %% Muse streams (LSL name == "Muse")
muse = xdf.muse_streams()
print(f"{len(muse)} Muse stream(s)\n")
for stream in muse:
    pprint(dict(stream.get("info", {})), depth=2)

# %% One stream in detail — change STREAM_IDX, then run this cell
STREAM_IDX = 0
stream = xdf.streams[STREAM_IDX]
info = stream.get("info", {})
ts = stream.get("time_series")
t = stream.get("time_stamps")

print(f"Name        : {info.get('name')}")
print(f"Type        : {info.get('type')}")
print(f"Source ID   : {info.get('source_id')}")
print(f"Sample rate : {info.get('nominal_srate')} Hz")
print(f"Data shape  : {ts.shape if hasattr(ts, 'shape') else len(ts)}")
if t is not None and len(t) > 1:
    print(f"Duration    : {t[-1] - t[0]:.2f}s")

# %%
