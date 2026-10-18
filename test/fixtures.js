'use strict';
// Raw Torrentio-shaped stream objects.
const mk = (res, rd, lines, extra = {}) => ({
  name: `Torrentio\n${rd}${res}`,
  title: lines,
  url: `https://torrentio.test/resolve/realdebrid/KEY/${Buffer.from(lines).toString('hex').slice(0, 16)}/null/0/f.mkv`,
  behaviorHints: {},
  ...extra,
});
module.exports = [
  mk('1080p', '[RD+] ', 'Movie.2020.1080p.BluRay.x264-GRP\n👤 120 💾 8.2 GB ⚙️ YTS'),
  mk('1080p', '[RD+] ', 'Movie.2020.1080p.WEB-DL.x265-GRP\n👤 900 💾 3.1 GB ⚙️ TPB'),
  mk('1080p', '[RD+] ', 'Movie.2020.FRENCH.1080p.BluRay.x264\n👤 800 💾 7 GB ⚙️ TPB\n🇫🇷'),
  mk('1080p', '[RD+] ', 'Movie.2020.MULTi.1080p.BluRay\n👤 50 💾 9 GB ⚙️ TPB\nMulti Audio'),
  mk('1080p', '[RD download] ', 'Movie.2020.1080p.WEB\n👤 5000 💾 5 GB ⚙️ TPB'),
  mk('720p', '[RD+] ', 'Movie.2020.720p.WEBRip.x264\n👤 30 💾 1.2 GB ⚙️ TPB\n🇬🇧'),
  mk('4k', '[RD+] ', 'Movie.2020.2160p.UHD.BluRay.REMUX.HDR\n👤 40 💾 55 GB ⚙️ TPB'),
  mk('480p', '[RD+] ', 'Movie.2020.480p.GERMAN.DVDRip\n👤 90 💾 1 GB ⚙️ TPB\n🇩🇪'),
  mk('1080p', '[RD+] ', 'Movie.2020.1080p.HDCAM\n👤 999 💾 2 GB ⚙️ TPB'),
  { name: 'Torrentio\n1080p', title: 'magnet only\n👤 1 💾 1 GB ⚙️ X', infoHash: 'abc' },
];
