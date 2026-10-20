"""Thin wrappers around the ffmpeg / ffprobe command line tools."""

from __future__ import annotations

import json
import subprocess
from dataclasses import dataclass
from pathlib import Path


class FFmpegError(RuntimeError):
    pass


@dataclass(frozen=True)
class OutputFormat:
    ext: str
    codec_args: tuple[str, ...]
    uses_bitrate: bool
    mime: str


# "copy" is handled separately: it keeps the source codec, so its container
# depends on what the input actually contains.
FORMATS: dict[str, OutputFormat] = {
    "mp3": OutputFormat("mp3", ("-c:a", "libmp3lame"), True, "audio/mpeg"),
    "m4a": OutputFormat("m4a", ("-c:a", "aac"), True, "audio/mp4"),
    "opus": OutputFormat("opus", ("-c:a", "libopus"), True, "audio/ogg"),
    "ogg": OutputFormat("ogg", ("-c:a", "libvorbis"), True, "audio/ogg"),
    "flac": OutputFormat("flac", ("-c:a", "flac"), False, "audio/flac"),
    "wav": OutputFormat("wav", ("-c:a", "pcm_s16le"), False, "audio/wav"),
}

# Container to use when stream-copying a given codec.
COPY_CONTAINERS: dict[str, tuple[str, str]] = {
    "aac": ("m4a", "audio/mp4"),
    "alac": ("m4a", "audio/mp4"),
    "mp3": ("mp3", "audio/mpeg"),
    "opus": ("opus", "audio/ogg"),
    "vorbis": ("ogg", "audio/ogg"),
    "flac": ("flac", "audio/flac"),
}
COPY_FALLBACK = ("mka", "audio/x-matroska")

ALLOWED_BITRATES = {"64k", "96k", "128k", "160k", "192k", "256k", "320k"}

TIMEOUT_SECONDS = 60 * 30


def _run(cmd: list[str]) -> str:
    try:
        proc = subprocess.run(
            cmd, capture_output=True, text=True, timeout=TIMEOUT_SECONDS
        )
    except subprocess.TimeoutExpired as exc:
        raise FFmpegError("ffmpeg timed out") from exc
    if proc.returncode != 0:
        # The tail of stderr is where ffmpeg puts the actual reason.
        tail = "\n".join(proc.stderr.strip().splitlines()[-8:])
        raise FFmpegError(tail or f"{cmd[0]} exited with {proc.returncode}")
    return proc.stdout


def probe_audio(path: Path) -> dict:
    """Return codec name, sample rate, channels and duration of the first audio stream."""
    out = _run([
        "ffprobe", "-v", "error",
        "-select_streams", "a:0",
        "-show_entries", "stream=codec_name,sample_rate,channels:format=duration",
        "-of", "json",
        str(path),
    ])
    data = json.loads(out or "{}")
    streams = data.get("streams") or []
    if not streams:
        raise FFmpegError(f"{path.name}: no audio stream found")
    s = streams[0]
    duration = data.get("format", {}).get("duration")
    return {
        "codec": s.get("codec_name"),
        "sample_rate": int(s["sample_rate"]) if s.get("sample_rate") else None,
        "channels": s.get("channels"),
        "duration": float(duration) if duration not in (None, "N/A") else None,
    }


def copy_container(codec: str) -> tuple[str, str]:
    if codec.startswith("pcm_"):
        return ("wav", "audio/wav")
    return COPY_CONTAINERS.get(codec, COPY_FALLBACK)


def _codec_args(fmt: OutputFormat, bitrate: str) -> list[str]:
    args = list(fmt.codec_args)
    if fmt.uses_bitrate:
        args += ["-b:a", bitrate]
    return args


def _time_args(start: float | None, end: float | None) -> list[str]:
    args: list[str] = []
    if start:
        args += ["-ss", f"{start:.3f}"]
    if end:
        args += ["-to", f"{end:.3f}"]
    return args


def extract(
    src: Path, dst: Path, fmt_key: str, bitrate: str,
    start: float | None, end: float | None,
) -> None:
    """Pull the audio track out of src (audio or video), optionally trimmed."""
    cmd = ["ffmpeg", "-hide_banner", "-y", *_time_args(start, end), "-i", str(src), "-vn", "-sn", "-dn"]
    if fmt_key == "copy":
        cmd += ["-c:a", "copy"]
    else:
        cmd += _codec_args(FORMATS[fmt_key], bitrate)
    cmd += ["-map", "0:a:0", str(dst)]
    _run(cmd)


def _concat_list_entry(path: Path, start: float | None, end: float | None) -> str:
    escaped = str(path).replace("'", "'\\''")
    lines = [f"file '{escaped}'"]
    if start:
        lines.append(f"inpoint {start:.3f}")
    if end:
        lines.append(f"outpoint {end:.3f}")
    return "\n".join(lines)


def splice_copy(
    parts: list[tuple[Path, float | None, float | None]], dst: Path, workdir: Path,
) -> None:
    """Lossless join via the concat demuxer — the same thing as

        printf "file '%s'\\n" p1.m4a p2.m4a > list.txt
        ffmpeg -f concat -safe 0 -i list.txt -c copy merged.m4a

    Inputs must share codec / sample rate / channel layout.
    """
    list_file = workdir / "list.txt"
    list_file.write_text("\n".join(_concat_list_entry(*p) for p in parts) + "\n")
    _run([
        "ffmpeg", "-hide_banner", "-y",
        "-f", "concat", "-safe", "0", "-i", str(list_file),
        "-vn", "-map", "0:a", "-c", "copy", str(dst),
    ])


def splice_encode(
    parts: list[tuple[Path, float | None, float | None]], dst: Path,
    fmt_key: str, bitrate: str, sample_rate: int,
) -> None:
    """Re-encoding join via the concat filter, which tolerates mixed
    codecs, sample rates and channel counts."""
    cmd = ["ffmpeg", "-hide_banner", "-y"]
    for path, start, end in parts:
        cmd += [*_time_args(start, end), "-i", str(path)]

    # Normalise every input to the same rate/layout so concat accepts them.
    chains = [
        f"[{i}:a:0]aresample={sample_rate},aformat=sample_fmts=fltp:channel_layouts=stereo,asetpts=PTS-STARTPTS[a{i}]"
        for i in range(len(parts))
    ]
    joined = "".join(f"[a{i}]" for i in range(len(parts)))
    graph = ";".join(chains) + f";{joined}concat=n={len(parts)}:v=0:a=1[out]"

    cmd += ["-filter_complex", graph, "-map", "[out]"]
    cmd += _codec_args(FORMATS[fmt_key], bitrate)
    if fmt_key == "opus":
        # libopus only accepts 48k; let ffmpeg resample at the encoder.
        cmd += ["-ar", "48000"]
    cmd.append(str(dst))
    _run(cmd)
