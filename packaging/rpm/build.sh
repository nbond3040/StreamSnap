#!/bin/sh
# Builds dist/rpm/RPMS/x86_64/streamsnap-<version>-1.*.rpm (needs rpmbuild).
set -e
SRC="$(cd "$(dirname "$0")/../.." && pwd)"
VERSION="$(node -p "require('$SRC/package.json').version")"
sh "$SRC/packaging/bundle.sh" "$SRC/dist/bundle"
T="$SRC/dist/rpm"; rm -rf "$T"; for d in SOURCES BUILD RPMS SRPMS SPECS stage/streamsnap-bundle/icons; do mkdir -p "$T/$d"; done
cp -a "$SRC/dist/bundle/streamsnap" "$T/stage/streamsnap-bundle/streamsnap"
cp "$SRC/packaging/streamsnap.desktop" "$SRC/packaging/streamsnap.metainfo.xml" "$SRC/public/icon.svg" "$T/stage/streamsnap-bundle/"
for n in 16 32 48 64 128 256 512; do cp "$SRC/public/icons/$n.png" "$T/stage/streamsnap-bundle/icons/"; done
tar -C "$T/stage" -czf "$T/SOURCES/streamsnap-bundle.tar.gz" streamsnap-bundle
rpmbuild -bb --define "_topdir $T" --define "pkg_version $VERSION" "$SRC/packaging/rpm/streamsnap.spec"
ls "$T"/RPMS/*/*.rpm
