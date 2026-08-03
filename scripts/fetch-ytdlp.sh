#!/usr/bin/env bash
# Fetch the standalone yt-dlp binary into ./bin at build time.
#
# yt-dlp is what turns an approved YouTube video into a stored MP3. We pull the
# self-contained Linux build rather than a system package so this works under
# any Railway builder (Nixpacks, Railpack, Docker) without build-config drift.
#
# Never fatal: a failed fetch must not break a deploy that has nothing to do
# with YouTube. The admin panel surfaces a missing binary, and downloads simply
# stay queued until it's there.
set -uo pipefail

BIN_DIR="$(cd "$(dirname "$0")/.." && pwd)/bin"
DEST="$BIN_DIR/yt-dlp"
URL="https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux"

mkdir -p "$BIN_DIR"

if ! curl -fsSL --retry 3 --connect-timeout 20 "$URL" -o "$DEST.tmp"; then
  echo "fetch-ytdlp: download failed — YouTube ingest will report yt-dlp missing" >&2
  rm -f "$DEST.tmp"
  exit 0
fi

chmod +x "$DEST.tmp"
mv "$DEST.tmp" "$DEST"

if "$DEST" --version >/dev/null 2>&1; then
  echo "fetch-ytdlp: installed yt-dlp $("$DEST" --version)"
else
  echo "fetch-ytdlp: binary downloaded but not runnable on this platform" >&2
fi

exit 0
