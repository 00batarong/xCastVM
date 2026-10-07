(() => {
'use strict';
const $ = s => document.querySelector(s);
const audio = $('#audio');

let tracks = [];                       // whole library
let view = { kind: 'all', value: null };
let shown = [];                        // what the list currently shows
let queue = [], qi = -1;               // what is actually playing
let shuffle = false, repeat = 0;       // repeat: 0 off, 1 all, 2 one
let dragging = false;
let ctx = null, analyser = null, raf = 0;
let vizHue = 190;

const fmt = s => {
  if (!isFinite(s)) return '0:00';
  s = Math.floor(s);
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
};

/* ---------- library ---------- */
async function load(rescan) {
  const r = await fetch(rescan ? '/api/rescan' : '/api/library');
  if (r.status === 401) { location.href = '/login.html'; return; }
  const d = await r.json();
  tracks = d.tracks.map(t => ({ ...t, ak: t.artist + ' \u2014 ' + t.album }));
  const empty = $('#empty');
  empty.hidden = tracks.length > 0;
  empty.textContent = 'No music found. Put audio files in ' + d.musicDir + ' and press Rescan.';
  view = { kind: 'all', value: null };
  buildTree();
  render();
}

function groupBy(key) {
  const m = new Map();
  for (const t of tracks) m.set(t[key], (m.get(t[key]) || 0) + 1);
  return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

function treeItem(label, kind, value, count) {
  const li = document.createElement('li');
  const b = document.createElement('button');
  b.dataset.kind = kind;
  b.dataset.value = value ?? '';
  const a = document.createElement('span'); a.textContent = label;
  const c = document.createElement('span'); c.textContent = count;
  b.append(a, c);
  b.onclick = () => {
    view = { kind, value };
    document.body.classList.remove('pane-open');
    switchView('library');
    render();
  };
  li.append(b);
  return li;
}

function buildTree() {
  const ul = $('#tree');
  ul.replaceChildren(treeItem('All Music', 'all', null, tracks.length));
  for (const [title, kind, key] of [['Artists', 'artist', 'artist'], ['Albums', 'album', 'ak']]) {
    const li = document.createElement('li');
    const d = document.createElement('details');
    d.open = kind === 'artist';
    const s = document.createElement('summary'); s.textContent = title;
    const inner = document.createElement('ul');
    for (const [name, n] of groupBy(key)) inner.append(treeItem(name, kind, name, n));
    d.append(s, inner);
    li.append(d);
    ul.append(li);
  }
}

function render() {
  const q = $('#search').value.trim().toLowerCase();
  shown = tracks.filter(t =>
    (view.kind === 'all' || (view.kind === 'artist' && t.artist === view.value) || (view.kind === 'album' && t.ak === view.value)) &&
    (!q || (t.title + ' ' + t.artist + ' ' + t.album).toLowerCase().includes(q)));
  $('#crumb').textContent = (view.kind === 'all' ? 'All Music' : view.value) + '  (' + shown.length + ')';
  document.querySelectorAll('#tree button').forEach(b =>
    b.classList.toggle('active', b.dataset.kind === view.kind && b.dataset.value === (view.value ?? '')));
  const tb = $('#list tbody');
  tb.replaceChildren();
  shown.forEach((t, i) => {
    const tr = document.createElement('tr');
    tr.tabIndex = 0;
    tr.dataset.id = t.id;
    for (const v of [i + 1, t.title, t.artist, t.album, t.duration ? fmt(t.duration) : '', t.ext]) {
      const td = document.createElement('td'); td.textContent = v; tr.append(td);
    }
    tr.onclick = () => play(i);
    tr.onkeydown = e => { if (e.key === 'Enter') play(i); };
    tb.append(tr);
  });
  markPlaying();
}

function markPlaying() {
  const id = queue[qi] ? String(queue[qi].id) : null;
  document.querySelectorAll('#list tbody tr').forEach(tr => tr.classList.toggle('playing', tr.dataset.id === id));
}

/* ---------- playback ---------- */
function play(i, fromQueue) {
  if (!fromQueue) queue = shown.slice();
  qi = i;
  const t = queue[qi];
  if (!t) return;
  audio.src = '/stream/' + t.id;
  audio.play().catch(() => {});
  $('#miniTitle').textContent = $('#npTitle').textContent = t.title;
  $('#miniArtist').textContent = $('#npArtist').textContent = t.artist;
  $('#npAlbum').textContent = t.album;
  const img = $('#cover');
  img.hidden = false;
  img.onerror = () => { img.hidden = true; };
  img.src = '/cover/' + t.id;
  document.title = t.title + ' - xCast Player';
  if ('mediaSession' in navigator && window.MediaMetadata) {
    navigator.mediaSession.metadata = new MediaMetadata({ title: t.title, artist: t.artist, album: t.album, artwork: [{ src: '/cover/' + t.id }] });
  }
  markPlaying();
}

function next(auto) {
  if (!queue.length) return;
  if (auto && repeat === 2) { audio.currentTime = 0; audio.play(); return; }
  let n;
  if (shuffle && queue.length > 1) { do { n = Math.floor(Math.random() * queue.length); } while (n === qi); }
  else n = qi + 1;
  if (n >= queue.length) {
    if (repeat === 1 || !auto) n = 0; else { stop(); return; }
  }
  play(n, true);
}

function prev() {
  if (!queue.length) return;
  if (audio.currentTime > 3) { audio.currentTime = 0; return; }
  play(qi > 0 ? qi - 1 : queue.length - 1, true);
}

function stop() { audio.pause(); audio.currentTime = 0; }

function toggle() {
  if (!audio.src) { if (shown.length) play(0); return; }
  if (audio.paused) audio.play().catch(() => {}); else audio.pause();
}

audio.addEventListener('play', () => $('#bPlay').classList.add('playing-state'));
audio.addEventListener('pause', () => $('#bPlay').classList.remove('playing-state'));
audio.addEventListener('ended', () => next(true));
audio.addEventListener('loadedmetadata', () => { $('#tDur').textContent = fmt(audio.duration); });
audio.addEventListener('timeupdate', () => {
  $('#tCur').textContent = fmt(audio.currentTime);
  if (!dragging && audio.duration) $('#seek').value = (audio.currentTime / audio.duration) * 1000;
});

$('#seek').addEventListener('input', e => {
  dragging = true;
  if (audio.duration) {
    audio.currentTime = (e.target.value / 1000) * audio.duration;
    $('#tCur').textContent = fmt(audio.currentTime);
  }
});
$('#seek').addEventListener('change', () => { dragging = false; });

$('#vol').addEventListener('input', e => { audio.volume = e.target.value / 100; });
audio.volume = 0.8;

$('#bPlay').onclick = toggle;
$('#bPrev').onclick = prev;
$('#bNext').onclick = () => next(false);
$('#bStop').onclick = stop;
$('#bShuffle').onclick = e => { shuffle = !shuffle; e.currentTarget.classList.toggle('on', shuffle); };
$('#bRepeat').onclick = e => {
  repeat = (repeat + 1) % 3;
  e.currentTarget.classList.toggle('on', repeat > 0);
  e.currentTarget.classList.toggle('one', repeat === 2);
};

if ('mediaSession' in navigator) {
  const h = (a, f) => { try { navigator.mediaSession.setActionHandler(a, f); } catch (e) {} };
  h('play', () => audio.play());
  h('pause', () => audio.pause());
  h('previoustrack', prev);
  h('nexttrack', () => next(false));
}

document.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT') return;
  if (e.code === 'Space') { e.preventDefault(); toggle(); }
  else if (e.key === 'MediaTrackNext') next(false);
  else if (e.key === 'MediaTrackPrevious') prev();
});

/* ---------- views, search, pane ---------- */
function switchView(name) {
  document.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('active', b.dataset.view === name));
  $('#libraryView').hidden = name !== 'library';
  $('#nowView').hidden = name !== 'now';
  cancelAnimationFrame(raf);
  if (name === 'now') { setupAnalyser(); drawViz(); }
}
document.querySelectorAll('.tabs button').forEach(b => { b.onclick = () => switchView(b.dataset.view); });
$('#search').addEventListener('input', render);
$('#paneBtn').onclick = () => document.body.classList.toggle('pane-open');
$('#rescan').onclick = () => load(true);

/* ---------- visualizer (only wired up when Now Playing is opened) ---------- */
function setupAnalyser() {
  if (ctx) { ctx.resume().catch(() => {}); return; }
  try {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    const src = ctx.createMediaElementSource(audio);
    analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    src.connect(analyser);
    analyser.connect(ctx.destination);
  } catch (e) { ctx = null; analyser = null; }
}

function drawViz() {
  const c = $('#viz'), g = c.getContext('2d');
  const buf = new Uint8Array(analyser ? analyser.frequencyBinCount : 0);
  const loop = () => {
    if ($('#nowView').hidden) return;
    const w = c.width = c.clientWidth, h = c.height = c.clientHeight;
    g.clearRect(0, 0, w, h);
    if (analyser) {
      analyser.getByteFrequencyData(buf);
      const n = 48, bw = w / n;
      for (let i = 0; i < n; i++) {
        const v = buf[Math.floor(i * buf.length * 0.75 / n)] / 255;
        const bh = Math.max(3, v * h * 0.85);
        g.fillStyle = 'hsl(' + (vizHue + i * 3) + ',90%,' + (38 + v * 28) + '%)';
        g.fillRect(i * bw + 2, h - bh, bw - 4, bh);
      }
    }
    raf = requestAnimationFrame(loop);
  };
  loop();
}

/* ---------- themes ---------- */
function readHue() {
  const h = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--viz-hue'), 10);
  vizHue = isNaN(h) ? 190 : h;
}
const themeSel = $('#theme');
themeSel.value = document.documentElement.dataset.theme || 'blue';
if (themeSel.value !== document.documentElement.dataset.theme) themeSel.value = 'blue';
themeSel.addEventListener('change', () => {
  document.documentElement.dataset.theme = themeSel.value;
  try { localStorage.setItem('xcast-theme', themeSel.value); } catch (e) {}
  readHue();
});
readHue();

load(false);
})();
