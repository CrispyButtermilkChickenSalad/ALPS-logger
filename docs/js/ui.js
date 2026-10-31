import { Recorder } from './recorder.js';
import { IdbDb } from './db.js';
import { SerialSource, SimulatedSource, serialSupported } from './sources.js';
import { MoonrakerPoller, mixedContentProblem } from './moonraker.js';
import { downsample, toCsv, safeName } from './data.js';
import { drawChart } from './chart.js';
import { initTabs } from './ui_tabs.js';

const $ = (id) => document.getElementById(id);
const LIVE_KEEP_S = 330;
const live = { t: [], raw: [], lo: [], hi: [], filt: [], z: [] };
let rec, db, source = null, poller = null, wakeLock = null;

// ---- live chart ------------------------------------------------------------
function pushLive([t, raw, filt, z]) {
  live.t.push(t); live.raw.push(raw); live.lo.push(raw); live.hi.push(raw); live.filt.push(filt); live.z.push(z);
  if (live.t.length % 500 === 0) {
    const cutoff = t - LIVE_KEEP_S;
    let n = 0; while (n < live.t.length && live.t[n] < cutoff) n++;
    if (n) for (const k in live) live[k].splice(0, n);
  }
}
function renderLive() {
  if (live.t.length) {
    const end = live.t[live.t.length - 1], w = +$('win').value;
    drawChart($('live'), live, { xRange: [end - w, end], tZero: end, threshold: rec.threshold });
  }
  requestAnimationFrame(renderLive);
}

// ---- status ------------------------------------------------------------------
function renderStatus() {
  const s = rec.status();
  const dev = $('pDev');
  dev.textContent = s.connected ? `device: v${s.version}` : `device: ${s.deviceError || 'disconnected'}`;
  dev.className = 'pill ' + (s.connected ? 'ok' : s.deviceError ? 'bad' : '');
  $('pRate').textContent = s.rateHz + ' Hz';
  $('pPrint').textContent = 'print: ' + (s.moonrakerOk === null ? 'no Moonraker' : s.moonrakerOk ? `${s.printState}${s.filename ? ' – ' + s.filename : ''}` : 'Moonraker unreachable');
  $('pPrint').className = 'pill ' + (s.moonrakerOk === false ? 'bad' : '');
  const r = $('pRec');
  r.textContent = s.recording ? `recording: ${s.sessionName}${s.sessionAuto ? ' (auto)' : ''}` : 'not recording';
  r.className = 'pill ' + (s.recording ? 'ok' : '');
  $('pZ').textContent = 'Z ' + (s.z == null ? '–' : s.z.toFixed(2));
  $('btnStart').disabled = s.recording;
  $('btnStop').disabled = !s.recording;
  const on = s.connected;
  $('btnSerial').style.display = on ? 'none' : '';
  $('btnSim').style.display = on ? 'none' : '';
  $('btnDisc').style.display = on ? '' : 'none';
  for (const id of ['btnSet', 'btnRead']) $(id).disabled = !on;
  if (s.threshold != null && document.activeElement !== $('thr')) $('thr').value = s.threshold;
  $('log').textContent = rec.messages.slice(-30).join('\n');
}
let lastRecording = false;
function onChange() {
  renderStatus();
  const now = rec.status().recording;
  if (now !== lastRecording) { lastRecording = now; setTimeout(loadSessions, 400); }
}

// ---- device controls -------------------------------------------------------------
async function connect(kind) {
  try {
    source = kind === 'sim' ? new SimulatedSource(rec) : new SerialSource(rec);
    await source.connect();
  } catch (e) {
    if (e.name !== 'NotFoundError') alert(`Connect failed: ${e.message}`);
    if (source) await source.disconnect(e.name === 'NotFoundError' ? null : e.message).catch(() => {});
    source = null;
  }
}
$('btnSerial').onclick = () => connect('serial');
$('btnSim').onclick = () => connect('sim');
$('btnDisc').onclick = async () => { if (source) await source.disconnect(); source = null; };
$('btnStart').onclick = () => { const n = prompt('Session name (optional)'); if (n === null) return; try { rec.startSession(n || undefined); } catch (e) { alert(e.message); } };
$('btnStop').onclick = () => rec.stopSession().catch((e) => alert(e.message));
$('btnSet').onclick = async () => {
  const v = parseInt($('thr').value, 10);
  if (!Number.isInteger(v) || v < 0) return alert('Threshold must be a whole number >= 0');
  try { await rec.sendCommand(`set ${v}`); await rec.sendCommand('rt'); } catch (e) { alert(e.message); }
};
$('btnRead').onclick = () => rec.sendCommand('rt').catch((e) => alert(e.message));

// ---- moonraker (optional) --------------------------------------------------------------
function moonrakerUi(active) {
  $('mrState').textContent = active ? 'enabled' : 'off';
  $('btnMr').textContent = active ? 'Disable' : 'Enable';
}
function updateMixedWarning() {
  $('mrWarn').style.display = mixedContentProblem(location.protocol, $('mrUrl').value.trim()) ? 'block' : 'none';
}
function toggleMoonraker(forceOn) {
  if (poller && !forceOn) {
    poller.stop(); poller = null; rec.onPrintUpdate(null, null, null, false); rec.moonrakerOk = null; rec.z = null;
    localStorage.setItem('mrEnabled', '0'); moonrakerUi(false); renderStatus(); return;
  }
  const url = $('mrUrl').value.trim();
  if (!/^https?:\/\//.test(url)) return alert('Enter a URL like http://192.168.1.50:7125');
  localStorage.setItem('mrUrl', url); localStorage.setItem('mrKey', $('mrKey').value); localStorage.setItem('mrEnabled', '1');
  poller = new MoonrakerPoller(url, (s, f, z, ok, x, y) => rec.onPrintUpdate(s, f, z, ok, x, y), { apiKey: $('mrKey').value.trim() });
  poller.start(); moonrakerUi(true);
}
$('btnMr').onclick = () => toggleMoonraker(false);
$('mrUrl').oninput = updateMixedWarning;

// ---- keep awake -----------------------------------------------------------------------------
async function setWake(on) {
  try {
    if (on && 'wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen');
    else if (wakeLock) { await wakeLock.release(); wakeLock = null; }
  } catch (e) { $('wake').checked = false; alert('Wake lock unavailable: ' + e.message); }
}
$('wake').onchange = (e) => setWake(e.target.checked);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && $('wake').checked) setWake(true); });

// ---- recorded sessions ---------------------------------------------------------------------
let view = null, selected = null;
const fmt = (ts) => new Date(ts * 1000).toLocaleString();
const dur = (s) => { const d = (s.ended || Date.now() / 1000) - s.started; return d >= 3600 ? (d / 3600).toFixed(2) + ' h' : d >= 60 ? (d / 60).toFixed(1) + ' min' : d.toFixed(0) + ' s'; };
async function loadSessions() {
  const rows = await db.listSessions();
  $('tbody').innerHTML = '';
  for (const s of rows) {
    const tr = document.createElement('tr'); if (s.id === selected) tr.className = 'sel';
    tr.innerHTML = `<td>${s.id}</td><td></td><td>${fmt(s.started)}</td><td>${dur(s)}${s.ended ? '' : ' ●'}</td><td>${s.n}</td><td></td>`;
    tr.children[1].textContent = s.name;
    const v = document.createElement('button'); v.textContent = 'View'; v.onclick = () => openSession(s.id);
    const c = document.createElement('button'); c.textContent = 'CSV'; c.onclick = () => downloadCsv(s.id);
    const d = document.createElement('button'); d.textContent = 'Delete'; d.className = 'danger';
    d.onclick = async () => {
      if (rec.session && rec.session.id === s.id) return alert('Session is recording');
      if (!confirm(`Delete session ${s.id}?`)) return;
      await db.deleteSession(s.id);
      if (selected === s.id) { view = null; selected = null; $('view').style.display = $('viewHint').style.display = 'none'; }
      loadSessions();
    };
    tr.children[5].append(v, ' ', c, ' ', d); $('tbody').append(tr);
  }
}
async function downloadCsv(id) {
  const s = await db.getSession(id);
  const blob = new Blob([toCsv(s, await db.getSamples(id))], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = `alps_${id}_${safeName(s.name)}.csv`; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
async function openSession(id) {
  selected = id;
  const pts = downsample(await db.getSamples(id), 4000);
  const d = { t: [], raw: [], lo: [], hi: [], filt: [], z: [] };
  for (const [t, raw, lo, hi, filt, z] of pts) { d.t.push(t); d.raw.push(raw); d.lo.push(lo); d.hi.push(hi); d.filt.push(filt); d.z.push(z); }
  if (!d.t.length) { view = null; $('view').style.display = $('viewHint').style.display = 'none'; return loadSessions(); }
  view = { d, full: [d.t[0], d.t[d.t.length - 1]], range: null, zero: d.t[0] };
  view.range = view.full.slice();
  $('view').style.display = $('viewHint').style.display = 'block';
  renderView(); loadSessions();
}
function renderView() { if (view) drawChart($('view'), view.d, { xRange: view.range, tZero: view.zero, band: true, threshold: null }); }
(() => {
  const cv = $('view'); let drag = null;
  const tAt = (e) => { const m = cv._map, r = cv.getBoundingClientRect(); return m.x0 + (e.clientX - r.left - m.L) / (m.W - m.L - m.R) * (m.x1 - m.x0); };
  cv.onmousedown = (e) => { drag = tAt(e); };
  cv.onmouseup = (e) => { if (drag == null) return; const a = drag, b = tAt(e); drag = null; if (Math.abs(b - a) > (view.range[1] - view.range[0]) * 0.01) { view.range = [Math.min(a, b), Math.max(a, b)]; renderView(); } };
  cv.ondblclick = () => { view.range = view.full.slice(); renderView(); };
  window.addEventListener('resize', renderView);
})();

// ---- boot ------------------------------------------------------------------------------------
(async () => {
  if (!serialSupported()) $('noSerial').style.display = 'block';
  try {
    db = await IdbDb.open();
  } catch (e) {
    $('noDb').style.display = 'block'; $('noDb').textContent = 'Could not open browser storage: ' + e.message; return;
  }
  rec = new Recorder(db);
  initTabs({ db, live });
  rec.onsample = pushLive;
  rec.onchange = onChange;
  window.addEventListener('beforeunload', (e) => { if (rec.session || rec.connected) { e.preventDefault(); e.returnValue = ''; } });
  $('mrUrl').value = localStorage.getItem('mrUrl') || '';
  $('mrKey').value = localStorage.getItem('mrKey') || '';
  updateMixedWarning();
  if (localStorage.getItem('mrEnabled') === '1' && $('mrUrl').value) toggleMoonraker(true);
  setInterval(renderStatus, 1000);
  renderStatus(); renderLive(); loadSessions();
})();
