#!/bin/sh
# Builds the self-contained app tree every package format wraps:
#   <out>/streamsnap/{streamsnap, electron/, app/}   (Electron is bundled, so no system Node.js is needed)
# Usage: packaging/bundle.sh [outdir]   (default: dist/bundle)
set -e
SRC="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${1:-$SRC/dist/bundle}"
ROOT="$OUT/streamsnap"
rm -rf "$OUT"; mkdir -p "$ROOT/app"

ELECTRON="$SRC/node_modules/electron/dist"
if [ ! -x "$ELECTRON/electron" ]; then
  (cd "$SRC" && npm install --no-audit --no-fund) || true
fi
[ -x "$ELECTRON/electron" ] || { echo "Electron isn't installed (run npm install in $SRC)." >&2; exit 1; }

cp -a "$ELECTRON" "$ROOT/electron"
for d in bin desktop public src; do cp -a "$SRC/$d" "$ROOT/app/$d"; done
cp "$SRC/package.json" "$SRC/README.md" "$ROOT/app/" 2>/dev/null || true
# the server has no runtime dependencies, so no node_modules are needed beside it

cat > "$ROOT/streamsnap" <<'LAUNCH'
#!/bin/sh
# Starts StreamSnap with the bundled Electron.
HERE="$(dirname "$(readlink -f "$0")")"
export STREAMSNAP_NO_DESKTOP=1
# Chromium's sandbox needs either the setuid helper or unprivileged user namespaces; without the helper set up, skip it.
# (The window only ever loads StreamSnap's own local page; links open in your browser.)
[ -u "$HERE/electron/chrome-sandbox" ] || set -- --no-sandbox "$@"
exec "$HERE/electron/electron" "$HERE/app/desktop/main.cjs" "$@"
LAUNCH
chmod 755 "$ROOT/streamsnap"
echo "Bundle ready: $ROOT ($(du -sh "$ROOT" | cut -f1))"
