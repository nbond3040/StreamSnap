# StreamSnap

A Stremio-style streaming app for Linux that uses **Torrentio + Real-Debrid** and automatically picks the best stream **at each available resolution**, **only in your native language**.

It runs as a local app: a small Node server on `127.0.0.1:7878` plus a browser UI. Playback opens in **mpv** or **VLC** if installed (recommended), or inside the window via the browser's player.

## Run

```sh
node bin/streamsnap.js          # needs Node 20+; no npm install required
./packaging/install.sh          # optional: app-menu launcher + `streamsnap` command
```

Open Settings and enter your Real-Debrid API key (https://real-debrid.com/apitoken). Torrentio has no separate API key: its settings live in its URL, so the key goes into the Torrentio request. If you already have a customised Torrentio install URL, paste it into "Torrentio config URL".

## Features
- Catalogs, search, genres and series/episode browsing (Cinemeta, the same metadata source as Stremio)
- Per-resolution auto-selection (4K / 1080p / 720p / 480p), with alternatives per resolution
- Native-language filter: Torrentio language flags, release-name fallback, optional multi/dual-audio, English untagged handling
- Only Real-Debrid-cached streams by default (instant start); CAM/screener releases dropped; HDR policy; oversized-file penalty
- Subtitles in your language (OpenSubtitles addon), library, continue-watching with resume, watched marks
- Keys stay on the server and in `~/.config/streamsnap/config.json` (mode 0600); the browser never sees them

## Test
`npm test`
