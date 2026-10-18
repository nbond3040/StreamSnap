#!/bin/sh
# Adds StreamSnap (icon + app-menu entry) for the current user, plus a `streamsnap` command.
set -e
SRC="$(cd "$(dirname "$0")/.." && pwd)"
(cd "$SRC" && npm install --omit=dev --no-audit --no-fund) || echo "npm install failed: StreamSnap will use a Chromium/Chrome window instead of Electron."
node "$SRC/bin/streamsnap.js" --install
mkdir -p "$HOME/.local/bin"
printf '#!/bin/sh\nexec node "%s/bin/streamsnap.js" "$@"\n' "$SRC" > "$HOME/.local/bin/streamsnap"
chmod +x "$HOME/.local/bin/streamsnap"
echo "Done. Run 'streamsnap' or find StreamSnap in your app menu (you may need to log out/in for the menu to refresh)."
