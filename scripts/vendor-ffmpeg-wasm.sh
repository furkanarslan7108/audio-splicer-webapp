#!/usr/bin/env sh
# Copy the ffmpeg.wasm build into frontend/vendor/ffmpeg so the app can serve
# it itself (its worker can't be loaded cross-origin from a CDN).
# Usage: scripts/vendor-ffmpeg-wasm.sh [dest]   — needs npm.
set -eu

FFMPEG_VERSION=0.12.15
CORE_VERSION=0.12.10   # single-threaded core: no COOP/COEP headers required

dest=${1:-"$(dirname "$0")/../frontend/vendor/ffmpeg"}
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

npm pack --silent --pack-destination "$tmp" "@ffmpeg/ffmpeg@$FFMPEG_VERSION" "@ffmpeg/core@$CORE_VERSION" >/dev/null
mkdir -p "$tmp/ffmpeg" "$tmp/core" "$dest"
tar xzf "$tmp"/ffmpeg-ffmpeg-*.tgz -C "$tmp/ffmpeg"
tar xzf "$tmp"/ffmpeg-core-*.tgz -C "$tmp/core"

cp "$tmp/ffmpeg/package/dist/umd/ffmpeg.js" \
   "$tmp/ffmpeg/package/dist/umd/814.ffmpeg.js" \
   "$tmp/core/package/dist/umd/ffmpeg-core.js" \
   "$tmp/core/package/dist/umd/ffmpeg-core.wasm" \
   "$dest/"
echo "ffmpeg.wasm $FFMPEG_VERSION (core $CORE_VERSION) -> $dest"
