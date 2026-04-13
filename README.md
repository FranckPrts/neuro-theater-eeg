# NeuroTheater

Tools for working with **XDF** recordings (for example from **LSL** / **Muse** setups), with a focus on inspection and **CSV export** for analysis elsewhere.

## Repository layout


| Path                                                 | Purpose                                                                                                                      |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `neuro-theater-eeg/`                                 | Installable Python package `**neurotheater`** (`pyproject.toml`, `neurotheater/`)                                            |
| `neuro-theater-eeg/examples/`                        | Runnable demos and a small CLI to turn XDF → CSV                                                                             |
| `neuro-theater-eeg/collectMuses.gfi`                 | Example **goofi-pipe** graph: multiple Muse **LSL** clients, mic, optional CSV / LSL out                                     |
| `neuro-theater-eeg/scripts/patch_muselsl_asyncio.sh` | Optional **muselsl** patch for **Python 3.10+** (Bleak / asyncio)                                                            |
| `neuro-theater-eeg/scripts/muse_stream_resilient.sh` | **Side note:** quick helper to run **muselsl stream** with retries, `nickname.json` lookup, and Conda activation (see below) |
| `neuro-theater-eeg/run_env_neurtheater.sh`           | Helper to `source` and activate a Conda env named `**NeuroTheater`** (adjust if you use another name)                        |


There is no separate `docs/` folder in this tree yet; acquisition notes (Muse, muselsl, goofi-pipe, LSL) are summarized below so you do not need a second markdown file for the same story.

---

## What is implemented (current progress)

- `**XdfExplorer**` (`neurotheater.xdf_explorer`): loads an XDF via **pyxdf**, lists streams, summarizes channels and shapes, and filters **Muse** streams by LSL name `"Muse"`.
- `**to_csv`**: exports selected streams to **wide** CSV (one row per raw sample; channel columns). With `**output="single"`** the table is **sparse** (one stream’s cells filled per row). With `**output="per_stream"`** each file is dense (numeric channel columns `0`, `1`, …). Optional filters: `**sources**` (LSL `source_id` or stream `name`) and `**types**` (e.g. `EEG`, `GYRO`, `ACC`, `PPG`).
- `**examples/xdf_explorer_demo.py**`: notebook-style cells for exploring a file and trying export options.
- `**examples/convert_xdf.py**`: minimal command-line entry point so someone can convert a recording without editing Python by hand.

Recording from hardware is **outside** this package: you use **LSL** (and tools like **goofi-pipe** / **muselsl**) to produce `.xdf`; this repo helps **after** you have that file.

---

## Requirements

- **Python 3.10+**
- **pyxdf** (declared in `neuro-theater-eeg/pyproject.toml`; pulls **numpy**). If you install **goofi-pipe** in the same environment, you must cap **pyxdf** (see [Conda environment + local goofi-pipe](#conda-goofi-env)).
- Optional **`pyplot`** extra: **pylsl** + **matplotlib** for live LSL examples (`examples/lsl_stream_picker.py`, `examples/Musefusioncube_live.py`) and optional LSL outlet listing in `scripts/muse_stream_resilient.sh` when **pylsl** is available.

---

## Install the package

From the machine that has the repo:

```bash
cd neuro-theater-eeg
python -m venv .venv
source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -e .
```

For the optional **`pyplot`** extra (see Requirements):

```bash
pip install -e ".[pyplot]"
```

Or install dependencies only:

```bash
cd neuro-theater-eeg
pip install -r requirements.txt
```

Installing with `pip install -e .` is recommended so `import neurotheater` works from any working directory. The `**examples/convert_xdf.py**` script also prepends the `neuro-theater-eeg` root to `sys.path`, so from that folder you can run `python examples/convert_xdf.py …` even before installing. `**examples/xdf_explorer_demo.py**` does the same for local runs.

---

<a id="conda-goofi-env"></a>

## Conda environment + local goofi-pipe (same environment)

Use this when you want **one Conda env** for both this repo and a **local editable** [goofi-pipe](https://github.com/dav0dea/goofi-pipe) checkout (graphs, `LSLClient`, etc.).

**Why pin `pyxdf`:** [goofi-pipe](https://github.com/dav0dea/goofi-pipe) depends on **`numpy<2`**. Recent **pyxdf** releases (**1.17.0+**) declare **`numpy>=2.0.2`**, so `pip` will either warn or upgrade NumPy and break goofi (and packages like **biotuner**). Installing **`pyxdf>=1.16.0,<1.17`** keeps a **NumPy 1.x** stack compatible with goofi while still satisfying this package’s `pyxdf>=1.16.0` requirement.

Default Conda env name in `**run_env_neurtheater.sh**` is **`neurotheater`**. Override with `**NTA_CONDA_ENV=…**` if you use another name.

### Steps

1. **Activate the environment** (must be sourced, not executed as `./…`):

   ```bash
   source /path/to/neuro-theater-eeg/run_env_neurtheater.sh
   ```

2. **(Optional) Reset a broken env** — only if NumPy 2 / wrong pyxdf was already installed:

   ```bash
   pip uninstall -y pyxdf numpy goofi biotuner 2>/dev/null || true
   pip install "numpy>=1.26,<2"
   ```

3. **Install goofi-pipe (editable):**

   ```bash
   export GOOFI=/path/to/goofi-pipe
   pip install -e "$GOOFI"
   ```

4. **Pin pyxdf to the 1.16 line** (before or after neuro-theater-eeg; re-run after `pip install -e .` if pip upgrades pyxdf):

   ```bash
   pip install "pyxdf>=1.16.0,<1.17"
   ```

5. **Install this repo (editable):**

   ```bash
   export NTEEG=/path/to/neuro-theater-eeg
   pip install -e "$NTEEG"
   ```

   If a dependency step bumps NumPy or pyxdf again, re-apply:

   ```bash
   pip install "numpy>=1.26,<2" "pyxdf>=1.16.0,<1.17"
   ```

6. **Verify:**

   ```bash
   python -c "import numpy; print('numpy', numpy.__version__)"
   pip show pyxdf numpy | grep -E '^Name:|^Version:'
   python -c "import goofi; import pyxdf; import neurotheater; print('imports ok')"
   ```

   You want **NumPy 1.26.x** (or any **1.x**), **pyxdf 1.16.x**, and successful imports.

7. **(Optional)** Freeze for reproducibility:

   ```bash
   pip freeze > neurotheater-goofi-lock.txt
   ```

**Rule of thumb:** install **goofi-pipe** first → **cap `pyxdf<1.17`** → **`pip install -e` neuro-theater-eeg** → if anything upgrades NumPy or pyxdf, run step 4 (or the re-apply line in step 5) again.

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

1. **muselsl** (or another LSL source) publishes streams; Muse streams often use the LSL name `**Muse`** and distinct `**source_id**` values per headset.
2. We are **attempting to use goofi-pipe**. `**collectMuses.gfi`** is an example graph in that direction (`**LSLClient**` nodes, mic, optional `**WriteCsv**` / `**LSLOut**`). **The version of this tooling you use today reads XDF files on disk**; the recordings we have been working with were **captured with [Lab Recorder](https://github.com/labstreaminglayer/App-LabRecorder)**, which is **an application that records LSL streams** into XDF.
3. After recording, use `**XdfExplorer`** / `**convert_xdf.py**` here to produce CSV for spreadsheets, R, or other tools.

If you use **muselsl** on **Python 3.10+** and hit asyncio / Bleak issues, see `**neuro-theater-eeg/scripts/patch_muselsl_asyncio.sh`** (re-run after upgrading muselsl in that environment).

To activate a Conda environment consistently, `**source neuro-theater-eeg/run_env_neurtheater.sh**` (must be sourced, not executed as a normal subprocess, so the activation sticks). Override the env name with `NTA_CONDA_ENV` if needed.

`**scripts/muse_stream_resilient.sh**` is a small, **unofficial** convenience on top of that stack: it sources `**run_env_neurtheater.sh`**, resolves a headset **MAC** from `**nickname.json`** (by nickname or `hardware_sticker`, or you pass the full UUID), runs `**muselsl stream**` with default `**--ppg --acc --gyro**` (override tail after `--`), and restarts when the process exits or logs a disconnect. Flags `**-n` / `--max-retries**` and `**-i` / `--interval**` cap backoff behavior. After `**muselsl**` starts, it prints discovered **LSL** outlets to **stderr** (lines prefixed `**[muse_stream_resilient][lsl]`**): stream `**name**`, `**type**` (EEG / ACC / GYRO / PPG / …), `**source_id**` (maps to Goofi `**source_name**`), channel count, and rate. That needs `**pylsl**` and a working `**liblsl**` in the same environment; if `**pylsl**` is missing, listing is skipped with a one-line message. Set `**NTA_LSL_DISCOVER=0**` to disable listing (e.g. automation). Optional naming toggle: `**--name-with-type**` (or `**NTA_MUSE_NAME_WITH_TYPE=1**`) patches the launch so outlets are published as names like `**Muse_EEG**`, `**Muse_GYRO**`, `**Muse_ACC**`; this helps Goofi flows that only match `**source_name` + `stream_name**`, but it intentionally breaks compatibility with tools that expect stream name exactly `**Muse**`. For a manual second terminal without coupling to this script, run `**examples/lsl_stream_picker.py**`. Treat the script as a **quick-and-dirty** way to keep a stream up while you **experiment with geoscope data** and related LSL paths—not a supported product surface of this package. Run `**bash scripts/muse_stream_resilient.sh --help`** from `**neuro-theater-eeg**` for usage.

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

@author: @franckPrts