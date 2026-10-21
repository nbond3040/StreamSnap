'use strict';
/**
 * StreamSnap desktop shell: starts the local server in-process and shows it in a native window with the
 * app icon. Used automatically by `streamsnap` when Electron is installed (`npm install`).
 *   --smoke-test   load the UI, print SMOKE OK and exit
 */
const { app, BrowserWindow, Menu, screen, shell } = require('electron');
const net = require('node:net');
const path = require('node:path');

const SMOKE = process.argv.includes('--smoke-test');
const ICON = path.join(__dirname, '..', 'public', 'icons', '512.png');

app.setName('StreamSnap');
app.setDesktopName('streamsnap.desktop');
app.commandLine.appendSwitch('class', 'streamsnap'); // lets the desktop match the window to the menu entry and icon
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
// Hardware video decoding on Linux; software decoding of big 1080p/4K files is what makes video lag behind audio.
app.commandLine.appendSwitch('enable-features', 'VaapiVideoDecoder,VaapiVideoDecodeLinuxGL,VaapiIgnoreDriverChecks');
app.commandLine.appendSwitch('ignore-gpu-blocklist');

if (!SMOKE && !app.requestSingleInstanceLock()) app.quit();

function freePort(preferred) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => { const t = net.createServer(); t.listen(0, '127.0.0.1', () => { const p = t.address().port; t.close(() => resolve(p)); }); });
    s.listen(preferred, '127.0.0.1', () => s.close(() => resolve(preferred)));
  });
}

let win = null;
async function start() {
  const port = await freePort(Number(process.env.STREAMSNAP_PORT || 7878));
  const server = require('../src/server').createServer(port);
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  const url = `http://127.0.0.1:${port}/`;
  Menu.setApplicationMenu(null);
  win = new BrowserWindow({
    width: 1360, height: 860, minWidth: 900, minHeight: 600, title: 'StreamSnap', icon: ICON,
    backgroundColor: '#0b0b10', autoHideMenuBar: true, show: SMOKE,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  win.once('ready-to-show', () => win.show());
  win.webContents.setWindowOpenHandler(({ url: u }) => {
    if (u.startsWith(url + '#/popout/')) return { action: 'allow', overrideBrowserWindowOptions: popoutOptions() };
    if (/^https?:/.test(u)) shell.openExternal(u);
    return { action: 'deny' };
  });
  /** A pop-out opens on another monitor when there is one (otherwise beside the main window). */
  function popoutOptions() {
    const here = screen.getDisplayMatching(win.getBounds());
    const other = screen.getAllDisplays().find((d) => d.id !== here.id);
    const area = (other || here).workArea, w = Math.min(1280, area.width - 80), h = Math.min(720, area.height - 80);
    return {
      width: w, height: h, x: area.x + Math.round((area.width - w) / 2), y: area.y + Math.round((area.height - h) / 2),
      backgroundColor: '#000000', autoHideMenuBar: true, title: 'StreamSnap', icon: ICON,
      webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
    };
  }
  win.on('closed', () => app.quit()); // closing the main window ends the app, pop-outs included
  win.webContents.on('will-navigate', (e, u) => { if (!u.startsWith(url)) { e.preventDefault(); shell.openExternal(u); } });
  win.on('page-title-updated', (e) => e.preventDefault());
  await win.loadURL(url);
  if (process.argv.includes('--smoke-popout')) {
    let opened = 0;
    app.on('browser-window-created', () => { opened++; });
    await win.webContents.executeJavaScript(`(() => { window.open(location.origin + '/#/popout/live/1', '_blank', 'popup'); return 1; })()`, true);
    await new Promise((r) => setTimeout(r, 2500));
    console.log(BrowserWindow.getAllWindows().length === 2 ? 'POPOUT OK' : `POPOUT FAIL (${BrowserWindow.getAllWindows().length} windows)`);
    app.exit(BrowserWindow.getAllWindows().length === 2 ? 0 : 1);
  }
  if (SMOKE) {
    const ok = await win.webContents.executeJavaScript("!!document.querySelector('#top') && typeof Player === 'object' && !!document.querySelector('#view')");
    console.log(ok ? 'SMOKE OK' : 'SMOKE FAIL');
    app.exit(ok ? 0 : 1);
  }
}

app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
app.on('window-all-closed', () => app.quit());
app.whenReady().then(start);
