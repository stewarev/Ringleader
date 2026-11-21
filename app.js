// RingLeader — offline game-day soundboard.
// Storage: IndexedDB ('kv' = board config, 'audio' = sound files as ArrayBuffers).
// Playback: one <audio> element per button, pre-seeked to its start point,
// routed through a Web Audio gain node so STOP/FADE can ramp volume (iOS ignores element.volume).

const $ = (s) => document.querySelector(s);
const COLORS = ['#e5262b', '#f08c00', '#e0b000', '#2f9e44', '#0ca678', '#1c7ed6', '#5f3dc4', '#c2255c', '#495057', '#000000'];

const DEFAULT_SETTINGS = { wake: true, speaker: false, stopFade: 0.08, fade: 2, cols: 'auto' };
let board = { buttons: [], settings: { ...DEFAULT_SETTINGS } };
let editing = false;

// ---------- IndexedDB ----------
let db;
function openDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('ringleader', 1);
    r.onupgradeneeded = () => { r.result.createObjectStore('kv'); r.result.createObjectStore('audio'); };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
function idb(store, mode, fn) {
  return new Promise((res, rej) => {
    const t = db.transaction(store, mode);
    const r = fn(t.objectStore(store));
    t.oncomplete = () => res(r && r.result);
    t.onerror = t.onabort = () => rej(t.error);
  });
}
const kvGet = (k) => idb('kv', 'readonly', (s) => s.get(k));
const kvSet = (k, v) => idb('kv', 'readwrite', (s) => s.put(v, k));
const audioGet = (id) => idb('audio', 'readonly', (s) => s.get(id));
const audioSet = (id, rec) => idb('audio', 'readwrite', (s) => s.put(rec, id));
const audioDel = (id) => idb('audio', 'readwrite', (s) => s.delete(id));
const audioClear = () => idb('audio', 'readwrite', (s) => s.clear());
const saveBoard = () => kvSet('board', board);

// ---------- Utils ----------
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
function parseTime(str) {
  str = String(str ?? '').trim();
  if (!str) return null;
  const parts = str.split(':').map(Number);
  if (parts.some((n) => Number.isNaN(n))) return NaN;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}
function fmt(sec) {
  if (sec == null || !Number.isFinite(sec)) return '';
  const m = Math.floor(sec / 60), s = sec - m * 60;
  return `${m}:${s < 10 ? '0' : ''}${s.toFixed(1).replace(/\.0$/, '')}`;
}
let toastTimer;
function toast(msg, ms = 2200) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

// ---------- Audio engine ----------
let ctx, master, keepAliveGain;
const players = new Map(); // buttonId -> { el, url, gain, node, stopToken }
let current = []; // players currently sounding: [{ btn, p }]

function ensureCtx() {
  if (!ctx) {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    master = ctx.createGain(); master.connect(ctx.destination);
    // A constant source keeps the audio route (and Bluetooth link) open so first notes aren't clipped.
    const osc = ctx.createOscillator(); osc.frequency.value = 30;
    keepAliveGain = ctx.createGain(); keepAliveGain.gain.value = 0;
    osc.connect(keepAliveGain).connect(ctx.destination); osc.start();
    applySpeakerKeepAlive();
    for (const p of players.values()) wire(p);
  }
  if (ctx.state !== 'running') ctx.resume();
}
function applySpeakerKeepAlive() {
  if (keepAliveGain) keepAliveGain.gain.value = board.settings.speaker ? 0.0015 : 0;
}
function wire(p) {
  if (!ctx || p.node) return;
  p.node = ctx.createMediaElementSource(p.el);
  p.gain = ctx.createGain(); p.gain.gain.value = 0;
  p.node.connect(p.gain).connect(master);
}

async function loadPlayer(btn) {
  disposePlayer(btn.id);
  if (!btn.audioId) return;
  const rec = await audioGet(btn.audioId);
  if (!rec) return;
  const url = URL.createObjectURL(new Blob([rec.data], { type: rec.type || 'audio/mpeg' }));
  const el = new Audio();
  el.preload = 'auto';
  el.setAttribute('playsinline', '');
  el.src = url;
  el.addEventListener('loadedmetadata', () => { el.currentTime = btn.start || 0; }, { once: true });
  el.addEventListener('ended', () => finish(btn.id));
  el.load();
  const p = { el, url, gain: null, node: null, stopToken: 0 };
  players.set(btn.id, p);
  wire(p);
}
function disposePlayer(id) {
  const p = players.get(id);
  if (!p) return;
  try { p.el.pause(); p.node && p.node.disconnect(); p.gain && p.gain.disconnect(); } catch {}
  URL.revokeObjectURL(p.url);
  players.delete(id);
  current = current.filter((c) => c.btn.id !== id);
}

function play(btn) {
  ensureCtx();
  const p = players.get(btn.id);
  if (!p) { toast('No sound loaded — tap Edit to add one'); return; }

  // Tapping the button that's already playing stops it.
  if (current.some((c) => c.btn.id === btn.id)) { stopOne(btn.id, board.settings.stopFade); return; }
  if (!btn.overlay) stopAll(board.settings.stopFade);

  p.stopToken++;
  const g = p.gain.gain, now = ctx.currentTime, vol = btn.volume ?? 1;
  g.cancelScheduledValues(now);
  if (btn.fadeIn) { g.setValueAtTime(0, now); g.linearRampToValueAtTime(vol, now + 0.3); }
  else g.setValueAtTime(vol, now);
  const start = btn.start || 0;
  if (Math.abs(p.el.currentTime - start) > 0.03) p.el.currentTime = start;
  p.fadingOut = false;
  p.el.play().catch((e) => toast('Playback blocked: ' + e.message));
  current.push({ btn, p });
  tick();
}

function stopOne(id, fade) {
  const c = current.find((x) => x.btn.id === id);
  if (!c) return;
  current = current.filter((x) => x !== c);
  rampDownAndReset(c.btn, c.p, fade);
  render();
}
function stopAll(fade) {
  const list = current; current = [];
  for (const c of list) rampDownAndReset(c.btn, c.p, fade);
  render();
}
function rampDownAndReset(btn, p, fade) {
  const token = ++p.stopToken;
  if (ctx && p.gain) {
    const g = p.gain.gain, now = ctx.currentTime;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.linearRampToValueAtTime(0, now + Math.max(0.01, fade));
  }
  setTimeout(() => {
    if (token !== p.stopToken) return; // button was re-triggered during the fade
    p.el.pause();
    p.el.currentTime = btn.start || 0; // re-arm for instant next play
  }, Math.max(10, fade * 1000) + 30);
}
function finish(id) {
  const c = current.find((x) => x.btn.id === id);
  if (c) stopOne(id, 0.01);
}

// Progress + auto-stop at end point.
let raf = 0;
function tick() {
  cancelAnimationFrame(raf);
  const loop = () => {
    for (const { btn, p } of [...current]) {
      const start = btn.start || 0;
      const end = btn.end ?? (Number.isFinite(p.el.duration) ? p.el.duration : null);
      const fo = btn.fadeOut ?? 0;
      if (btn.end != null && !p.fadingOut && fo > 0 && p.el.currentTime >= end - fo) {
        p.fadingOut = true;
        const g = p.gain.gain, now = ctx.currentTime;
        g.cancelScheduledValues(now); g.setValueAtTime(g.value, now); g.linearRampToValueAtTime(0, now + fo);
      }
      if (btn.end != null && p.el.currentTime >= end) finish(btn.id);
      const pad = document.querySelector(`.pad[data-id="${btn.id}"] .prog`);
      if (pad && end) pad.style.width = `${Math.min(100, ((p.el.currentTime - start) / (end - start)) * 100)}%`;
    }
    updateNowPlaying();
    if (current.length) raf = requestAnimationFrame(loop);
  };
  raf = requestAnimationFrame(loop);
  render();
}
function updateNowPlaying() {
  const last = current[current.length - 1];
  if (!last) { $('#npLabel').textContent = 'Ready'; $('#npTime').textContent = ''; $('#npFill').style.width = '0'; return; }
  const { btn, p } = last;
  const start = btn.start || 0;
  const end = btn.end ?? (Number.isFinite(p.el.duration) ? p.el.duration : start);
  const el = p.el.currentTime - start, total = end - start;
  $('#npLabel').textContent = btn.label;
  $('#npTime').textContent = `${fmt(Math.max(0, el))} / ${fmt(total)}`;
  $('#npFill').style.width = total > 0 ? `${Math.min(100, (el / total) * 100)}%` : '0';
}

// ---------- Wake lock ----------
let wakeLock = null;
async function applyWake() {
  try {
    if (board.settings.wake && 'wakeLock' in navigator && document.visibilityState === 'visible') {
      if (!wakeLock) { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock = null; }); }
    } else if (wakeLock) { await wakeLock.release(); wakeLock = null; }
  } catch { /* not supported or denied: user should set Auto-Lock to Never */ }
}
document.addEventListener('visibilitychange', () => { applyWake(); if (document.visibilityState === 'visible' && ctx) ctx.resume(); });

// ---------- Rendering ----------
function render() {
  const grid = $('#grid');
  grid.classList.toggle('cols-fixed', board.settings.cols !== 'auto');
  grid.style.setProperty('--cols', board.settings.cols);
  document.body.classList.toggle('editing', editing);
  $('#editBtn').textContent = editing ? 'Done' : 'Edit';

  const playing = new Set(current.map((c) => c.btn.id));
  grid.replaceChildren();
  for (const btn of board.buttons) {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'pad' + (players.has(btn.id) ? '' : ' missing') + (playing.has(btn.id) ? ' playing' : '');
    el.dataset.id = btn.id;
    el.style.background = btn.color;
    el.innerHTML = `<span></span><div class="prog"></div>${btn.start ? `<span class="tag">@${fmt(btn.start)}</span>` : ''}`;
    el.firstChild.textContent = btn.label;
    el.addEventListener('click', () => (editing ? openEditor(btn) : play(btn)));
    grid.append(el);
  }
  if (editing || !board.buttons.length) {
    const add = document.createElement('button');
    add.type = 'button'; add.className = 'pad add'; add.textContent = '+ Add button';
    add.addEventListener('click', () => { editing = true; openEditor(null); });
    grid.append(add);
  }
}

// ---------- Editor ----------
let editTarget = null, pendingFile = null, editColor = COLORS[0], previewUrl = null;
function buildColors() {
  const box = $('#fColors'); box.replaceChildren();
  for (const c of COLORS) {
    const b = document.createElement('button'); b.type = 'button'; b.style.background = c;
    b.className = c === editColor ? 'sel' : '';
    b.addEventListener('click', () => { editColor = c; buildColors(); });
    box.append(b);
  }
}
async function setPreviewSource(blobOrNull) {
  const a = $('#fPreview');
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = blobOrNull ? URL.createObjectURL(blobOrNull) : null;
  a.src = previewUrl || '';
}
async function openEditor(btn) {
  editTarget = btn; pendingFile = null;
  $('#editorTitle').textContent = btn ? 'Edit button' : 'New button';
  $('#fLabel').value = btn?.label ?? '';
  $('#fFile').value = '';
  $('#fFileName').textContent = btn?.fileName ? `Current: ${btn.fileName}` : 'No file yet';
  $('#fStart').value = btn?.start ? fmt(btn.start) : '';
  $('#fEnd').value = btn?.end != null ? fmt(btn.end) : '';
  $('#fFadeOut').value = btn?.fadeOut ?? 1.5;
  $('#fVolume').value = btn?.volume ?? 1;
  $('#fFadeIn').checked = !!btn?.fadeIn;
  $('#fOverlay').checked = !!btn?.overlay;
  editColor = btn?.color ?? COLORS[board.buttons.length % COLORS.length];
  buildColors();
  $('#deleteBtn').hidden = $('#moveLeft').hidden = $('#moveRight').hidden = !btn;
  let blob = null;
  if (btn?.audioId) { const rec = await audioGet(btn.audioId); if (rec) blob = new Blob([rec.data], { type: rec.type }); }
  setPreviewSource(blob);
  $('#editor').showModal();
}
$('#fFile').addEventListener('change', (e) => {
  const f = e.target.files[0]; if (!f) return;
  pendingFile = f;
  $('#fFileName').textContent = `New: ${f.name}`;
  if (!$('#fLabel').value) $('#fLabel').value = f.name.replace(/\.[^.]+$/, '').slice(0, 40);
  setPreviewSource(f);
});
$('#setStart').addEventListener('click', () => { $('#fStart').value = fmt($('#fPreview').currentTime); });
$('#setEnd').addEventListener('click', () => { $('#fEnd').value = fmt($('#fPreview').currentTime); });
$('#tryIt').addEventListener('click', () => {
  const a = $('#fPreview'); const s = parseTime($('#fStart').value) || 0; const e = parseTime($('#fEnd').value);
  a.currentTime = s; a.play();
  if (e != null && e > s) {
    const stopAt = () => { if (a.currentTime >= e) { a.pause(); a.removeEventListener('timeupdate', stopAt); } };
    a.addEventListener('timeupdate', stopAt);
  }
});
$('#editor').addEventListener('close', async () => {
  $('#fPreview').pause();
  if ($('#editor').returnValue !== 'save') return;
  const start = parseTime($('#fStart').value) ?? 0;
  const end = parseTime($('#fEnd').value);
  if (Number.isNaN(start) || Number.isNaN(end) || (end != null && end <= start)) { toast('Check start/end times'); return; }
  const btn = editTarget ?? { id: uid() };
  Object.assign(btn, {
    label: $('#fLabel').value.trim() || 'Sound',
    color: editColor, start, end,
    fadeOut: Number($('#fFadeOut').value) || 0,
    volume: Number($('#fVolume').value),
    fadeIn: $('#fFadeIn').checked,
    overlay: $('#fOverlay').checked,
  });
  try {
    if (pendingFile) {
      const data = await pendingFile.arrayBuffer();
      const oldId = btn.audioId;
      btn.audioId = uid(); btn.fileName = pendingFile.name;
      await audioSet(btn.audioId, { type: pendingFile.type || 'audio/mpeg', data });
      if (oldId) await audioDel(oldId);
    }
    if (!editTarget) board.buttons.push(btn);
    await saveBoard();
    stopOne(btn.id, 0.05);
    await loadPlayer(btn);
    render();
  } catch (e) { toast('Save failed: ' + e.message, 4000); }
});
async function moveTarget(delta) {
  const i = board.buttons.indexOf(editTarget), j = i + delta;
  if (i < 0 || j < 0 || j >= board.buttons.length) return;
  [board.buttons[i], board.buttons[j]] = [board.buttons[j], board.buttons[i]];
  await saveBoard(); render();
}
$('#moveLeft').addEventListener('click', () => moveTarget(-1));
$('#moveRight').addEventListener('click', () => moveTarget(1));
$('#deleteBtn').addEventListener('click', async () => {
  if (!editTarget || !confirm(`Delete “${editTarget.label}”?`)) return;
  disposePlayer(editTarget.id);
  if (editTarget.audioId) await audioDel(editTarget.audioId);
  board.buttons = board.buttons.filter((b) => b !== editTarget);
  await saveBoard();
  $('#editor').close('cancel'); render();
});

// ---------- Settings, export, import ----------
async function openSettings() {
  const s = board.settings;
  $('#sWake').checked = s.wake; $('#sSpeaker').checked = s.speaker;
  $('#sStopFade').value = s.stopFade; $('#sFade').value = s.fade; $('#sCols').value = s.cols;
  $('#settings').showModal();
  try {
    const est = await navigator.storage?.estimate?.();
    const persisted = await navigator.storage?.persisted?.();
    $('#storageInfo').textContent = est
      ? `Using ${(est.usage / 1e6).toFixed(1)} MB. ${persisted ? 'Protected from automatic cleanup.' : 'Not protected — keep an exported backup.'}`
      : 'Unknown';
  } catch { $('#storageInfo').textContent = 'Unknown'; }
}
$('#settings').addEventListener('close', async () => {
  const s = board.settings;
  s.wake = $('#sWake').checked; s.speaker = $('#sSpeaker').checked;
  s.stopFade = Math.max(0, Number($('#sStopFade').value) || 0);
  s.fade = Math.max(0.5, Number($('#sFade').value) || 2);
  s.cols = $('#sCols').value;
  await saveBoard(); applyWake(); applySpeakerKeepAlive(); render();
});

// File format: "RLB1" | uint32 header length | header JSON | concatenated audio bytes
async function exportBoard() {
  const files = [], parts = [];
  let offset = 0;
  for (const b of board.buttons) {
    if (!b.audioId) continue;
    const rec = await audioGet(b.audioId); if (!rec) continue;
    files.push({ audioId: b.audioId, type: rec.type, offset, length: rec.data.byteLength });
    parts.push(rec.data); offset += rec.data.byteLength;
  }
  const header = new TextEncoder().encode(JSON.stringify({ version: 1, board, files }));
  const len = new Uint8Array(4); new DataView(len.buffer).setUint32(0, header.length);
  const blob = new Blob([new TextEncoder().encode('RLB1'), len, header, ...parts], { type: 'application/octet-stream' });
  const file = new File([blob], `ringleader-board-${new Date().toISOString().slice(0, 10)}.rlb`, { type: 'application/octet-stream' });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: 'RingLeader board' }); return; }
    catch (e) { if (e.name === 'AbortError') return; }
  }
  const a = document.createElement('a'); a.href = URL.createObjectURL(file); a.download = file.name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
async function importBoard(file) {
  const buf = await file.arrayBuffer();
  if (new TextDecoder().decode(buf.slice(0, 4)) !== 'RLB1') throw new Error('Not a RingLeader board file');
  const hlen = new DataView(buf, 4, 4).getUint32(0);
  const header = JSON.parse(new TextDecoder().decode(buf.slice(8, 8 + hlen)));
  const base = 8 + hlen;
  if (!confirm(`Replace your board with ${header.board.buttons.length} buttons from this file?`)) return;
  stopAll(0.05);
  for (const id of [...players.keys()]) disposePlayer(id);
  await audioClear();
  for (const f of header.files) await audioSet(f.audioId, { type: f.type, data: buf.slice(base + f.offset, base + f.offset + f.length) });
  board = { buttons: header.board.buttons, settings: { ...DEFAULT_SETTINGS, ...header.board.settings } };
  await saveBoard();
  for (const b of board.buttons) await loadPlayer(b);
  render(); toast(`Imported ${board.buttons.length} buttons`);
}
$('#exportBtn').addEventListener('click', () => exportBoard().catch((e) => toast('Export failed: ' + e.message, 4000)));
$('#importFile').addEventListener('change', (e) => {
  const f = e.target.files[0]; e.target.value = '';
  if (f) importBoard(f).then(() => $('#settings').close()).catch((err) => toast('Import failed: ' + err.message, 4000));
});

// ---------- Wiring ----------
// STOP/FADE fire on pointerdown — no waiting for finger lift.
$('#stopBtn').addEventListener('pointerdown', (e) => { e.preventDefault(); stopAll(board.settings.stopFade); });
$('#fadeBtn').addEventListener('pointerdown', (e) => { e.preventDefault(); stopAll(board.settings.fade); });
$('#editBtn').addEventListener('click', () => { editing = !editing; render(); });
$('#settingsBtn').addEventListener('click', openSettings);
$('#unlockBtn').addEventListener('click', () => {
  ensureCtx();
  applyWake();
  $('#unlock').classList.add('hidden');
});
document.addEventListener('pointerdown', () => { if (ctx && ctx.state !== 'running') ctx.resume(); }, { capture: true });

async function init() {
  try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch {} // ignore iPhone silent switch
  db = await openDB();
  const saved = await kvGet('board');
  if (saved) board = { buttons: saved.buttons || [], settings: { ...DEFAULT_SETTINGS, ...saved.settings } };
  for (const b of board.buttons) await loadPlayer(b);
  render();
  navigator.storage?.persist?.().catch(() => {});
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}
init().catch((e) => toast('Startup failed: ' + e.message, 6000));
