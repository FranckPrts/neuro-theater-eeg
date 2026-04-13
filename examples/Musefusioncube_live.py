"""
Muse IMU (LSL) → complementary filter → live 3D cube (matplotlib)
-----------------------------------------------------------------
Discovers streams, groups them by LSL ``source_id`` (sorted keys), auto-picks
ACC + GYRO per headset (muselsl-style types), then shows one or two live
wireframe cubes. **Reset cube** zeros roll/pitch (upright in the plot). Each
column shows an **LSL connection** line (green while samples arrive, red if
stale) and **cumulative seconds lost** while that link is down (after the first
packet). **Sliders** adjust complementary **α** and **gyro scale** live. For
manual single-stream picking use ``lsl_stream_picker.py``.

Activate the project conda env (default name ``neurotheater``):

    source neuro-theater-eeg/run_env_neurtheater.sh

From ``neuro-theater-eeg/`` install deps:

    pip install -e ".[pyplot]"

Each headset must expose an ACC-like and GYRO-like stream with **≥3 channels**
(x, y, z). Only **1–2** Muses with a full IMU pair are supported; if more
headsets qualify, exit with an error (see ``MAX_MUSES``).

Config (edit below):
    WAIT_SEC                   — LSL discovery window (seconds)
    MAX_MUSES                  — max headsets with IMU pairs (plan: 2)
    ALPHA                      — complementary blend (same as offline)
    UPDATE_HZ                  — matplotlib redraw rate
    MAX_FUSION_STEPS_PER_FRAME — cap gyro steps per frame (CPU bound)
    DT_MIN, DT_MAX             — clamp for delta-time between gyro samples
    DUAL_FIGSIZE               — (width, height) inches when two cubes
    CONN_STALE_SEC             — no samples for this long ⇒ show disconnected
    GYRO_SCALE_DEFAULT         — initial gyro integration gain (slider default)
    SLIDER_GYRO_SCALE_MAX      — upper bound for gyro-scale slider
"""

# @author: @franckPrts

from __future__ import annotations

import json
import math
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

# Repo-root ``nickname.json`` (sibling of ``examples/``); read only when building titles.
_NICKNAME_JSON = Path(__file__).resolve().parents[1] / "nickname.json"

# ── CONFIG ────────────────────────────────────────────────────────────────────
WAIT_SEC = 5.0
MAX_MUSES = 2
ALPHA = 0.97
UPDATE_HZ = 30.0
MAX_FUSION_STEPS_PER_FRAME = 20
DT_MIN = 1e-4
DT_MAX = 0.1
DUAL_FIGSIZE = (12.0, 6.2)
SINGLE_FIGSIZE = (7.0, 7.0)
CONN_STALE_SEC = 0.75
GYRO_SCALE_DEFAULT = 1.0
SLIDER_GYRO_SCALE_MAX = 3.0
# muselsl / CSV pipeline may disagree on gyro units; tune if motion scale feels off
# ───────────────────────────────────────────────────────────────────────────────

_ACC_TYPES = frozenset({"ACC", "ACCELEROMETER"})
_GYRO_TYPES = frozenset({"GYRO", "GYROSCOPE"})


def _norm_stream_type(info) -> str:
    return info.type().strip().upper()


# Cube unit vertices (same ordering as Musefusioncube.py), scaled by 0.5
_BASE_VERTS = (
    np.array(
        [
            [-1, -1, -1],
            [1, -1, -1],
            [1, 1, -1],
            [-1, 1, -1],
            [-1, -1, 1],
            [1, -1, 1],
            [1, 1, 1],
            [-1, 1, 1],
        ],
        dtype=float,
    )
    * 0.5
)

_CUBE_EDGES = [
    (0, 1),
    (1, 2),
    (2, 3),
    (3, 0),
    (4, 5),
    (5, 6),
    (6, 7),
    (7, 4),
    (0, 4),
    (1, 5),
    (2, 6),
    (3, 7),
]

_TRACK_COLORS = ("steelblue", "darkorange")


def discover_streams(wait_sec: float):
    import pylsl

    return pylsl.resolve_streams(wait_time=wait_sec)


def group_streams_by_source_id(streams) -> dict[str, list]:
    """Group StreamInfo objects by ``source_id``; keys sorted alphabetically."""
    buckets: dict[str, list] = {}
    for s in streams:
        sid = s.source_id().strip() or "(unknown)"
        buckets.setdefault(sid, []).append(s)
    return dict(sorted(buckets.items()))


def find_imu_pair(infos: list) -> tuple | None:
    """First ACC + first GYRO stream with channel_count >= 3, or None."""
    acc = gyro = None
    for s in infos:
        if s.channel_count() < 3:
            continue
        t = _norm_stream_type(s)
        if t in _ACC_TYPES and acc is None:
            acc = s
        elif t in _GYRO_TYPES and gyro is None:
            gyro = s
    if acc is None or gyro is None:
        return None
    return (acc, gyro)


def describe_imu_gap(source_id: str, infos: list) -> str:
    has_acc = any(
        s.channel_count() >= 3 and _norm_stream_type(s) in _ACC_TYPES for s in infos
    )
    has_gyro = any(
        s.channel_count() >= 3 and _norm_stream_type(s) in _GYRO_TYPES for s in infos
    )
    if has_acc and has_gyro:
        return f"source_id={source_id!r}: IMU streams present but pairing failed (unexpected)."
    if not has_acc and not has_gyro:
        return (
            f"source_id={source_id!r}: no ACC/Accelerometer or GYRO/Gyroscope stream "
            f"with ≥3 channels."
        )
    if not has_acc:
        return f"source_id={source_id!r}: missing ACC (need type ACC or Accelerometer, ≥3 ch)."
    return f"source_id={source_id!r}: missing GYRO (need type GYRO or Gyroscope, ≥3 ch)."


def print_streams_grouped(groups: dict[str, list]) -> None:
    print("Streams by source_id (sorted):")
    for sid, infos in groups.items():
        print(f"  {sid!r}")
        for s in infos:
            print(
                f"    type={s.type()!r}  channels={s.channel_count()}  "
                f"rate={s.nominal_srate():.1f} Hz  name={s.name()!r}"
            )


def open_inlet_from_info(info):
    import pylsl

    if info.channel_count() < 3:
        raise ValueError(
            f"Stream type={info.type()!r} has {info.channel_count()} channels; need ≥3."
        )
    return pylsl.StreamInlet(info)


def rotation_matrix(roll_deg: float, pitch_deg: float, yaw_deg: float = 0.0) -> np.ndarray:
    r, p, y = (math.radians(x) for x in (roll_deg, pitch_deg, yaw_deg))
    Rx = np.array(
        [[1, 0, 0], [0, math.cos(r), -math.sin(r)], [0, math.sin(r), math.cos(r)]]
    )
    Ry = np.array(
        [[math.cos(p), 0, math.sin(p)], [0, 1, 0], [-math.sin(p), 0, math.cos(p)]]
    )
    Rz = np.array(
        [[math.cos(y), -math.sin(y), 0], [math.sin(y), math.cos(y), 0], [0, 0, 1]]
    )
    return Rz @ Ry @ Rx


def wireframe_segments(R: np.ndarray) -> list[np.ndarray]:
    v = (R @ _BASE_VERTS.T).T
    return [np.vstack([v[i], v[j]]) for i, j in _CUBE_EDGES]


class FusionState:
    __slots__ = (
        "roll",
        "pitch",
        "t_prev",
        "ax",
        "ay",
        "az",
        "have_acc",
        "last_data_wall",
        "ever_had_data",
        "lost_conn_sec_total",
    )

    def __init__(self) -> None:
        self.roll = 0.0
        self.pitch = 0.0
        self.t_prev: float | None = None
        self.ax = self.ay = self.az = 0.0
        self.have_acc = False
        self.last_data_wall: float | None = None
        self.ever_had_data = False
        self.lost_conn_sec_total = 0.0

    def reset_orientation(self) -> None:
        """Cube upright in plot frame; next gyro dt uses nominal step."""
        self.roll = 0.0
        self.pitch = 0.0
        self.t_prev = None

    def mark_data(self) -> None:
        self.last_data_wall = time.monotonic()
        self.ever_had_data = True


def drain_acc_latest(inlet_acc, st: FusionState) -> None:
    while True:
        sample, _ts = inlet_acc.pull_sample(timeout=0.0)
        if sample is None:
            break
        st.ax, st.ay, st.az = float(sample[0]), float(sample[1]), float(sample[2])
        st.have_acc = True
        st.mark_data()


def fuse_on_gyro_samples(
    inlet_gyro, st: FusionState, alpha: float, gyro_scale: float
) -> None:
    if not st.have_acc:
        return
    for _ in range(MAX_FUSION_STEPS_PER_FRAME):
        sample, ts = inlet_gyro.pull_sample(timeout=0.0)
        if sample is None:
            break
        gx = float(sample[0]) * gyro_scale
        gy = float(sample[1]) * gyro_scale
        if st.t_prev is None:
            dt = 1.0 / 52.0
        else:
            dt = float(ts) - st.t_prev
            dt = max(DT_MIN, min(DT_MAX, dt))
        st.t_prev = float(ts)
        st.mark_data()

        st.roll += gx * dt
        st.pitch += gy * dt

        ax, ay, az = st.ax, st.ay, st.az
        a_roll = math.degrees(math.atan2(ay, az))
        a_pitch = math.degrees(math.atan2(-ax, math.sqrt(ay * ay + az * az)))

        st.roll = alpha * st.roll + (1.0 - alpha) * a_roll
        st.pitch = alpha * st.pitch + (1.0 - alpha) * a_pitch


def _headset_label_map() -> dict[str, tuple[str, str]]:
    """``source_id`` → ``(nickname, hardware)`` from ``nickname.json``; empty if absent."""
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
    source_id: str, labels: dict[str, tuple[str, str]], *, max_len: int = 40
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


@dataclass
class MuseTracker:
    source_id: str
    display_title: str
    inlet_acc: object
    inlet_gyro: object
    ax3d: object
    color: str
    state: FusionState = field(default_factory=FusionState)
    lc: object | None = None
    status_ax: object | None = None
    status_text: object | None = None
    viz_prev_wall: float | None = field(default=None, repr=False)


def confirm(prompt: str) -> bool:
    raw = input(f"{prompt} [Y/n]: ").strip().lower()
    return raw in ("", "y", "yes")


def _is_connection_live(st: FusionState, now: float) -> bool:
    if st.last_data_wall is None:
        return False
    return (now - st.last_data_wall) <= CONN_STALE_SEC


def _connection_status_lines(st: FusionState, now: float) -> tuple[str, str]:
    """(multiline message, matplotlib color) for status under each cube."""
    lost = st.lost_conn_sec_total
    if st.last_data_wall is None:
        return f"Waiting for data…\nLost: {lost:.1f} s", "#888888"
    age = now - st.last_data_wall
    if age <= CONN_STALE_SEC:
        return f"● LSL live\nLost: {lost:.1f} s", "#2ca02c"
    return f"○ No data ({age:.1f}s)\nLost: {lost:.1f} s", "#c23b22"


def run_visualizer(trackers: list[MuseTracker]) -> None:
    import matplotlib.pyplot as plt
    from matplotlib.animation import FuncAnimation
    from matplotlib.gridspec import GridSpec
    from matplotlib.widgets import Button, Slider
    from mpl_toolkits.mplot3d.art3d import Line3DCollection

    n = len(trackers)
    figsize = SINGLE_FIGSIZE if n == 1 else DUAL_FIGSIZE
    fig = plt.figure(figsize=figsize)
    gs = GridSpec(2, n, figure=fig, height_ratios=[12, 1], hspace=0.32, top=0.90, bottom=0.30)

    for i, tr in enumerate(trackers):
        tr.ax3d = fig.add_subplot(gs[0, i], projection="3d")
        tr.status_ax = fig.add_subplot(gs[1, i])
        tr.status_ax.set_axis_off()
        tr.status_text = tr.status_ax.text(
            0.5,
            0.5,
            "",
            ha="center",
            va="center",
            fontsize=9,
            linespacing=1.2,
            transform=tr.status_ax.transAxes,
        )

    fig.suptitle("Live sensor-fused orientation — close window to quit")
    total_lost_txt = None
    if n > 1:
        total_lost_txt = fig.text(
            0.98,
            0.98,
            "",
            ha="right",
            va="top",
            fontsize=9,
            transform=fig.transFigure,
        )

    for tr in trackers:
        ax3d = tr.ax3d
        ax3d.set_title(tr.display_title)
        ax3d.set_xlim(-1, 1)
        ax3d.set_ylim(-1, 1)
        ax3d.set_zlim(-1, 1)
        ax3d.set_xlabel("X")
        ax3d.set_ylabel("Y")
        ax3d.set_zlabel("Z")
        try:
            ax3d.set_box_aspect((1, 1, 1))
        except AttributeError:
            pass
        R0 = rotation_matrix(tr.state.roll, tr.state.pitch)
        tr.lc = Line3DCollection(
            wireframe_segments(R0), colors=tr.color, linewidths=1.5
        )
        ax3d.add_collection3d(tr.lc)

    def _on_reset(_event) -> None:
        for tr in trackers:
            tr.state.reset_orientation()
            R = rotation_matrix(tr.state.roll, tr.state.pitch)
            tr.lc.set_segments(wireframe_segments(R))
        fig.canvas.draw_idle()

    btn_ax = fig.add_axes((0.02, 0.06, 0.14, 0.04))
    reset_btn = Button(btn_ax, "Reset cube")
    reset_btn.on_clicked(_on_reset)

    slider_w, slider_h = 0.52, 0.028
    slider_x = 0.22
    alpha_ax = fig.add_axes((slider_x, 0.19, slider_w, slider_h))
    gyro_ax = fig.add_axes((slider_x, 0.13, slider_w, slider_h))
    s_alpha = Slider(
        alpha_ax,
        "α (gyro trust)",
        0.0,
        1.0,
        valinit=ALPHA,
        valstep=0.01,
    )
    s_gyro = Slider(
        gyro_ax,
        "Gyro scale",
        0.05,
        SLIDER_GYRO_SCALE_MAX,
        valinit=GYRO_SCALE_DEFAULT,
        valstep=0.01,
    )
    fig._muse_widgets = (s_alpha, s_gyro, reset_btn)

    interval_ms = max(1, int(1000.0 / UPDATE_HZ))

    def _update(_frame: int):
        now = time.monotonic()
        for tr in trackers:
            st = tr.state
            if tr.viz_prev_wall is None:
                tr.viz_prev_wall = now
            dt_anim = max(0.0, min(now - tr.viz_prev_wall, 2.0))
            tr.viz_prev_wall = now
            if st.ever_had_data and not _is_connection_live(st, now):
                st.lost_conn_sec_total += dt_anim

            drain_acc_latest(tr.inlet_acc, tr.state)
            fuse_on_gyro_samples(
                tr.inlet_gyro, tr.state, s_alpha.val, s_gyro.val
            )
            R = rotation_matrix(tr.state.roll, tr.state.pitch)
            tr.lc.set_segments(wireframe_segments(R))
            msg, col = _connection_status_lines(st, now)
            tr.status_text.set_text(msg)
            tr.status_text.set_color(col)
        if total_lost_txt is not None:
            t_sum = sum(t.state.lost_conn_sec_total for t in trackers)
            total_lost_txt.set_text(f"Σ lost (session): {t_sum:.1f} s")
        return tuple(tr.lc for tr in trackers)

    _anim = FuncAnimation(
        fig, _update, interval=interval_ms, blit=False, cache_frame_data=False
    )
    plt.show()


def main() -> int:
    try:
        streams = discover_streams(WAIT_SEC)
    except Exception as e:
        print(f"Discovery failed: {e}", file=sys.stderr)
        return 1

    print(f"Discovery (waited {WAIT_SEC}s).")
    if not streams:
        print("No LSL streams found (is a source running?).")
        return 0

    groups = group_streams_by_source_id(streams)
    print_streams_grouped(groups)

    ready: list[tuple[str, object, object]] = []
    for sid, infos in groups.items():
        pair = find_imu_pair(infos)
        if pair is not None:
            ready.append((sid, pair[0], pair[1]))
        else:
            print(describe_imu_gap(sid, infos), file=sys.stderr)

    if not ready:
        print(
            "No headset found with both ACC and GYRO (≥3 channels each).",
            file=sys.stderr,
        )
        return 1

    if len(ready) > MAX_MUSES:
        sids = [r[0] for r in ready]
        print(
            f"This script supports at most {MAX_MUSES} headset(s) with IMU pairs; "
            f"found {len(ready)}: {sids}. Stop extra streams or raise MAX_MUSES.",
            file=sys.stderr,
        )
        return 1

    if len(ready) == 1:
        if not confirm("Start streaming"):
            print("Cancelled.")
            return 0
        prompt_extra = ""
    else:
        if not confirm("Start streaming both headsets"):
            print("Cancelled.")
            return 0
        prompt_extra = " both"

    labels = _headset_label_map()
    trackers: list[MuseTracker] = []
    try:
        for i, (sid, acc_info, gyro_info) in enumerate(ready):
            inlet_acc = open_inlet_from_info(acc_info)
            inlet_gyro = open_inlet_from_info(gyro_info)
            color = _TRACK_COLORS[i % len(_TRACK_COLORS)]
            trackers.append(
                MuseTracker(
                    source_id=sid,
                    display_title=_cube_title(sid, labels),
                    inlet_acc=inlet_acc,
                    inlet_gyro=inlet_gyro,
                    ax3d=None,
                    color=color,
                )
            )
    except ValueError as e:
        print(e, file=sys.stderr)
        return 1

    print(f"Live cube{prompt_extra} (close the figure window to exit).")
    try:
        run_visualizer(trackers)
    except KeyboardInterrupt:
        print("\nStopped.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
