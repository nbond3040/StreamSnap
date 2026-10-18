# StreamSnap

A Stremio-style streaming app for Linux that uses **Torrentio + Real-Debrid** and automatically picks the best stream **at each available resolution**, **only in your native language**.

It runs as a desktop app: a small Node server on `127.0.0.1` shown in a native Electron window (after `npm install`). Without Electron it falls back to a Chromium/Chrome/Brave/Edge `--app` window, then your default browser. Closing the window quits the app.

**Install ffmpeg** (`sudo apt install ffmpeg`) for the best experience: it lets StreamSnap check each file's real audio tracks, play the track in your language, and convert audio/video formats browsers can't play (AC3/DTS audio, HEVC video) on the fly.

## Run

```sh
npm install                     # once: installs Electron for the native window with the app icon (optional)
node bin/streamsnap.js          # needs Node 20+
./packaging/install.sh          # optional: app-menu launcher + `streamsnap` command
```

Open Settings and enter your Real-Debrid API key (https://real-debrid.com/apitoken). Torrentio has no separate API key: its settings live in its URL, so the key goes into the Torrentio request. If you already have a customised Torrentio install URL, paste it into "Torrentio config URL".

## Features
- Catalogs, search, genres and series/episode browsing (Cinemeta, the same metadata source as Stremio)
- Per-resolution auto-selection (4K / 1080p / 720p / 480p), with alternatives per resolution
- Native-language filter: Torrentio language flags, release-name fallback, optional multi/dual-audio, English untagged handling
- Only Real-Debrid-cached streams by default (instant start); CAM/screener releases dropped; HDR policy; oversized-file penalty
- Built-in player: switch quality mid-playback (swaps the underlying stream and keeps your position), captions off by default with a CC menu, a "Next episode" button in the last minute or so, and an episode/season sidebar
- Optional external playback in mpv or VLC
- Audio verification: with ffmpeg installed, candidates whose audio tracks are all in another language are dropped
- Subtitles in your language (OpenSubtitles addon), library, continue-watching with resume, watched marks
- Keys stay on the server and in `~/.config/streamsnap/config.json` (mode 0600); the browser never sees them

## Test
`npm test`
