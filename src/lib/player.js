'use strict';
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');

function which(bin) {
  for (const d of (process.env.PATH || '').split(path.delimiter)) {
    const p = path.join(d, bin);
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch { /* next */ }
  }
  return null;
}

function available() {
  return { mpv: !!which('mpv'), vlc: !!which('vlc') };
}

function pickPlayer(pref) {
  const a = available();
  if (pref === 'browser') return 'browser';
  if (pref === 'mpv' || pref === 'vlc') return a[pref] ? pref : (a.mpv ? 'mpv' : a.vlc ? 'vlc' : 'browser');
  return a.mpv ? 'mpv' : a.vlc ? 'vlc' : 'browser';
}

/**
 * Launch an external player. For mpv we open an IPC socket and report playback position
 * through onProgress so "continue watching" works like it does in Stremio.
 */
function launch(player, { url, title, subs = [], start = 0, onProgress }) {
  if (player === 'mpv') {
    const sock = path.join(os.tmpdir(), `streamsnap-mpv-${process.pid}-${Date.now()}.sock`);
    const args = ['--force-media-title=' + title, '--input-ipc-server=' + sock, '--save-position-on-quit=no'];
    if (start > 0) args.push('--start=' + Math.floor(start));
    subs.forEach((s) => args.push('--sub-file=' + s));
    args.push('--', url);
    const child = spawn(which('mpv') || 'mpv', args, { stdio: 'ignore' });
    if (onProgress) watchMpv(sock, child, onProgress);
    child.on('error', () => {});
    return child;
  }
  if (player === 'vlc') {
    const args = ['--meta-title=' + title];
    if (start > 0) args.push('--start-time=' + Math.floor(start));
    subs.forEach((s) => args.push('--sub-file=' + s));
    args.push(url);
    const child = spawn(which('vlc') || 'vlc', args, { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
    return child;
  }
  throw new Error('no external player available');
}

function watchMpv(sock, child, onProgress) {
  let pos = 0, dur = 0, conn = null, buf = '';
  const connect = (tries) => {
    conn = net.createConnection(sock);
    conn.on('connect', () => {
      conn.write('{"command":["observe_property",1,"time-pos"]}\n{"command":["observe_property",2,"duration"]}\n');
    });
    conn.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        try {
          const ev = JSON.parse(line);
          if (ev.event === 'property-change' && typeof ev.data === 'number') {
            if (ev.name === 'time-pos') pos = ev.data; else if (ev.name === 'duration') dur = ev.data;
          }
        } catch { /* ignore partial */ }
      }
    });
    conn.on('error', () => { if (tries > 0 && child.exitCode === null) setTimeout(() => connect(tries - 1), 300); });
  };
  setTimeout(() => connect(20), 300);
  const timer = setInterval(() => { if (pos > 0) onProgress(pos, dur); }, 5000);
  child.on('exit', () => {
    clearInterval(timer);
    if (pos > 0) onProgress(pos, dur);
    try { conn && conn.destroy(); fs.unlinkSync(sock); } catch { /* gone */ }
  });
}

module.exports = { available, pickPlayer, launch };
