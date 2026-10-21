#!/bin/sh
# Builds dist/StreamSnap-<version>-x86_64.AppImage. Needs appimagetool on PATH (or APPIMAGETOOL=/path/to/it).
set -e
SRC="$(cd "$(dirname "$0")/../.." && pwd)"
VERSION="$(node -p "require('$SRC/package.json').version")"
APPDIR="$SRC/dist/StreamSnap.AppDir"
sh "$SRC/packaging/bundle.sh" "$SRC/dist/bundle"
rm -rf "$APPDIR"; mkdir -p "$APPDIR/usr/lib" "$APPDIR/usr/share/metainfo"
cp -a "$SRC/dist/bundle/streamsnap" "$APPDIR/usr/lib/streamsnap"
cp "$SRC/packaging/streamsnap.desktop" "$APPDIR/streamsnap.desktop"
cp "$SRC/public/icons/256.png" "$APPDIR/streamsnap.png"
cp "$SRC/packaging/streamsnap.metainfo.xml" "$APPDIR/usr/share/metainfo/streamsnap.appdata.xml"
cat > "$APPDIR/AppRun" <<'RUN'
#!/bin/sh
HERE="$(dirname "$(readlink -f "$0")")"
# An AppImage can't ship a setuid sandbox helper, so Chromium uses user namespaces or runs unsandboxed (see streamsnap launcher).
exec "$HERE/usr/lib/streamsnap/streamsnap" "$@"
RUN
chmod 755 "$APPDIR/AppRun"
TOOL="${APPIMAGETOOL:-appimagetool}"
OUT="$SRC/dist/StreamSnap-$VERSION-x86_64.AppImage"
ARCH=x86_64 $TOOL --appimage-extract-and-run "$APPDIR" "$OUT" 2>/dev/null || ARCH=x86_64 $TOOL "$APPDIR" "$OUT"
echo "Built $OUT"
