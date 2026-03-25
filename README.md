# NeuroTheater

Tools for working with **XDF** recordings (for example from **LSL** / **Muse** setups), with a focus on inspection and **CSV export** for analysis elsewhere.

## Repository layout

| Path | Purpose |
|------|---------|
| `neuro-theater-eeg/` | Installable Python package **`neurotheater`** (`pyproject.toml`, `neurotheater/`) |
| `neuro-theater-eeg/examples/` | Runnable demos and a small CLI to turn XDF → CSV |
| `neuro-theater-eeg/collectMuses.gfi` | Example **goofi-pipe** graph: multiple Muse **LSL** clients, mic, optional CSV / LSL out |
| `neuro-theater-eeg/scripts/patch_muselsl_asyncio.sh` | Optional **muselsl** patch for **Python 3.10+** (Bleak / asyncio) |
| `neuro-theater-eeg/run_env_neurtheater.sh` | Helper to `source` and activate a Conda env named **`NeuroTheater`** (adjust if you use another name) |

There is no separate `docs/` folder in this tree yet; acquisition notes (Muse, muselsl, goofi-pipe, LSL) are summarized below so you do not need a second markdown file for the same story.

---

## What is implemented (current progress)

- **`XdfExplorer`** (`neurotheater.xdf_explorer`): loads an XDF via **pyxdf**, lists streams, summarizes channels and shapes, and filters **Muse** streams by LSL name `"Muse"`.
- **`to_csv`**: exports selected streams to **wide** CSV (one row per raw sample; channel columns). With **`output="single"`** the table is **sparse** (one stream’s cells filled per row). With **`output="per_stream"`** each file is dense (numeric channel columns `0`, `1`, …). Optional filters: **`sources`** (LSL `source_id` or stream `name`) and **`types`** (e.g. `EEG`, `GYRO`, `ACC`, `PPG`).
- **`examples/xdf_explorer_demo.py`**: notebook-style cells for exploring a file and trying export options.
- **`examples/convert_xdf.py`**: minimal command-line entry point so someone can convert a recording without editing Python by hand.

Recording from hardware is **outside** this package: you use **LSL** (and tools like **goofi-pipe** / **muselsl**) to produce `.xdf`; this repo helps **after** you have that file.

---

## Requirements

- **Python 3.10+**
- **pyxdf** (declared in `neuro-theater-eeg/pyproject.toml`; pulls **numpy**)

---

## Install the package

From the machine that has the repo:

```bash
cd neuro-theater-eeg
python -m venv .venv
source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -e .
```

Or install dependencies only:

```bash
cd neuro-theater-eeg
pip install -r requirements.txt
```

Installing with `pip install -e .` is recommended so `import neurotheater` works from any working directory. The **`examples/convert_xdf.py`** script also prepends the `neuro-theater-eeg` root to `sys.path`, so from that folder you can run `python examples/convert_xdf.py …` even before installing. **`examples/xdf_explorer_demo.py`** does the same for local runs.

---

## Get started: XDF → CSV

### Option A — One command (good for a file you receive separately)

Put your `.xdf` anywhere, then from `neuro-theater-eeg` with the env active:

```bash
python examples/convert_xdf.py /path/to/recording.xdf -o ./csv_out
```

Defaults write **one CSV per stream** (`per_stream`). Useful flags:

- `--types EEG GYRO` — only those LSL stream types.
- `--single combined.csv` — one sparse wide file instead of per-stream files.

Run `python examples/convert_xdf.py --help` for the full list.

### Option B — Tiny script you paste and execute

Use this pattern after `pip install -e .`:

```python
from pathlib import Path
from neurotheater import XdfExplorer

XDF_PATH = Path("/path/to/your_recording.xdf")
OUT = Path("csv_out") / "export.csv"
OUT.parent.mkdir(parents=True, exist_ok=True)

xdf = XdfExplorer(XDF_PATH)
xdf.to_csv(OUT, output="per_stream")
print("Wrote:", OUT.parent.resolve())
```

Adjust `to_csv(...)` using the same options as in `examples/xdf_explorer_demo.py` (comments in that file list common combinations).

### Option C — Interactive exploration

Open `neuro-theater-eeg/examples/xdf_explorer_demo.py`, set `XDF_PATH`, then run cells or the whole file to print stream summaries and experiment with `to_csv()`.

---

## Acquisition reference (Muse, muselsl, goofi-pipe, LSL)

This package does **not** stream from the Muse by itself. A typical path is:

1. **muselsl** (or another LSL source) publishes streams; Muse streams often use the LSL name **`Muse`** and distinct **`source_id`** values per headset.
2. We are **attempting to use goofi-pipe**. **`collectMuses.gfi`** is an example graph in that direction (**`LSLClient`** nodes, mic, optional **`WriteCsv`** / **`LSLOut`**). **The version of this tooling you use today reads XDF files on disk**; the recordings we have been working with were **captured with [Lab Recorder](https://github.com/labstreaminglayer/App-LabRecorder)**, which is **an application that records LSL streams** into XDF.
3. After recording, use **`XdfExplorer`** / **`convert_xdf.py`** here to produce CSV for spreadsheets, R, or other tools.

If you use **muselsl** on **Python 3.10+** and hit asyncio / Bleak issues, see **`neuro-theater-eeg/scripts/patch_muselsl_asyncio.sh`** (re-run after upgrading muselsl in that environment).

To activate a Conda environment consistently, **`source neuro-theater-eeg/run_env_neurtheater.sh`** (must be sourced, not executed as a normal subprocess, so the activation sticks). Override the env name with `NTA_CONDA_ENV` if needed.

---

## Package surface

```python
from neurotheater import XdfExplorer

xdf = XdfExplorer("recording.xdf")
len(xdf)                    # number of streams
xdf.stream_summary()        # list of dicts: name, type, source_id, channel_count, series_shape
xdf.muse_streams()          # streams whose LSL name is exactly "Muse"
xdf.to_csv("out.csv", ...)  # see docstring on XdfExplorer.to_csv
```

---

## Version

Package version **0.1.0** (see `neuro-theater-eeg/pyproject.toml`).
