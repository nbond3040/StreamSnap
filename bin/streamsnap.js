#!/usr/bin/env node
'use strict';
const { spawn } = require('child_process');
const { createServer } = require('../src/server');

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
if (args.includes('--help') || args.includes('-h')) {
  console.log('Usage: streamsnap [--port 7878] [--no-open]');
  process.exit(0);
}
const port = Number(opt('--port', process.env.STREAMSNAP_PORT || 7878));

createServer(port).listen(port, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${port}/`;
  console.log(`StreamSnap running at ${url}`);
  if (!args.includes('--no-open')) {
    spawn('xdg-open', [url], { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
  }
}).on('error', (e) => {
  console.error(e.code === 'EADDRINUSE' ? `Port ${port} is already in use (is StreamSnap already running?)` : e.message);
  process.exit(1);
});
