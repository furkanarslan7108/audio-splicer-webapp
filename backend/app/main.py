"""Audio Splicer API: upload clips, get back a spliced or extracted track."""

from __future__ import annotations

import json
import os
import re
import shutil
import tempfile
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from starlette.background import BackgroundTask

from . import ffmpeg

STATIC_DIR = Path(os.environ.get("STATIC_DIR", Path(__file__).resolve().parents[2] / "frontend"))
MAX_UPLOAD_MB = int(os.environ.get("MAX_UPLOAD_MB", "1024"))
MAX_FILES = int(os.environ.get("MAX_FILES", "50"))
CHUNK = 1024 * 1024

app = FastAPI(title="Audio Splicer")


def _safe_name(name: str, fallback: str) -> str:
    stem = re.sub(r"[^\w\-. ]+", "_", Path(name or "").stem).strip(" .")
    return stem[:100] or fallback


async def _save_upload(upload: UploadFile, dst: Path, budget: list[int]) -> None:
    """Stream an upload to disk, enforcing the total size limit across all files."""
    with dst.open("wb") as fh:
        while chunk := await upload.read(CHUNK):
            budget[0] -= len(chunk)
            if budget[0] < 0:
                raise HTTPException(413, f"Uploads exceed the {MAX_UPLOAD_MB} MB limit")
            fh.write(chunk)


def _parse_time(value: str | float | None, label: str) -> float | None:
    """Accept seconds ("75.5") or clock time ("1:15.5", "01:01:15")."""
    if value is None or str(value).strip() == "":
        return None
    text = str(value).strip()
    try:
        seconds = 0.0
        for part in text.split(":"):
            seconds = seconds * 60 + float(part)
    except ValueError:
        raise HTTPException(400, f"{label}: '{text}' is not a valid time") from None
    if seconds < 0 or text.count(":") > 2:
        raise HTTPException(400, f"{label}: '{text}' is not a valid time")
    return seconds or None


def _check_range(start: float | None, end: float | None, label: str) -> None:
    if start is not None and end is not None and end <= start:
        raise HTTPException(400, f"{label}: end must be after start")


def _check_format(fmt: str, bitrate: str) -> None:
    if fmt != "copy" and fmt not in ffmpeg.FORMATS:
        raise HTTPException(400, f"Unknown format '{fmt}'")
    if bitrate not in ffmpeg.ALLOWED_BITRATES:
        raise HTTPException(400, f"Unsupported bitrate '{bitrate}'")


def _respond(path: Path, filename: str, mime: str, workdir: Path) -> FileResponse:
    return FileResponse(
        path,
        media_type=mime,
        filename=filename,
        background=BackgroundTask(shutil.rmtree, workdir, ignore_errors=True),
    )


@app.get("/api/health")
def health() -> dict:
    return {"ok": True, "ffmpeg": shutil.which("ffmpeg") is not None}


@app.get("/api/config")
def config() -> dict:
    return {
        "formats": ["copy", *ffmpeg.FORMATS],
        "bitrates": sorted(ffmpeg.ALLOWED_BITRATES, key=lambda b: int(b[:-1])),
        "max_upload_mb": MAX_UPLOAD_MB,
        "max_files": MAX_FILES,
    }


@app.post("/api/splice")
async def splice(
    files: list[UploadFile] = File(...),
    trims: str = Form("[]"),
    format: str = Form("copy"),
    bitrate: str = Form("128k"),
    output_name: str = Form("merged"),
):
    """Join files in the order they were sent.

    `trims` is a JSON list aligned with `files`: [{"start": "0:05", "end": "1:20"}, ...].
    """
    if not 1 <= len(files) <= MAX_FILES:
        raise HTTPException(400, f"Send between 1 and {MAX_FILES} files")
    _check_format(format, bitrate)
    try:
        trim_list = json.loads(trims or "[]")
        assert isinstance(trim_list, list)
    except (ValueError, AssertionError):
        raise HTTPException(400, "trims must be a JSON list") from None

    workdir = Path(tempfile.mkdtemp(prefix="splice-"))
    try:
        budget = [MAX_UPLOAD_MB * 1024 * 1024]
        parts: list[tuple[Path, float | None, float | None]] = []
        for i, upload in enumerate(files):
            suffix = Path(upload.filename or "").suffix[:10]
            src = workdir / f"in{i:03d}{suffix}"
            await _save_upload(upload, src, budget)
            trim = trim_list[i] if i < len(trim_list) and isinstance(trim_list[i], dict) else {}
            label = upload.filename or f"file {i + 1}"
            start = _parse_time(trim.get("start"), label)
            end = _parse_time(trim.get("end"), label)
            _check_range(start, end, label)
            parts.append((src, start, end))

        try:
            probes = [await run_in_threadpool(ffmpeg.probe_audio, p) for p, _, _ in parts]
        except ffmpeg.FFmpegError as exc:
            raise HTTPException(422, str(exc)) from None

        name = _safe_name(output_name, "merged")
        if format == "copy":
            signatures = {(p["codec"], p["sample_rate"], p["channels"]) for p in probes}
            if len(signatures) > 1:
                desc = ", ".join(f"{c} {r}Hz {ch}ch" for c, r, ch in sorted(signatures, key=str))
                raise HTTPException(
                    422,
                    f"Lossless join needs identical audio formats, but got: {desc}. "
                    "Pick an output format to re-encode instead.",
                )
            ext, mime = ffmpeg.copy_container(probes[0]["codec"])
            dst = workdir / f"out.{ext}"
            run = lambda: ffmpeg.splice_copy(parts, dst, workdir)  # noqa: E731
        else:
            out_fmt = ffmpeg.FORMATS[format]
            ext, mime = out_fmt.ext, out_fmt.mime
            dst = workdir / f"out.{ext}"
            rate = max((p["sample_rate"] or 44100) for p in probes)
            run = lambda: ffmpeg.splice_encode(parts, dst, format, bitrate, rate)  # noqa: E731

        try:
            await run_in_threadpool(run)
        except ffmpeg.FFmpegError as exc:
            raise HTTPException(422, f"ffmpeg failed:\n{exc}") from None

        return _respond(dst, f"{name}.{ext}", mime, workdir)
    except BaseException:
        shutil.rmtree(workdir, ignore_errors=True)
        raise


@app.post("/api/extract")
async def extract(
    file: UploadFile = File(...),
    start: str = Form(""),
    end: str = Form(""),
    format: str = Form("mp3"),
    bitrate: str = Form("128k"),
    output_name: str = Form(""),
):
    """Pull the audio out of an audio/video file, optionally cutting a range."""
    _check_format(format, bitrate)
    t_start = _parse_time(start, "start")
    t_end = _parse_time(end, "end")
    _check_range(t_start, t_end, "range")

    workdir = Path(tempfile.mkdtemp(prefix="extract-"))
    try:
        suffix = Path(file.filename or "").suffix[:10]
        src = workdir / f"in{suffix}"
        await _save_upload(file, src, [MAX_UPLOAD_MB * 1024 * 1024])

        try:
            info = await run_in_threadpool(ffmpeg.probe_audio, src)
        except ffmpeg.FFmpegError as exc:
            raise HTTPException(422, str(exc)) from None

        if format == "copy":
            ext, mime = ffmpeg.copy_container(info["codec"])
        else:
            ext, mime = ffmpeg.FORMATS[format].ext, ffmpeg.FORMATS[format].mime
        dst = workdir / f"out.{ext}"
        name = _safe_name(output_name or f"{Path(file.filename or 'audio').stem}-audio", "audio")

        try:
            await run_in_threadpool(ffmpeg.extract, src, dst, format, bitrate, t_start, t_end)
        except ffmpeg.FFmpegError as exc:
            raise HTTPException(422, f"ffmpeg failed:\n{exc}") from None

        return _respond(dst, f"{name}.{ext}", mime, workdir)
    except BaseException:
        shutil.rmtree(workdir, ignore_errors=True)
        raise


# Mounted last so /api routes take precedence.
app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="frontend")
