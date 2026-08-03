#!/usr/bin/env bash
# Fetch the download toolchain into ./bin at build time: yt-dlp and Deno.
#
# yt-dlp turns an approved YouTube video into a stored MP3. Deno is not
# optional decoration — YouTube requires solving an obfuscated JavaScript "n
# challenge" to hand over stream URLs on authenticated (cookie-bearing)
# requests, and yt-dlp needs a JS runtime to do it. Without Deno, yt-dlp
# reports "n challenge solving failed" and returns ZERO audio formats, so every
# download fails. yt-dlp does not accept the Node that's already in the image
# (it reports node as unavailable), hence a separate runtime.
#
# Both are self-contained binaries so this works under any Railway builder
# (Nixpacks, Railpack, Docker) without build-config drift.
#
# Never fatal: a failed fetch must not break a deploy that has nothing to do
# with YouTube. The admin panel surfaces what's missing and downloads simply
# stay queued until it's there.
set -uo pipefail

BIN_DIR="$(cd "$(dirname "$0")/.." && pwd)/bin"
mkdir -p "$BIN_DIR"

# --- yt-dlp ---
YTDLP_DEST="$BIN_DIR/yt-dlp"
YTDLP_URL="https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux"

if curl -fsSL --retry 3 --connect-timeout 20 "$YTDLP_URL" -o "$YTDLP_DEST.tmp"; then
  chmod +x "$YTDLP_DEST.tmp"
  mv "$YTDLP_DEST.tmp" "$YTDLP_DEST"
  if "$YTDLP_DEST" --version >/dev/null 2>&1; then
    echo "fetch-ytdlp: installed yt-dlp $("$YTDLP_DEST" --version)"
  else
    echo "fetch-ytdlp: yt-dlp downloaded but not runnable on this platform" >&2
  fi
else
  echo "fetch-ytdlp: yt-dlp download failed — YouTube downloads will be unavailable" >&2
  rm -f "$YTDLP_DEST.tmp"
fi

# --- Deno (JS runtime for YouTube's n challenge) ---
DENO_DEST="$BIN_DIR/deno"
DENO_ZIP="$BIN_DIR/deno.zip"
DENO_URL="https://github.com/denoland/deno/releases/latest/download/deno-x86_64-unknown-linux-gnu.zip"

if curl -fsSL --retry 3 --connect-timeout 30 "$DENO_URL" -o "$DENO_ZIP"; then
  if command -v unzip >/dev/null 2>&1; then
    unzip -oq "$DENO_ZIP" -d "$BIN_DIR" && chmod +x "$DENO_DEST"
  else
    # Nixpacks images don't always ship unzip; python3 comes with yt-dlp's deps.
    python3 -c "import zipfile,sys; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])" "$DENO_ZIP" "$BIN_DIR" \
      && chmod +x "$DENO_DEST"
  fi
  rm -f "$DENO_ZIP"
  if [ -x "$DENO_DEST" ] && "$DENO_DEST" --version >/dev/null 2>&1; then
    echo "fetch-ytdlp: installed $("$DENO_DEST" --version | head -1)"
  else
    echo "fetch-ytdlp: deno downloaded but not runnable — n challenge solving will fail" >&2
  fi
else
  echo "fetch-ytdlp: deno download failed — YouTube downloads will return no formats" >&2
  rm -f "$DENO_ZIP"
fi

exit 0
