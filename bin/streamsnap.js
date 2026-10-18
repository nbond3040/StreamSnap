#!/usr/bin/env node
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const config = require('../src/lib/config');
const { createServer } = require('../src/server');
const { which } = require('../src/lib/player');
const { ensureDesktopEntry } = require('../src/lib/desktop');

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
if (args.includes('--help') || args.includes('-h')) {
  console.log('Usage: streamsnap [--port 7878] [--no-open] [--browser] [--install]\n  --install  add StreamSnap (with icon) to the app menu and exit\n  --no-open  only start the server\n  --browser  open in your default browser instead of an app window');
  process.exit(0);
}
if (args.includes('--install')) {
  console.log('Installed app-menu entry:', ensureDesktopEntry() || '(not supported on this OS)');
  process.exit(0);
}
if (!process.env.STREAMSNAP_NO_DESKTOP) ensureDesktopEntry(); // keeps the menu entry and icon current
const port = Number(opt('--port', process.env.STREAMSNAP_PORT || 7878));
const BROWSERS = ['google-chrome-stable', 'google-chrome', 'chromium', 'chromium-browser', 'brave-browser', 'microsoft-edge', 'vivaldi'];

/** Open the UI in a dedicated, chrome-less app window (Chromium --app mode) when one is installed. */
function openWindow(url) {
  const bin = !args.includes('--browser') && BROWSERS.map(which).find(Boolean);
  if (!bin) {
    spawn('xdg-open', [url], { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
    return null;
  }
  return spawn(bin, [
    `--app=${url}`, `--user-data-dir=${path.join(config.dir, 'window-profile')}`, '--class=StreamSnap',
    '--window-size=1360,860', '--autoplay-policy=no-user-gesture-required',
    '--enable-features=VaapiVideoDecoder,VaapiVideoDecodeLinuxGL,VaapiIgnoreDriverChecks', '--ignore-gpu-blocklist', '--no-first-run', '--no-default-browser-check',
  ], { stdio: 'ignore' });
}

/** Native window via Electron when it's installed (npm install). Retries without the sandbox if the OS blocks it. */
function runElectron() {
  let electron;
  try { electron = require('electron'); } catch { return false; }
  if (typeof electron !== 'string' || args.includes('--browser')) return false;
  const main = path.join(__dirname, '..', 'desktop', 'main.cjs');
  const launch = (extra) => {
    const started = Date.now();
    const child = spawn(electron, [...extra, main], { stdio: 'inherit', env: { ...process.env, STREAMSNAP_PORT: String(port) } });
    child.on('exit', (code, signal) => {
      if ((code || signal) && Date.now() - started < 8000 && !extra.length) return launch(['--no-sandbox']); // userns/SUID sandbox unavailable
      process.exit(code || 0);
    });
  };
  launch([]);
  return true;
}

if (!args.includes('--no-open') && runElectron()) return;

const server = createServer(port);
server.listen(port, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${port}/`;
  console.log(`StreamSnap running at ${url}`);
  if (args.includes('--no-open')) return;
  const win = openWindow(url);
  // Closing the app window quits StreamSnap, like a normal desktop app.
  if (win) win.on('exit', () => { server.closeAllConnections(); process.exit(0); });
}).on('error', (e) => {
  console.error(e.code === 'EADDRINUSE' ? `Port ${port} is already in use (is StreamSnap already running?)` : e.message);
  process.exit(1);
});
