<div align="center">

<img src=".github/readme/banner.svg" alt="AeroSplice: splice and extract audio with ffmpeg, right in your browser" width="100%">

<br>

<a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-55c234?style=plastic"></a>
<img alt="ffmpeg.wasm" src="https://img.shields.io/badge/ffmpeg.wasm-in%20your%20browser-1aa6e6?style=plastic&logo=ffmpeg&logoColor=white">
<img alt="Docker" src="https://img.shields.io/badge/docker%20compose-ready-0670b8?style=plastic&logo=docker&logoColor=white">
<img alt="FastAPI" src="https://img.shields.io/badge/FastAPI-fallback-23862a?style=plastic&logo=fastapi&logoColor=white">
<img alt="Vanilla JS" src="https://img.shields.io/badge/vanilla-HTML%20%2F%20CSS%20%2F%20JS-7fe3ff?style=plastic&logo=javascript&logoColor=white">

<br><br>

<b>✨ Welcome to AeroSplice! ✨</b><br>
<sub>A small dockerized web app for <b>splicing</b> audio clips together and <b>extracting</b> audio from video/audio files, powered by ffmpeg.</sub>

<br><br>

<table>
<tr>
<td align="center" width="33%">🫧<br><b>Glossy &amp; bubbly</b><br><sub>Vanilla HTML/CSS/JS with a Frutiger Aero look: sky, glass, gloss, bubbles, grass.</sub></td>
<td align="center" width="33%">🔒<br><b>Your files stay put</b><br><sub>ffmpeg runs <b>in the browser</b> via <a href="https://github.com/ffmpegwasm/ffmpeg.wasm">ffmpeg.wasm</a>, so nothing is uploaded.</sub></td>
<td align="center" width="33%">🌐<br><b>Server fallback</b><br><sub>A small Python (FastAPI) server hosts the page and keeps a server-side ffmpeg API as a fallback.</sub></td>
</tr>
</table>

</div>

<img src=".github/readme/divider.svg" width="100%" alt="">

## <img src=".github/readme/icon-run.svg" width="30" alt=""> Run

```bash
docker compose up -d --build
```

Open <http://localhost:8000>, then splice away. 🎶

<img src=".github/readme/divider.svg" width="100%" alt="">

## <img src=".github/readme/icon-features.svg" width="30" alt=""> Features

### 🎚️ Splice clips

- Drop in any number of clips, reorder by drag-and-drop or ▲/▼, preview each one.
- Optional per-clip trim (`from` / `to`); the ◷ button grabs the current preview position.
- **Original (lossless copy)** uses the concat demuxer, exactly like doing it by hand:
  ```bash
  printf "file '%s'\n" p1.m4a p2.m4a p3.m4a > list.txt
  ffmpeg -f concat -safe 0 -i list.txt -c copy merged.m4a
  ```
  This needs every clip to have the same codec, sample rate and channel count. If they don't, the app tells you so.
- Any other format (MP3, M4A/AAC, Opus, Ogg Vorbis, FLAC, WAV) re-encodes through ffmpeg's `concat` filter, which handles mixed inputs, e.g. `-c:a libmp3lame -b:a 96k merged.mp3`.

### 🎬 Extract audio

- Pull the audio track out of a video (or audio) file, optionally only a start–end range.
- Stream-copy it (the container is picked to match the codec, e.g. AAC → `.m4a`) or re-encode it.

Each panel can show the equivalent ffmpeg command.

> [!TIP]
> Times can be written in seconds (`75.5`) or clock format (`1:15.5`, `1:02:03`).

<img src=".github/readme/divider.svg" width="100%" alt="">

## <img src=".github/readme/icon-privacy.svg" width="30" alt=""> Stays in your browser

- Processing runs in ffmpeg.wasm (single-threaded core, ~32 MB, downloaded once and then cached). Inputs are read straight from your files rather than copied into wasm memory, but the output is built in memory, so very large results (around 2 GB) won't fit.
- Opus is encoded with ffmpeg's built-in `opus` encoder in the browser, because the wasm build's `libopus` crashes on stereo input.
- Your clips, trims, settings and last results are kept in IndexedDB and come back after a reload.
- If the wasm build can't be loaded, the app falls back to uploading to the server's API.

<img src=".github/readme/divider.svg" width="100%" alt="">

## <img src=".github/readme/icon-config.svg" width="30" alt=""> Configuration

Set these environment variables in `docker-compose.yml`:

| Variable        | Default | Meaning                                  |
|-----------------|---------|------------------------------------------|
| `MAX_UPLOAD_MB` | `1024`  | Total upload size limit per request      |
| `MAX_FILES`     | `50`    | Max clips per splice                     |

These only apply to the server fallback / API. Its uploads go to a tmpfs (`/tmp`, 4 GB) and are deleted once the response has been sent.

<img src=".github/readme/divider.svg" width="100%" alt="">

## <img src=".github/readme/icon-api.svg" width="30" alt=""> API

The browser doesn't need these, but they're handy for scripting (and are the fallback when ffmpeg.wasm is unavailable).

| Endpoint | Body |
|----------|------|
| `POST /api/splice`  | multipart: `files` (repeated, in order), `trims` (JSON list of `{start, end}`), `format`, `bitrate`, `output_name` |
| `POST /api/extract` | multipart: `file`, `start`, `end`, `format`, `bitrate`, `output_name` |
| `GET /api/config`, `GET /api/health` | — |

```bash
curl -F files=@p1.m4a -F files=@p2.m4a -F format=mp3 -F bitrate=96k \
     -o merged.mp3 http://localhost:8000/api/splice
```

<img src=".github/readme/divider.svg" width="100%" alt="">

## <img src=".github/readme/icon-dev.svg" width="30" alt=""> Local dev without Docker

Requires `ffmpeg` on your PATH (for the API) and `npm` (to fetch the ffmpeg.wasm build into `frontend/vendor/`, which is git-ignored; the Docker build does this itself).

```bash
scripts/vendor-ffmpeg-wasm.sh
cd backend
pip install -r requirements.txt
uvicorn app.main:app --reload
```

<img src=".github/readme/divider.svg" width="100%" alt="">

<div align="center">

<img src=".github/readme/button-ffmpeg.svg" width="88" height="31" alt="ffmpeg powered">
<img src=".github/readme/button-wasm.svg" width="88" height="31" alt="WASM inside">
<img src=".github/readme/button-docker.svg" width="88" height="31" alt="Docker ready">
<img src=".github/readme/button-vanilla.svg" width="88" height="31" alt="Vanilla JS / CSS">
<img src=".github/readme/button-nouploads.svg" width="88" height="31" alt="No uploads">
<img src=".github/readme/button-aero.svg" width="88" height="31" alt="Frutiger Aero">

<sub>Best viewed in any browser at 1024×768 or higher · Released under the <a href="LICENSE">MIT License</a> · © 2026 Furkan Arslan</sub>

</div>
