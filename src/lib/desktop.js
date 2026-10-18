'use strict';
// Registers StreamSnap with the desktop (app-menu entry + icon) so the window and launcher show its icon.
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const dataHome = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');

function write(file, content, mode) {
  try {
    if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === content) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, { mode });
  } catch { /* read-only home etc.: the app still works without a menu entry */ }
}

function ensureDesktopEntry() {
  if (process.platform !== 'linux') return;
  const script = path.join(root, 'bin', 'streamsnap.js');
  write(path.join(dataHome, 'applications', 'streamsnap.desktop'), `[Desktop Entry]
Type=Application
Name=StreamSnap
Comment=Stream movies and series via Torrentio and Real-Debrid
Exec="${process.execPath}" "${script}"
Icon=streamsnap
StartupWMClass=streamsnap
Terminal=false
Categories=AudioVideo;Video;Player;
`);
  for (const n of [16, 32, 48, 64, 128, 256, 512]) {
    try {
      const dest = path.join(dataHome, 'icons', 'hicolor', `${n}x${n}`, 'apps', 'streamsnap.png');
      const src = fs.readFileSync(path.join(root, 'public', 'icons', `${n}.png`));
      if (!fs.existsSync(dest) || !fs.readFileSync(dest).equals(src)) { fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, src); }
    } catch { /* ignore */ }
  }
  return path.join(dataHome, 'applications', 'streamsnap.desktop');
}

module.exports = { ensureDesktopEntry };
