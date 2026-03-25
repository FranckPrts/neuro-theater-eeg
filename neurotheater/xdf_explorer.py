"""Load and inspect XDF recordings (e.g. Muse / LSL) via pyxdf."""

from __future__ import annotations

import csv
import re
from pathlib import Path
from typing import Any, Iterator, Literal

import pyxdf


def _info_scalar(info: dict[str, Any], key: str) -> Any:
    val = info.get(key)
    if isinstance(val, (list, tuple)) and val:
        return val[0]
    return val


def _series_shape(time_series: Any) -> tuple[int, ...]:
    if hasattr(time_series, "shape"):
        return tuple(int(x) for x in time_series.shape)
    if hasattr(time_series, "__len__"):
        return (len(time_series),)
    return (0,)


def _series_sample_channel_dims(time_series: Any) -> tuple[int, int]:
    """Return ``(n_samples, n_channels)`` for pyxdf ``time_series`` arrays."""
    if hasattr(time_series, "shape"):
        sh = time_series.shape
        if len(sh) == 0:
            return 0, 0
        if len(sh) == 1:
            return int(sh[0]), 1
        return int(sh[0]), int(sh[1])
    if hasattr(time_series, "__len__"):
        return len(time_series), 1  # type: ignore[arg-type]
    return 0, 0


def _sample_channel_dims(time_series: Any) -> tuple[int, int]:
    """Return ``(n_samples, n_channels)`` (alias of :func:`_series_sample_channel_dims`)."""
    return _series_sample_channel_dims(time_series)


def _channel_count(stream: dict[str, Any], time_series: Any) -> int:
    info = stream.get("info") or {}
    raw = _info_scalar(info, "channel_count")
    if raw is not None and raw != "":
        try:
            return int(float(str(raw)))
        except (ValueError, TypeError):
            pass
    _, n_ch = _series_sample_channel_dims(time_series)
    return n_ch


def _str_field(val: Any) -> str:
    if val is None:
        return ""
    return str(val)


def _sanitize_token(s: str) -> str:
    """Make ``s`` safe for CSV headers and filenames."""
    if not s:
        return ""
    out = re.sub(r"[/\\:\n\r\t]+", "_", s)
    out = re.sub(r"\s+", "_", out.strip())
    return out


def _streams_matching_sources(
    streams: list[dict[str, Any]], sources: list[str] | None
) -> list[tuple[int, dict[str, Any]]]:
    """Indices and streams to export; ``sources`` None or empty selects all."""
    if not sources:
        return list(enumerate(streams))
    want = set(sources)
    out: list[tuple[int, dict[str, Any]]] = []
    for i, stream in enumerate(streams):
        info = stream.get("info") or {}
        sid = _str_field(_info_scalar(info, "source_id"))
        sname = _str_field(_info_scalar(info, "name"))
        if sid in want or sname in want:
            out.append((i, stream))
    return out


def _streams_available_labels(streams: list[dict[str, Any]]) -> list[tuple[str, str]]:
    rows: list[tuple[str, str]] = []
    for stream in streams:
        info = stream.get("info") or {}
        sid = _str_field(_info_scalar(info, "source_id"))
        sname = _str_field(_info_scalar(info, "name"))
        rows.append((sid, sname))
    return rows


def _streams_available_types(streams: list[dict[str, Any]]) -> list[str]:
    seen: list[str] = []
    for stream in streams:
        info = stream.get("info") or {}
        st = _str_field(_info_scalar(info, "type"))
        if st and st not in seen:
            seen.append(st)
    return seen


def _streams_for_export(
    streams: list[dict[str, Any]],
    sources: list[str] | None,
    types: list[str] | None,
) -> list[tuple[int, dict[str, Any]]]:
    """Apply ``sources`` then ``types`` (AND). Empty ``types`` means all types."""
    base = _streams_matching_sources(streams, sources)
    if not types:
        return base
    want_t = set(types)
    out: list[tuple[int, dict[str, Any]]] = []
    for i, stream in base:
        info = stream.get("info") or {}
        st = _str_field(_info_scalar(info, "type"))
        if st in want_t:
            out.append((i, stream))
    return out


def _channel_col_name(
    stream_index: int,
    source_id: str,
    stream_type: str,
    channel_idx: int,
) -> str:
    sid = _sanitize_token(source_id)
    st = _sanitize_token(stream_type)
    return f"{stream_index}_{sid}_{st}_{channel_idx}"


def _per_stream_csv_path(
    base_path: Path,
    stream_index: int,
    stream_type: str,
    source_id: str,
) -> Path:
    parent = base_path.parent
    stem = base_path.stem
    ext = base_path.suffix if base_path.suffix else ".csv"
    safe_type = _sanitize_token(stream_type) or "unknown"
    safe_sid = _sanitize_token(source_id) or "unknown"
    return parent / f"{stem}__{stream_index}__{safe_type}__{safe_sid}{ext}"


def _cell_at_sample(ts: Any, i: int, c: int, n_ch: int) -> Any:
    if n_ch == 1 and hasattr(ts, "shape") and len(ts.shape) == 1:
        return ts[i]
    return ts[i, c]


META_COLS = (
    "timestamp",
    "stream_index",
    "source_id",
    "stream_name",
    "stream_type",
)


def _validate_stream_timestamps(
    stream_idx: int,
    sname: str,
    t_stamps: Any,
    n_samples: int,
) -> None:
    if t_stamps is None:
        raise ValueError(f"Stream index {stream_idx} ({sname!r}) has no time_stamps")
    if len(t_stamps) != n_samples:
        raise ValueError(
            f"Stream index {stream_idx} ({sname!r}): len(time_stamps)="
            f"{len(t_stamps)} does not match time_series sample count {n_samples}"
        )


class XdfExplorer:
    """Thin wrapper around :func:`pyxdf.load_xdf` with helpers for inspection."""

    def __init__(self, path: str | Path) -> None:
        self.path = Path(path).expanduser().resolve()
        if not self.path.is_file():
            raise FileNotFoundError(f"Not a file: {self.path}")
        self.streams, self.fileheader = pyxdf.load_xdf(str(self.path))

    def __len__(self) -> int:
        return len(self.streams)

    def __iter__(self) -> Iterator[dict[str, Any]]:
        return iter(self.streams)

    def stream_summary(self) -> list[dict[str, Any]]:
        rows: list[dict[str, Any]] = []
        for stream in self.streams:
            info = stream.get("info") or {}
            ts = stream.get("time_series")
            name = _info_scalar(info, "name")
            stype = _info_scalar(info, "type")
            sid = _info_scalar(info, "source_id")
            rows.append(
                {
                    "name": str(name) if name is not None else "",
                    "type": str(stype) if stype is not None else "",
                    "source_id": _str_field(sid),
                    "channel_count": _channel_count(stream, ts),
                    "series_shape": _series_shape(ts),
                }
            )
        return rows

    def muse_streams(self) -> list[dict[str, Any]]:
        """Streams whose stream name is exactly ``'Muse'`` (LSL default for Muse)."""
        out: list[dict[str, Any]] = []
        for stream in self.streams:
            info = stream.get("info") or {}
            name = _info_scalar(info, "name")
            if str(name) == "Muse":
                out.append(stream)
        return out

    def to_csv(
        self,
        path: str | Path,
        *,
        sources: list[str] | None = None,
        types: list[str] | None = None,
        output: Literal["single", "per_stream"] = "single",
    ) -> Path | list[Path]:
        """Export selected streams to wide-format CSV.

        **Filters:** If ``sources`` is ``None`` or empty, all streams are
        candidates. Otherwise a stream matches if its LSL ``source_id`` or
        ``name`` equals one of the strings. If ``types`` is non-empty, only
        streams whose LSL ``type`` is in that list are kept (**AND** with
        ``sources``).

        **Format:** One row per raw time sample. Channel columns are named
        ``{stream_index}_{source_id}_{stream_type}_{channel_idx}`` (tokens
        sanitized) for ``output=single``. For ``output=single``, the table is
        **sparse**: each row only fills columns for the stream that produced that
        sample (other channel cells are empty). For ``output=per_stream``, each
        file is dense with channel columns ``0``, ``1``, …

        **``output``:** ``single`` writes one combined file. ``per_stream`` writes
        one file per selected stream as
        ``{parent}/{stem}__{idx}__{TYPE}__{source}.csv``.

        Parent directories for output paths are created if missing.

        :param path: Output file path (including filename) for ``output=single``;
            for ``per_stream``, the stem and parent define per-stream filenames.
        :param sources: Optional ``source_id`` / ``name`` filter.
        :param types: Optional LSL type filter (e.g. ``[\"EEG\"]``).
        :param output: ``single`` or ``per_stream``.
        :returns: Path to the single CSV, or a list of paths when ``per_stream``.
        :raises ValueError: If no stream matches ``sources`` and/or ``types``, or
            on timestamp / shape mismatches.
        """
        base_path = Path(path).expanduser()
        base_path.parent.mkdir(parents=True, exist_ok=True)

        selected = _streams_for_export(self.streams, sources, types)

        if sources and not _streams_matching_sources(self.streams, sources):
            avail = _streams_available_labels(self.streams)
            pairs = ", ".join(
                f"(source_id={sid!r}, name={name!r})" for sid, name in avail
            )
            raise ValueError(
                f"No stream matches sources={sources!r}. Available: {pairs or '(none)'}"
            )

        if types and not selected:
            avail_t = _streams_available_types(self.streams)
            raise ValueError(
                f"No stream matches types={types!r}. Available types: {avail_t or '(none)'}"
            )

        if not selected:
            return base_path.resolve() if output == "single" else []

        if output == "per_stream":
            written: list[Path] = []
            for stream_idx, stream in selected:
                info = stream.get("info") or {}
                sid = _str_field(_info_scalar(info, "source_id"))
                stype = _str_field(_info_scalar(info, "type"))
                out_p = _per_stream_csv_path(base_path, stream_idx, stype, sid)
                out_p.parent.mkdir(parents=True, exist_ok=True)
                _write_one_stream_wide_csv(out_p, stream_idx, stream)
                written.append(out_p.resolve())
            return written

        return _write_single_wide_csv(base_path, selected)


def _write_single_wide_csv(
    base_path: Path,
    selected: list[tuple[int, dict[str, Any]]],
) -> Path:
    ch_cols: list[str] = []
    for stream_idx, stream in selected:
        info = stream.get("info") or {}
        sid = _str_field(_info_scalar(info, "source_id"))
        stype = _str_field(_info_scalar(info, "type"))
        ts = stream.get("time_series")
        _, n_ch = _sample_channel_dims(ts)
        for c in range(n_ch):
            ch_cols.append(_channel_col_name(stream_idx, sid, stype, c))
    ch_cols_tuple = tuple(ch_cols)
    fieldnames = META_COLS + ch_cols_tuple

    with base_path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        for stream_idx, stream in selected:
            info = stream.get("info") or {}
            sid = _str_field(_info_scalar(info, "source_id"))
            sname = _str_field(_info_scalar(info, "name"))
            stype = _str_field(_info_scalar(info, "type"))
            t_stamps = stream.get("time_stamps")
            ts = stream.get("time_series")
            n_samples, n_ch = _sample_channel_dims(ts)
            _validate_stream_timestamps(stream_idx, sname, t_stamps, n_samples)
            for i in range(n_samples):
                stamp = t_stamps[i]
                row: dict[str, Any] = {
                    "timestamp": stamp,
                    "stream_index": stream_idx,
                    "source_id": sid,
                    "stream_name": sname,
                    "stream_type": stype,
                }
                for col in ch_cols_tuple:
                    row[col] = ""
                for c in range(n_ch):
                    key = _channel_col_name(stream_idx, sid, stype, c)
                    row[key] = _cell_at_sample(ts, i, c, n_ch)
                writer.writerow(row)

    return base_path.resolve()


def _write_one_stream_wide_csv(
    path: Path,
    stream_idx: int,
    stream: dict[str, Any],
) -> None:
    info = stream.get("info") or {}
    sid = _str_field(_info_scalar(info, "source_id"))
    sname = _str_field(_info_scalar(info, "name"))
    stype = _str_field(_info_scalar(info, "type"))
    t_stamps = stream.get("time_stamps")
    ts = stream.get("time_series")
    n_samples, n_ch = _sample_channel_dims(ts)
    _validate_stream_timestamps(stream_idx, sname, t_stamps, n_samples)

    ch_cols = tuple(str(c) for c in range(n_ch))
    fieldnames = META_COLS + ch_cols

    with path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        for i in range(n_samples):
            stamp = t_stamps[i]
            row: dict[str, Any] = {
                "timestamp": stamp,
                "stream_index": stream_idx,
                "source_id": sid,
                "stream_name": sname,
                "stream_type": stype,
            }
            for c in range(n_ch):
                row[str(c)] = _cell_at_sample(ts, i, c, n_ch)
            writer.writerow(row)
