#!/usr/bin/env bash
# Costruisce la versione portable per Windows: dist/NoStream-<versione>-windows-x64.zip
#
# Gira su Linux (GitHub Actions o code-server): Node, ffmpeg e yt-dlp per Windows si
# scaricano già compilati, le dipendenze di NoStream sono solo JavaScript e il programma
# di avvio (Go) si compila per Windows anche da Linux.
#
# Uso: packaging/windows/build-portable.sh [versione]
# Richiede: node/npm, go, curl, unzip, python3.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
VERSION="${1:-$(sed -n "s/^const APP_VERSION = '\(.*\)';/\1/p" "$ROOT/server.js")}"
NODE_MAJOR=22
WORK="$ROOT/build/windows"
OUT="$WORK/NoStream"
CACHE="$WORK/cache"
ZIP="$ROOT/dist/NoStream-$VERSION-windows-x64.zip"

echo "NoStream $VERSION — versione portable per Windows"
rm -rf "$OUT"
mkdir -p "$OUT/app/node" "$OUT/app/bin" "$CACHE" "$ROOT/dist"

fetch() { # url file: scarica una volta sola nella cache
  [ -s "$CACHE/$2" ] || curl -sSfL --retry 3 -o "$CACHE/$2" "$1"
}

# 1. Node per Windows (ultima 22.x)
NODE_ZIP=$(curl -sSfL "https://nodejs.org/dist/latest-v$NODE_MAJOR.x/SHASUMS256.txt" | awk '/win-x64\.zip$/ {print $2}')
fetch "https://nodejs.org/dist/latest-v$NODE_MAJOR.x/$NODE_ZIP" "$NODE_ZIP"
unzip -q -o -j "$CACHE/$NODE_ZIP" "*/node.exe" "*/LICENSE" -d "$OUT/app/node"
echo "  Node: ${NODE_ZIP%.zip}"

# 2. NoStream
cp -r "$ROOT/server.js" "$ROOT/src" "$ROOT/public" "$ROOT/package.json" "$ROOT/package-lock.json" "$ROOT/config.example.json" "$ROOT/LICENSE" "$OUT/app/"
(cd "$OUT/app" && npm ci --omit=dev --no-audit --no-fund --silent)

# 3. ffmpeg 8.1, build LGPL «shared» di BtbN: ffmpeg e ffprobe condividono le stesse DLL
#    (circa 170 MB invece di 200). Basta per copiare video, convertire audio e unire.
FFMPEG_ZIP=ffmpeg-n8.1-latest-win64-lgpl-shared-8.1.zip
fetch "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/$FFMPEG_ZIP" "$FFMPEG_ZIP"
unzip -q -o -j "$CACHE/$FFMPEG_ZIP" "*/bin/ffmpeg.exe" "*/bin/ffprobe.exe" "*/bin/*.dll" "*/LICENSE.txt" -d "$OUT/app/bin"
mv "$OUT/app/bin/LICENSE.txt" "$OUT/app/bin/LICENSE-ffmpeg.txt"
printf '\nffmpeg 8.1 (LGPL), build di https://github.com/BtbN/FFmpeg-Builds - sorgenti: https://ffmpeg.org/download.html\n' >> "$OUT/app/bin/LICENSE-ffmpeg.txt"

# 4. yt-dlp per Windows (non richiede Python; si aggiorna da solo in data\bin)
fetch "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe" yt-dlp.exe
cp "$CACHE/yt-dlp.exe" "$OUT/app/bin/"

# 5. Programma di avvio con icona
(
  cd "$ROOT/packaging/windows/launcher"
  if command -v go-winres >/dev/null 2>&1; then
    go-winres simply --arch amd64 --icon "$ROOT/public/logo-256.png" --manifest cli \
      --product-name NoStream --file-description "NoStream" --product-version "$VERSION" --file-version "${VERSION%%-*}.0" >/dev/null
  fi
  GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o "$OUT/NoStream.exe" .
  rm -f rsrc_windows_*.syso
)

# 6. Istruzioni
cp "$ROOT/packaging/windows/LEGGIMI.txt" "$OUT/LEGGIMI.txt"

# 7. Zip
rm -f "$ZIP"
python3 - "$OUT" "$ZIP" <<'PY'
import os, sys, zipfile
src, dst = sys.argv[1], sys.argv[2]
base = os.path.dirname(src)
with zipfile.ZipFile(dst, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as z:
    for d, _, files in os.walk(src):
        for f in files:
            p = os.path.join(d, f)
            z.write(p, os.path.relpath(p, base))
PY
echo "  Fatto: $ZIP ($(du -h "$ZIP" | cut -f1))"
