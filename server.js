// xCast Player server
// Usage:  node server.js [music folder]      (default: .\music)
// Then open  http://<this PC's IP>:16610  on your phone or TV.
// Reads real tags (ID3, MP4, FLAC, Ogg...) with the "music-metadata" package.
// If it isn't installed, falls back to guessing from file names.

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const https = require('https');

const PORT = Number(process.env.PORT) || 16610;
const PUBLIC = path.join(__dirname, 'public');
const MUSIC_DIR = path.resolve(process.argv[2] || process.env.MUSIC_DIR || path.join(__dirname, 'music'));
const CACHE_FILE = path.join(__dirname, 'tagcache.json');

const AUDIO = {
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.flac': 'audio/flac',
  '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.opus': 'audio/ogg', '.wav': 'audio/wav', '.weba': 'audio/webm',
};
const STATIC = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
};

let mm = null;                 // music-metadata module
let library = [];              // [{id, file, title, artist, album, track, duration, ext}]
let cache = {};                // tag cache so rescans are fast
const coverCache = new Map();

try { cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch { cache = {}; }

async function loadMM() {
  try { mm = await import('music-metadata'); }
  catch { console.log('\n!! music-metadata is not installed, so only file names are used.\n!! Run:  npm install music-metadata\n'); }
}

/* ---------- scanning ---------- */
async function walk(dir, out) {
  let entries;
  try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await walk(full, out);
    else if (AUDIO[path.extname(e.name).toLowerCase()]) out.push(full);
  }
}

const clean = s => (typeof s === 'string' ? s.trim() : '');

async function readTags(file, nextCache) {
  if (!mm) return {};
  try {
    const st = await fs.promises.stat(file);
    const key = file + '|' + st.size + '|' + st.mtimeMs;
    if (cache[key]) { nextCache[key] = cache[key]; return cache[key]; }
    const { common, format } = await mm.parseFile(file, { skipCovers: true });
    const meta = {
      title: clean(common.title),
      artist: clean(common.artist) || clean((common.artists || []).join(', ')) || clean(common.albumartist),
      album: clean(common.album),
      track: (common.track && common.track.no) || 0,
      duration: format.duration ? Math.round(format.duration) : 0,
    };
    nextCache[key] = meta;
    return meta;
  } catch { return {}; }
}

// Fallback guess used only for fields the tags don't have.
function guess(file) {
  const parts = path.relative(MUSIC_DIR, file).split(path.sep);
  const ext = path.extname(file);
  let artist = 'Unknown Artist';
  let album = 'Unknown Album';
  if (parts.length >= 3) { artist = parts[parts.length - 3]; album = parts[parts.length - 2]; }
  else if (parts.length === 2) { artist = parts[0]; }
  let title = path.basename(file, ext).replace(/^\d{1,3}\s*[-._]\s*/, '');
  const m = title.match(/^(.+?)\s+-\s+(.+)$/);
  if (m && artist === 'Unknown Artist') { artist = m[1]; title = m[2]; }
  return { title, artist, album, ext: ext.slice(1).toLowerCase() };
}

async function scan() {
  const files = [];
  await walk(MUSIC_DIR, files);
  const next = {};
  const items = [];
  for (let i = 0; i < files.length; i += 8) {
    const batch = files.slice(i, i + 8);
    const metas = await Promise.all(batch.map(f => readTags(f, next)));
    batch.forEach((f, j) => {
      const g = guess(f), t = metas[j];
      items.push({
        file: f,
        title: t.title || g.title,
        artist: t.artist || g.artist,
        album: t.album || g.album,
        track: t.track || 0,
        duration: t.duration || 0,
        ext: g.ext,
      });
    });
  }
  cache = next;
  fs.writeFile(CACHE_FILE, JSON.stringify(cache), () => {});
  items.sort((a, b) =>
    a.artist.localeCompare(b.artist) || a.album.localeCompare(b.album) ||
    (a.track - b.track) || a.file.localeCompare(b.file, undefined, { numeric: true }));
  library = items.map((t, i) => ({ id: i, ...t }));
  coverCache.clear();
  console.log(`Scanned ${library.length} tracks in ${MUSIC_DIR}`);
}

/* ---------- cover art (read on demand) ---------- */
async function getCover(t) {
  if (!mm) return null;
  if (coverCache.has(t.id)) return coverCache.get(t.id);
  let cover = null;
  try {
    const { common } = await mm.parseFile(t.file);
    const p = common.picture && common.picture[0];
    if (p) cover = { type: p.format || 'image/jpeg', data: Buffer.from(p.data) };
  } catch {}
  if (coverCache.size > 30) coverCache.delete(coverCache.keys().next().value);
  coverCache.set(t.id, cover);
  return cover;
}

/* ---------- config, login, DuckDNS ---------- */
let config = { password: '', duckdns: { domain: '', token: '' } };
try { config = { ...config, ...JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8')) }; }
catch { console.log('No valid config.json found - running without a password.'); }

const sessions = new Set();
const fails = new Map(); // ip -> { n, until }

const sha = s => crypto.createHash('sha256').update(String(s)).digest();
const passOk = given => crypto.timingSafeEqual(sha(given), sha(config.password));

function cookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}
const authed = req => !config.password || sessions.has(cookies(req).xcast);

function handleLogin(req, res) {
  const ip = req.socket.remoteAddress;
  const f = fails.get(ip) || { n: 0, until: 0 };
  if (Date.now() < f.until) { res.writeHead(429); return res.end('Too many attempts. Wait a minute.'); }
  let body = '';
  req.on('data', c => { body += c; if (body.length > 2000) req.destroy(); });
  req.on('end', () => {
    let pw = '';
    try { pw = JSON.parse(body).password || ''; } catch {}
    if (config.password && passOk(pw)) {
      fails.delete(ip);
      const token = crypto.randomBytes(24).toString('hex');
      sessions.add(token);
      res.writeHead(200, { 'Set-Cookie': `xcast=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000`, 'Content-Type': 'application/json' });
      return res.end('{"ok":true}');
    }
    f.n++;
    if (f.n >= 5) { f.n = 0; f.until = Date.now() + 60000; }
    fails.set(ip, f);
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end('{"ok":false}');
  });
}

function startDuckDns() {
  const d = config.duckdns || {};
  const domain = String(d.domain || '').replace(/\.duckdns\.org$/i, '').trim();
  if (!domain || !d.token) return;
  if (!config.password) console.log('WARNING: DuckDNS is on but no password is set - anyone who finds the address can use your library.');
  const update = () => {
    const url = `https://www.duckdns.org/update?domains=${encodeURIComponent(domain)}&token=${encodeURIComponent(d.token)}&ip=`;
    https.get(url, r => {
      let b = '';
      r.on('data', c => { b += c; });
      r.on('end', () => console.log(`DuckDNS update for ${domain}.duckdns.org: ${b.trim()}`));
    }).on('error', e => console.log('DuckDNS update failed:', e.message));
  };
  update();
  setInterval(update, 5 * 60 * 1000);
  console.log(`DuckDNS: keeping ${domain}.duckdns.org updated every 5 minutes.`);
}

/* ---------- http ---------- */
function sendJson(res, obj) {
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function libraryPayload() {
  return {
    musicDir: MUSIC_DIR,
    tracks: library.map(({ id, title, artist, album, track, duration, ext }) => ({ id, title, artist, album, track, duration, ext })),
  };
}

function streamFile(req, res, file) {
  fs.stat(file, (err, st) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    const type = AUDIO[path.extname(file).toLowerCase()] || 'application/octet-stream';
    const headers = { 'Content-Type': type, 'Accept-Ranges': 'bytes' };
    let start = 0, end = st.size - 1, status = 200;
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (m) {
      if (m[1] === '' && m[2] !== '') { start = Math.max(0, st.size - parseInt(m[2], 10)); }
      else {
        if (m[1] !== '') start = parseInt(m[1], 10);
        if (m[2] !== '') end = Math.min(end, parseInt(m[2], 10));
      }
      if (start > end || start >= st.size) {
        res.writeHead(416, { 'Content-Range': `bytes */${st.size}` });
        return res.end();
      }
      status = 206;
      headers['Content-Range'] = `bytes ${start}-${end}/${st.size}`;
    }
    headers['Content-Length'] = end - start + 1;
    res.writeHead(status, headers);
    if (req.method === 'HEAD') return res.end();
    const rs = fs.createReadStream(file, { start, end });
    rs.on('error', () => res.destroy());
    res.on('close', () => rs.destroy());
    rs.pipe(res);
  });
}

function serveStatic(res, pathname) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + path.sep)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': STATIC[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/login' && req.method === 'POST') return handleLogin(req, res);
    if (!authed(req) && url.pathname !== '/login.html') {
      if (/^\/(api|stream|cover)(\/|$)/.test(url.pathname)) { res.writeHead(401); return res.end('Login required'); }
      res.writeHead(302, { Location: '/login.html' });
      return res.end();
    }
    if (url.pathname === '/api/library') return sendJson(res, libraryPayload());
    if (url.pathname === '/api/rescan') { await scan(); return sendJson(res, libraryPayload()); }
    let m = /^\/stream\/(\d+)$/.exec(url.pathname);
    if (m) {
      const t = library[Number(m[1])];
      if (!t) { res.writeHead(404); return res.end('Not found'); }
      return streamFile(req, res, t.file);
    }
    m = /^\/cover\/(\d+)$/.exec(url.pathname);
    if (m) {
      const t = library[Number(m[1])];
      const c = t && await getCover(t);
      if (!c) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': c.type, 'Cache-Control': 'max-age=3600' });
      return res.end(c.data);
    }
    serveStatic(res, url.pathname);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) res.writeHead(500);
    res.end('Server error');
  }
});

loadMM().then(scan).then(() => {
  server.listen(PORT, '0.0.0.0', () => {
    startDuckDns();
    console.log('\nxCast Player is running. Open one of these on your phone or TV:');
    for (const list of Object.values(os.networkInterfaces())) {
      for (const a of list || []) if (a.family === 'IPv4' && !a.internal) console.log(`  http://${a.address}:${PORT}`);
    }
    console.log(`  http://localhost:${PORT}  (this PC)\n`);
  });
});
