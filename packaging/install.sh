#!/bin/sh
# Installs a `streamsnap` launcher and an app-menu entry for the current user.
set -e
SRC="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$HOME/.local/bin" "$HOME/.local/share/applications"
printf '#!/bin/sh\nexec node "%s/bin/streamsnap.js" "$@"\n' "$SRC" > "$HOME/.local/bin/streamsnap"
chmod +x "$HOME/.local/bin/streamsnap"
cat > "$HOME/.local/share/applications/streamsnap.desktop" <<DESK
[Desktop Entry]
Type=Application
Name=StreamSnap
Comment=Stream movies and series via Torrentio and Real-Debrid
Exec=$HOME/.local/bin/streamsnap
Terminal=false
Categories=AudioVideo;Video;
DESK
echo "Installed. Run 'streamsnap' or find StreamSnap in your app menu."
