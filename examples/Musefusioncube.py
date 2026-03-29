# %%
"""
Muse 2 IMU Sensor Fusion → 3D Cube Visualization
--------------------------------------------------
Usage:
    pip install pandas numpy plotly
    python muse_fusion_cube.py

Expects Muse XDF-export CSVs with columns:
  timestamp, stream_index, source_id, stream_name, stream_type, x, y, z

File names (edit below if yours differ):
  ACCEL_CSV : run__1__ACC__Muse....csv
  GYRO_CSV  : run__4__GYRO__Muse....csv
"""

import json
import math
from pathlib import Path

import numpy as np
import pandas as pd
import plotly.graph_objects as go

_NICKNAME_JSON = Path(__file__).resolve().parents[1] / "nickname.json"

# ── CONFIG ────────────────────────────────────────────────────────────────────
ACCEL_CSV = "./out/run__14__ACC__Muse728F5034-C233-D39E-11A9-C94E82C91DD0.csv"
GYRO_CSV  = "./out/run__4__GYRO__Muse728F5034-C233-D39E-11A9-C94E82C91DD0.csv"
ALPHA     = 0.97          # complementary filter weight (0=accel only, 1=gyro only)
EVERY_N   = 5             # animate every Nth frame (increase to speed up)
# ─────────────────────────────────────────────────────────────────────────────


def load(path, prefix):
    """
    Load a Muse XDF-export CSV.
    Columns: timestamp, stream_index, source_id, stream_name, stream_type, x, y, z
    The last three numeric columns become {prefix}_x/y/z; timestamp → t.
    """
    df = pd.read_csv(path, header=0)
    # Normalise header names
    df.columns = [c.strip().lower() for c in df.columns]

    # The fixed metadata columns; everything after is x, y, z
    META = ["timestamp", "stream_index", "source_id", "stream_name", "stream_type"]
    value_cols = [c for c in df.columns if c not in META]
    if len(value_cols) < 3:
        raise ValueError(f"Expected ≥3 value columns in {path}, found: {value_cols}")

    out = pd.DataFrame({
        "t":              pd.to_numeric(df["timestamp"], errors="coerce"),
        f"{prefix}_x":   pd.to_numeric(df[value_cols[0]], errors="coerce"),
        f"{prefix}_y":   pd.to_numeric(df[value_cols[1]], errors="coerce"),
        f"{prefix}_z":   pd.to_numeric(df[value_cols[2]], errors="coerce"),
    })
    return out.dropna().reset_index(drop=True)


def peek_source_id(csv_path: str) -> str | None:
    """First ``source_id`` from a Muse export CSV, if present."""
    p = Path(csv_path)
    if not p.is_file():
        return None
    df = pd.read_csv(p, header=0, nrows=1)
    df.columns = [c.strip().lower() for c in df.columns]
    if "source_id" not in df.columns:
        return None
    raw = df["source_id"].iloc[0]
    if pd.isna(raw):
        return None
    s = str(raw).strip()
    return s or None


def _headset_label_map() -> dict[str, tuple[str, str]]:
    if not _NICKNAME_JSON.is_file():
        return {}
    try:
        data = json.loads(_NICKNAME_JSON.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError, UnicodeError):
        return {}
    out: dict[str, tuple[str, str]] = {}
    for row in data.get("headsets") or []:
        if not isinstance(row, dict):
            continue
        sid = str(row.get("source_id") or "").strip()
        nick = str(row.get("nickname") or "").strip()
        hw = str(row.get("hardware_sticker") or "").strip()
        if not sid or (not nick and not hw):
            continue
        out[sid] = (nick, hw)
    return out


def _cube_title(
    source_id: str, labels: dict[str, tuple[str, str]], *, max_len: int = 48
) -> str:
    sid = source_id.strip()
    pair = labels.get(sid)
    if not pair:
        return sid if len(sid) <= max_len else sid[: max_len - 1] + "…"
    nick, hw = pair
    if nick and hw:
        text = f"{nick} · {hw}"
    elif nick:
        text = nick
    elif hw:
        text = hw
    else:
        return sid if len(sid) <= max_len else sid[: max_len - 1] + "…"
    return text if len(text) <= max_len else text[: max_len - 1] + "…"


def complementary_filter(acc, gyro):
    """Returns (roll, pitch) arrays in degrees."""
    # Align on shared timestamps via nearest-neighbour merge
    df = pd.merge_asof(
        gyro.sort_values("t"), acc.sort_values("t"),
        on="t", direction="nearest"
    ).dropna().reset_index(drop=True)

    rolls, pitches = [], []
    roll = pitch = 0.0

    for i, row in df.iterrows():
        dt = (df.at[i, "t"] - df.at[i - 1, "t"]) if i > 0 else 1 / 52

        # Gyro integration
        roll  += row["gyro_x"] * dt
        pitch += row["gyro_y"] * dt

        # Accel tilt
        ax, ay, az = row["acc_x"], row["acc_y"], row["acc_z"]
        a_roll  = math.atan2(ay, az) * 180 / math.pi
        a_pitch = math.atan2(-ax, math.sqrt(ay**2 + az**2)) * 180 / math.pi

        # Blend
        roll  = ALPHA * roll  + (1 - ALPHA) * a_roll
        pitch = ALPHA * pitch + (1 - ALPHA) * a_pitch

        rolls.append(roll)
        pitches.append(pitch)

    df["roll"]  = rolls
    df["pitch"] = pitches
    return df


def rotation_matrix(roll_deg, pitch_deg, yaw_deg=0):
    r, p, y = (math.radians(x) for x in (roll_deg, pitch_deg, yaw_deg))
    Rx = np.array([[1,0,0],[0,math.cos(r),-math.sin(r)],[0,math.sin(r),math.cos(r)]])
    Ry = np.array([[math.cos(p),0,math.sin(p)],[0,1,0],[-math.sin(p),0,math.cos(p)]])
    Rz = np.array([[math.cos(y),-math.sin(y),0],[math.sin(y),math.cos(y),0],[0,0,1]])
    return Rz @ Ry @ Rx


def make_cube_faces(R):
    """Returns x,y,z,i,j,k mesh arrays for a rotated unit cube."""
    verts = np.array([
        [-1,-1,-1],[ 1,-1,-1],[ 1, 1,-1],[-1, 1,-1],
        [-1,-1, 1],[ 1,-1, 1],[ 1, 1, 1],[-1, 1, 1],
    ], dtype=float).T * 0.5
    v = (R @ verts).T
    x, y, z = v[:,0], v[:,1], v[:,2]
    # Two triangles per face
    i = [0,0,4,4,0,0,3,3,1,1,2,2]
    j = [1,2,5,6,1,4,7,4,2,5,6,7]
    k = [2,3,6,7,4,5,4,3,5,6,7,3]
    return x, y, z, i, j, k


def animate(df, *, plot_title: str):
    frames, sliders_steps = [], []
    rows = df.iloc[::EVERY_N].reset_index(drop=True)

    for idx, row in rows.iterrows():
        R = rotation_matrix(row["roll"], row["pitch"])
        x, y, z, i, j, k = make_cube_faces(R)
        frames.append(go.Frame(
            data=[go.Mesh3d(x=x, y=y, z=z, i=i, j=j, k=k,
                            color="steelblue", opacity=0.8,
                            flatshading=True)],
            name=str(idx)
        ))
        sliders_steps.append({"args": [[str(idx)],
                               {"frame": {"duration": 30, "redraw": True},
                                "mode": "immediate"}],
                               "method": "animate",
                               "label": ""})

    R0 = rotation_matrix(rows.at[0,"roll"], rows.at[0,"pitch"])
    x0,y0,z0,i0,j0,k0 = make_cube_faces(R0)

    fig = go.Figure(
        data=[go.Mesh3d(x=x0,y=y0,z=z0,i=i0,j=j0,k=k0,
                        color="steelblue", opacity=0.8, flatshading=True)],
        frames=frames,
        layout=go.Layout(
            title=plot_title,
            scene=dict(
                xaxis=dict(range=[-1,1], showbackground=False),
                yaxis=dict(range=[-1,1], showbackground=False),
                zaxis=dict(range=[-1,1], showbackground=False),
                aspectmode="cube",
            ),
            updatemenus=[{
                "type": "buttons", "showactive": False,
                "y": 0, "x": 0.5, "xanchor": "center",
                "buttons": [
                    {"label": "▶ Play",
                     "method": "animate",
                     "args": [None, {"frame": {"duration": 30, "redraw": True},
                                     "fromcurrent": True}]},
                    {"label": "⏸ Pause",
                     "method": "animate",
                     "args": [[None], {"frame": {"duration": 0}, "mode": "immediate"}]},
                ],
            }],
            sliders=[{"steps": sliders_steps, "currentvalue": {"prefix": "frame: "}}],
        )
    )
    fig.show(renderer="browser")


if __name__ == "__main__":
    print("Loading CSVs…")
    acc = load(ACCEL_CSV, "acc")
    gyro = load(GYRO_CSV, "gyro")

    print(f"  Accel rows : {len(acc)}")
    print(f"  Gyro rows  : {len(gyro)}")

    sid = peek_source_id(ACCEL_CSV)
    labels = _headset_label_map()
    headset_line = (
        _cube_title(sid, labels) if sid else "source unknown (no source_id in accel CSV)"
    )
    plot_title = f"Muse — sensor-fused orientation — {headset_line}"

    print("Running complementary filter…")
    df = complementary_filter(acc, gyro)
    print(f"  Fused frames : {len(df)}  →  animating every {EVERY_N}th ({len(df)//EVERY_N} frames)")

    print("Opening Plotly window…")
    animate(df, plot_title=plot_title)
# %%
