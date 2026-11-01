import { Recorder } from './recorder.js';
import { IdbDb } from './db.js';
import { SerialSource, SimulatedSource, serialSupported } from './sources.js';
import { MoonrakerPoller, mixedContentProblem } from './moonraker.js';
import { downsample, toCsv, exportMeta, kindToCsv, KINDS, safeName } from './data.js';
import { loadCalib, isCalibrated, toUnits } from './calib.js';
import { normalizeCapture } from './capture.js';
import { MirrorDb, requestPersistence, loadFolderHandle, saveFolderHandle, exportBackup, importBackup } from './persist.js';
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
  $('btnMark').disabled = !s.recording;
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
let view = null, selected = null, tabsApi = null;
const fmt = (ts) => new Date(ts * 1000).toLocaleString();
const dur = (s) => { const d = (s.ended || Date.now() / 1000) - s.started; return d >= 3600 ? (d / 3600).toFixed(2) + ' h' : d >= 60 ? (d / 60).toFixed(1) + ' min' : d.toFixed(0) + ' s'; };
async function loadSessions() {
  const rows = await db.listSessions();
  $('tbody').innerHTML = '';
  for (const s of rows) {
    const tr = document.createElement('tr'); if (s.id === selected) tr.className = 'sel';
    tr.innerHTML = `<td>${s.id}</td><td></td><td>${fmt(s.started)}</td><td>${dur(s)}${s.ended ? '' : ' ●'}</td><td>${s.n}${s.capture && s.capture.mode !== 'full' ? ' kept' : ''}</td><td></td>`;
    tr.children[1].textContent = s.name;
    const v = document.createElement('button'); v.textContent = 'View'; v.onclick = () => openSession(s.id);
    const c = document.createElement('button'); c.textContent = 'CSV'; c.onclick = () => downloadCsv(s.id);
    const d = document.createElement('button'); d.textContent = 'Delete'; d.className = 'danger';
    d.onclick = async () => {
      if (rec.session && rec.session.id === s.id) return alert('Session is recording');
      if (!confirm(`Delete session ${s.id}?`)) return;
      await db.deleteSession(s.id);
      if (selected === s.id) { view = null; selected = null; $('view').style.display = $('viewHint').style.display = 'none'; $('sumBox').hidden = true; }
      loadSessions();
    };
    tr.children[5].append(v, ' ', c, ' ', d); $('tbody').append(tr);
  }
  renderRecent(rows).catch(() => {});
  loadFolder().catch(() => {});
}

const chartData = (rows, n) => {
  const d = { t: [], raw: [], lo: [], hi: [], filt: [], z: [] };
  for (const [t, raw, lo, hi, filt, z] of downsample(rows, n)) { d.t.push(t); d.raw.push(raw); d.lo.push(lo); d.hi.push(hi); d.filt.push(filt); d.z.push(z); }
  return d;
};

// Envelope rows -> chart data, merged down to <= n points (min of mins, max of maxes, mean of means).
function envChartData(env, n) {
  const d = { t: [], raw: [], lo: [], hi: [], filt: [], z: [] };
  const stride = Math.max(1, Math.ceil(env.length / n));
  for (let i = 0; i < env.length; i += stride) {
    let lo = Infinity, hi = -Infinity, ms = 0, mc = 0, fs = 0, fc = 0, z = null;
    for (let j = i; j < Math.min(env.length, i + stride); j++) {
      const r = env[j]; lo = Math.min(lo, r[1]); hi = Math.max(hi, r[3]); ms += r[2] * r[9]; mc += r[9];
      if (r[5] != null) { fs += r[5]; fc++; } if (r[6] != null) z = r[6];
    }
    d.t.push(env[i][0]); d.raw.push(mc ? ms / mc : null); d.lo.push(lo); d.hi.push(hi); d.filt.push(fc ? fs / fc : null); d.z.push(z);
  }
  return d;
}

// Triggered / envelope-only sessions have gaps in the raw data, so they are charted from the summary trace instead.
async function sessionChart(s, n) {
  const env = typeof s.id === 'number' ? await db.getSamples(s.id, 'env') : [];
  if (env.length && (s.capture?.mode ?? 'full') !== 'full') return { d: envChartData(env, n), env, fromEnv: true };
  return { d: chartData(await db.getSamples(s.id), n), env, fromEnv: false };
}

async function renderRecent(rows) {
  const s = rows[0];
  $('recentEmpty').hidden = !!s; $('recentBody').hidden = !s;
  if (!s) return;
  const { d, env, fromEnv } = await sessionChart(s, 2000);
  $('rName').textContent = `#${s.id} ${s.name}`;
  let lo = Infinity, hi = -Infinity, sum = 0, k = 0, count;
  if (fromEnv) {
    for (const r of env) { lo = Math.min(lo, r[1]); hi = Math.max(hi, r[3]); sum += r[2] * r[9]; k += r[9]; }
    count = `${k} samples seen · ${s.n} kept · ${s.n_evt || 0} events`;
  } else {
    for (const r of await db.getSamples(s.id)) { const v = r[1]; if (v == null) continue; if (v < lo) lo = v; if (v > hi) hi = v; sum += v; k++; }
    count = `${s.n} samples`;
  }
  $('rMeta').textContent = `${fmt(s.started)} · ${dur(s)}${s.ended ? '' : ' (recording)'} · ${count}`;
  $('rStats').textContent = k ? `raw min ${lo} · mean ${Math.round(sum / k)} · max ${hi} · span ${hi - lo}` : 'no data yet';
  $('rView').onclick = async () => { goTab('sessions'); await openSession(s.id); $('view').scrollIntoView({ behavior: 'smooth' }); };
  $('rCsv').onclick = () => downloadCsv(s.id);
  $('rGcode').onclick = () => tabsApi.openInGcode(s.id);
  if (d.t.length > 1) { recentDraw = () => drawChart($('recentView'), d, { xRange: [d.t[0], d.t[d.t.length - 1]], tZero: d.t[0], band: true, threshold: null }); recentDraw(); }
}
let recentDraw = null;
window.addEventListener('resize', () => { if (recentDraw && $('recentView').offsetParent) recentDraw(); });
const goTab = (name) => document.querySelector(`nav.tabs button[data-tab="${name}"]`).click();

async function loadFolder() {
  const body = $('ftbody'); body.innerHTML = '';
  if (!db.dir) { $('fList').textContent = 'no folder selected (use Auto-save to folder in Settings)'; return; }
  let list;
  try { list = await db.listFolder(); } catch (e) { $('fList').textContent = 'cannot read folder: ' + e.message; return; }
  $('fList').textContent = `${list.length} CSV file(s) in ${db.dir.name}`;
  for (const f of list) {
    const tr = document.createElement('tr');
    tr.innerHTML = '<td></td><td></td><td></td><td></td>';
    tr.children[0].textContent = f.file; tr.children[1].textContent = fmt(f.modified); tr.children[2].textContent = Math.max(1, Math.round(f.size / 1024)) + ' KB';
    const v = document.createElement('button'); v.textContent = 'View';
    v.onclick = async () => { try { goTab('sessions'); await openSession(f.id); $('view').scrollIntoView({ behavior: 'smooth' }); } catch (e) { alert(e.message); } };
    const im = document.createElement('button'); im.textContent = 'Import';
    im.onclick = async () => { try { await db.importFromFolder(f.id); im.textContent = 'Imported'; im.disabled = true; loadSessions(); } catch (e) { alert(e.message); } };
    const g = document.createElement('button'); g.textContent = 'G-code tab'; g.onclick = () => tabsApi.openInGcode(f.id);
    tr.children[3].append(v, ' ', im, ' ', g); body.append(tr);
  }
}
$('fRefresh').onclick = () => loadFolder();
const download = (text, type, name) => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
};
async function downloadCsv(id) {
  const s = await db.getSession(id);
  const rows = await db.getSamples(id), env = await db.getSamples(id, 'env'), calib = loadCalib(localStorage), base = `alps_${id}_${safeName(s.name)}`;
  download(toCsv(s, rows, calib, env), 'text/csv', base + '.csv');
  // Sidecar documents units and the calibration used, for research reproducibility.
  setTimeout(() => download(JSON.stringify(exportMeta(s, rows, calib, env), null, 2), 'application/json', base + '.meta.json'), 300);
}
async function downloadKind(id, kind) {
  const s = await db.getSession(id), calib = loadCalib(localStorage);
  const env = await db.getSamples(id, 'env'), rows = kind === 'env' ? env : await db.getSamples(id, kind);
  if (!rows.length) return alert('Nothing recorded for this part of the session.');
  download(kindToCsv(kind, s, rows, calib, env), 'text/csv', `alps_${id}_${safeName(s.name)}.${KINDS[kind].suffix}.csv`);
}
async function openSession(id) {
  selected = id;
  const s = await db.getSession(id);
  const { d, env } = await sessionChart(s, 4000);
  renderSummary(id, s, env).catch(() => {});
  if (!d.t.length) { view = null; $('view').style.display = $('viewHint').style.display = 'none'; return loadSessions(); }
  view = { d, full: [d.t[0], d.t[d.t.length - 1]], range: null, zero: d.t[0], yRange: null, yFull: yExtent(d) };
  view.range = view.full.slice();
  $('view').style.display = $('viewHint').style.display = 'block';
  renderView(); loadSessions();
}

// Layers / events tables for sessions that have long-print capture data.
const hms = (sec) => { sec = Math.max(0, sec); const h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60); return `${h ? h + ':' + String(m).padStart(2, '0') : m}:${(sec % 60).toFixed(1).padStart(4, '0')}`; };
async function renderSummary(id, s, env) {
  const has = env.length > 0;
  $('sumBox').hidden = !has; $('evView').hidden = true;
  $('sumNone').hidden = has || typeof id !== 'number';
  if (!has) return;
  const layers = await db.getSamples(id, 'layer'), evts = await db.getSamples(id, 'evt'), calib = loadCalib(localStorage);
  const cal = isCalibrated(calib), u = (d) => (cal ? ` (${toUnits(d, calib, 0).toFixed(2)} ${calib.unit})` : '');
  const seen = env.reduce((a, r) => a + r[9], 0);
  $('sumTitle').textContent = `#${id} ${s.name}`;
  $('sumInfo').textContent = `${seen} samples seen · ${env.length} summary buckets · ${layers.length} layers · ${evts.length} events · capture: ${s.capture?.mode || 'full'}`;
  $('sumLayers').disabled = !layers.length; $('sumEvents').disabled = !evts.length;
  $('sumEnv').onclick = () => downloadKind(id, 'env'); $('sumLayers').onclick = () => downloadKind(id, 'layer'); $('sumEvents').onclick = () => downloadKind(id, 'evt');
  $('layBody').innerHTML = '';
  for (const r of layers) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${r[3]}</td><td>${r[2]}</td><td>${hms(r[0] - s.started)}</td><td>${Math.round(r[4])}</td><td>${r[5].toFixed(1)}${u(r[5])}</td><td>${r[8]}${u(r[8])}</td><td>${r[9]}</td>`;
    $('layBody').append(tr);
  }
  $('evBody').innerHTML = '';
  for (const r of evts) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${hms(r[0] - s.started)}</td><td></td><td>${r[3]}${u(r[3])}</td><td>${r[6] ?? ''}</td><td></td>`;
    tr.children[1].textContent = r[2];
    const zoom = document.createElement('button'); zoom.textContent = 'Zoom';
    zoom.onclick = () => { if (!view) return; const a = Math.max(view.full[0], r[0] - 5), b = Math.min(view.full[1], r[1] + 5); view.range = [a, b]; renderView(); $('view').scrollIntoView({ behavior: 'smooth', block: 'center' }); };
    const raw = document.createElement('button'); raw.textContent = 'Raw';
    raw.onclick = async () => {
      const rows = (await db.getSamples(id)).filter((x) => x[0] >= r[0] - 3 && x[0] <= r[1] + 3);
      if (rows.length < 2) return alert('No raw samples were kept for this event (summary-only capture).');
      const d = chartData(rows, 3000);
      $('evView').hidden = false;
      drawChart($('evView'), d, { xRange: [d.t[0], d.t[d.t.length - 1]], tZero: r[0], band: false, threshold: null });
      $('evView').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    };
    tr.children[4].append(zoom, ' ', raw); $('evBody').append(tr);
  }
}
function yExtent(d) {
  let lo = Infinity, hi = -Infinity;
  for (const k of ['lo', 'hi', 'filt']) for (const v of d[k] || []) if (v != null) { if (v < lo) lo = v; if (v > hi) hi = v; }
  if (!isFinite(lo)) return [0, 1];
  const pad = (hi - lo || 1) * 0.08; return [lo - pad, hi + pad];
}
function renderView() { if (view) { drawChart($('view'), view.d, { xRange: view.range, yRange: view.yRange, tZero: view.zero, band: true, threshold: null }); syncBar(); } }
let setRange = () => {}, syncBar = () => {};
(() => {
  const cv = $('view'), track = $('vTrack'), thumb = $('vThumb'), MIN_SPAN = 0.05;
  let sel = null; // {a, b} in seconds while dragging a window
  const span = () => view.full[1] - view.full[0];
  const clampRange = (a, b) => {
    const full = view.full, w = Math.min(Math.max(b - a, MIN_SPAN), span());
    a = Math.min(Math.max(a, full[0]), full[1] - w);
    return [a, a + w];
  };
  const mx = (e) => { const m = cv._map, r = cv.getBoundingClientRect(); return Math.min(Math.max(e.clientX - r.left, m.L), m.W - m.R); };
  const tAt = (e) => { const m = cv._map; return m.x0 + (mx(e) - m.L) / (m.W - m.L - m.R) * (m.x1 - m.x0); };
  const vy = $('vyTrack'), vyThumb = $('vyThumb'), MIN_Y = 1;
  const yAt = (e) => { const m = cv._map, r = cv.getBoundingClientRect(), y = Math.min(Math.max(e.clientY - r.top, m.T), m.T + m.sigH); return m.hi - (y - m.T) / m.sigH * (m.hi - m.lo); };
  const curY = () => view.yRange || [cv._map.lo, cv._map.hi];
  const clampY = (a, b) => {
    const [f0, f1] = view.yFull, fs = f1 - f0, w = Math.min(Math.max(b - a, MIN_Y), fs);
    a = Math.min(Math.max(a, f0), f1 - w);
    return [a, a + w];
  };
  syncBar = () => {
    if (!view) return;
    const [f0, f1] = view.yFull, [ya, yb] = view.yRange || view.yFull, fs = f1 - f0 || 1;
    vyThumb.style.top = ((f1 - yb) / fs * 100) + '%';
    vyThumb.style.height = Math.max(1, (yb - ya) / fs * 100) + '%';
    const s = span() || 1, w = view.range[1] - view.range[0];
    thumb.style.left = ((view.range[0] - view.full[0]) / s * 100) + '%';
    thumb.style.width = Math.max(1, w / s * 100) + '%';
    $('vInfo').textContent = `${w.toFixed(w < 10 ? 2 : 1)} s of ${s.toFixed(1)} s`;
  };
  const paint = () => {
    renderView();
    if (sel && cv._map) {
      const m = cv._map, dpr = window.devicePixelRatio || 1, g = cv.getContext('2d');
      const p = (t) => m.L + (t - m.x0) / (m.x1 - m.x0) * (m.W - m.L - m.R);
      g.save(); g.scale(dpr, dpr);
      g.fillStyle = 'rgba(77,163,255,0.22)'; g.strokeStyle = '#4da3ff';
      const x = Math.min(p(sel.a), p(sel.b)), w = Math.abs(p(sel.b) - p(sel.a));
      const py = (v) => m.T + (m.hi - v) / (m.hi - m.lo) * m.sigH;
      const y = Math.min(py(sel.ya), py(sel.yb)), h = Math.abs(py(sel.yb) - py(sel.ya));
      g.fillRect(x, y, w, h); g.strokeRect(x, y, w, h);
      g.restore();
    }
  };
  setRange = (a, b) => { view.range = clampRange(a, b); paint(); };
  const setY = (a, b) => { view.yRange = clampY(a, b); paint(); };
  const zoomAt = (t, f) => { const [a, b] = view.range; setRange(t - (t - a) * f, t + (b - t) * f); };
  const zoomYAt = (v, f) => { const [a, b] = curY(); setY(v - (v - a) * f, v + (b - v) * f); };

  cv.onmousedown = (e) => { if (!view || e.button !== 0) return; sel = { a: tAt(e), b: tAt(e), ya: yAt(e), yb: yAt(e) }; };
  window.addEventListener('mousemove', (e) => { if (!sel) return; sel.b = tAt(e); sel.yb = yAt(e); paint(); });
  window.addEventListener('mouseup', () => {
    if (!sel) return;
    const { a, b, ya, yb } = sel; sel = null;
    const wide = Math.abs(b - a) > (view.range[1] - view.range[0]) * 0.01;
    const [c0, c1] = curY(), tall = Math.abs(yb - ya) > (c1 - c0) * 0.02;
    if (tall) view.yRange = clampY(Math.min(ya, yb), Math.max(ya, yb));
    if (wide) setRange(Math.min(a, b), Math.max(a, b)); else paint();
  });
  cv.addEventListener('wheel', (e) => {
    if (!view) return;
    e.preventDefault();
    if (e.ctrlKey) zoomYAt(yAt(e), Math.exp(e.deltaY * 0.002));
    else if (e.altKey) { const [a, b] = curY(), d = (e.deltaY || e.deltaX) / 500 * (b - a); setY(a - d, b - d); }
    else if (e.shiftKey) { const w = view.range[1] - view.range[0], d = (e.deltaY || e.deltaX) / 500 * w; setRange(view.range[0] + d, view.range[1] + d); }
    else zoomAt(tAt(e), Math.exp(e.deltaY * 0.002));
  }, { passive: false });
  cv.ondblclick = () => { view.yRange = null; setRange(view.full[0], view.full[1]); };
  $('vYin').onclick = () => view && (([a, b]) => zoomYAt((a + b) / 2, 0.5))(curY());
  $('vYout').onclick = () => view && (([a, b]) => zoomYAt((a + b) / 2, 2))(curY());
  $('vYauto').onclick = () => { if (view) { view.yRange = null; paint(); } };

  // vertical scrollbar for the Y axis
  const panY = (e, grab) => {
    const r = vy.getBoundingClientRect(), [f0, f1] = view.yFull, [a, b] = curY(), h = b - a;
    const top = f1 - (e.clientY - r.top) / r.height * (f1 - f0);
    setY(top - (1 - grab) * h, top - (1 - grab) * h + h);
  };
  let panningY = null;
  vy.onmousedown = (e) => {
    if (!view) return;
    const r = vy.getBoundingClientRect(), [f0, f1] = view.yFull, [a, b] = curY();
    const v = f1 - (e.clientY - r.top) / r.height * (f1 - f0);
    panningY = v >= a && v <= b ? (v - a) / (b - a) : 0.5;
    panY(e, panningY); e.preventDefault();
  };
  window.addEventListener('mousemove', (e) => { if (panningY != null && view) panY(e, panningY); });
  window.addEventListener('mouseup', () => { panningY = null; });
  $('vZin').onclick = () => view && zoomAt((view.range[0] + view.range[1]) / 2, 0.5);
  $('vZout').onclick = () => view && zoomAt((view.range[0] + view.range[1]) / 2, 2);
  $('vReset').onclick = () => { if (!view) return; view.yRange = null; setRange(view.full[0], view.full[1]); };

  // scrollbar: drag the thumb to pan, click the track to jump
  const pan = (e, grab) => {
    const r = track.getBoundingClientRect(), w = view.range[1] - view.range[0];
    const t = view.full[0] + (e.clientX - r.left) / r.width * span();
    setRange(t - grab * w, t - grab * w + w);
  };
  let panning = null;
  track.onmousedown = (e) => {
    if (!view) return;
    const r = track.getBoundingClientRect(), t = view.full[0] + (e.clientX - r.left) / r.width * span();
    const inside = t >= view.range[0] && t <= view.range[1];
    panning = inside ? (t - view.range[0]) / (view.range[1] - view.range[0]) : 0.5;
    pan(e, panning); e.preventDefault();
  };
  window.addEventListener('mousemove', (e) => { if (panning != null && view) pan(e, panning); });
  window.addEventListener('mouseup', () => { panning = null; });
  window.addEventListener('resize', paint);
})();

// ---- durability --------------------------------------------------------------------------------
async function initDurability() {
  const p = await requestPersistence();
  $('durState').textContent = !p.supported ? 'persistent storage: not supported' : p.persisted ? 'persistent storage: granted' : 'persistent storage: not granted (browser may evict data)';
  $('durState').className = 'pill' + (p.persisted ? '' : ' bad');

  const setFolder = (h) => { db.setFolder(h); $('folderState').textContent = h ? 'saving to folder: ' + h.name : 'no folder'; $('folderState').className = 'pill'; $('btnFolderGrant').hidden = true; loadFolder().catch(() => {}); };
  if (!window.showDirectoryPicker) { $('btnFolder').disabled = true; $('folderState').textContent = 'folder auto-save needs Chrome/Edge'; }
  else {
    try {
      const h = await loadFolderHandle();
      if (h) {
        if ((await h.queryPermission({ mode: 'readwrite' })) === 'granted') setFolder(h);
        else { $('folderState').textContent = `folder ${h.name}: permission needed`; $('btnFolderGrant').hidden = false; $('btnFolderGrant').onclick = async () => { if ((await h.requestPermission({ mode: 'readwrite' })) === 'granted') setFolder(h); }; }
      }
    } catch { /* ignore */ }
    $('btnFolder').onclick = async () => {
      try { const h = await showDirectoryPicker({ mode: 'readwrite', id: 'alps-logs' }); await saveFolderHandle(h); setFolder(h); }
      catch (e) { if (e.name !== 'AbortError') alert(e.message); }
    };
  }

  $('btnBackup').onclick = async () => {
    try {
      const blob = await exportBackup(db);
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
      a.download = `alps_backup_${new Date().toISOString().slice(0, 10)}.json`; a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      $('backupState').textContent = 'backup downloaded';
    } catch (e) { $('backupState').textContent = e.message; }
  };
  $('btnRestore').onclick = () => $('fileRestore').click();
  $('fileRestore').onchange = async () => {
    const f = $('fileRestore').files[0]; $('fileRestore').value = '';
    if (!f) return;
    try { const n = await importBackup(db, await f.text()); $('backupState').textContent = `restored ${n} session(s) (added as new sessions)`; loadSessions(); }
    catch (e) { $('backupState').textContent = e.message; $('backupState').className = 'pill bad'; }
  };
}

// ---- long-print capture settings --------------------------------------------------------------------
function initCapture() {
  let cfg;
  try { cfg = normalizeCapture(JSON.parse(localStorage.getItem('alpsCapture') || '{}')); } catch { cfg = normalizeCapture(); }
  const t = cfg.triggers;
  const show = (c) => {
    $('capMode').value = c.mode; $('capBucket').value = String(c.bucketS); $('capPre').value = c.preS; $('capPost').value = c.postS;
    $('trBand').checked = t.band.on; $('trBandK').value = t.band.k; $('trAbs').checked = t.abs.on; $('trAbsN').value = t.abs.counts;
    $('trSlope').checked = t.slope.on; $('trSlopeN').value = t.slope.counts; $('trSlopeW').value = t.slope.windowMs; $('trLayer').checked = t.layer.on;
  };
  const read = () => normalizeCapture({
    ...cfg, mode: $('capMode').value, bucketS: $('capBucket').value, preS: $('capPre').value, postS: $('capPost').value,
    triggers: {
      band: { on: $('trBand').checked, k: $('trBandK').value }, abs: { on: $('trAbs').checked, counts: $('trAbsN').value },
      slope: { on: $('trSlope').checked, counts: $('trSlopeN').value, windowMs: $('trSlopeW').value }, layer: { on: $('trLayer').checked },
    },
  });
  const apply = () => { cfg = read(); localStorage.setItem('alpsCapture', JSON.stringify(cfg)); rec.setCapture(cfg); };
  show(cfg); rec.setCapture(cfg);
  for (const id of ['capMode', 'capBucket', 'capPre', 'capPost', 'trBand', 'trBandK', 'trAbs', 'trAbsN', 'trSlope', 'trSlopeN', 'trSlopeW', 'trLayer']) $(id).onchange = apply;
  $('btnMark').onclick = () => rec.mark();
}

// ---- boot ------------------------------------------------------------------------------------
(async () => {
  if (!serialSupported()) $('noSerial').style.display = 'block';
  try {
    db = await IdbDb.open();
  } catch (e) {
    $('noDb').style.display = 'block'; $('noDb').textContent = 'Could not open browser storage: ' + e.message; return;
  }
  const idb = db;
  db = new MirrorDb(idb, { onError: (e) => { $('folderState').textContent = 'folder write failed: ' + e.message; $('folderState').className = 'pill bad'; } });
  rec = new Recorder(db);
  initCapture();
  tabsApi = initTabs({ db, live });
  initDurability();
  rec.onsample = pushLive;
  rec.onchange = onChange;
  window.addEventListener('beforeunload', (e) => { if (rec.session || rec.connected) { e.preventDefault(); e.returnValue = ''; } });
  $('mrUrl').value = localStorage.getItem('mrUrl') || '';
  $('mrKey').value = localStorage.getItem('mrKey') || '';
  updateMixedWarning();
  if (localStorage.getItem('mrEnabled') === '1' && $('mrUrl').value) toggleMoonraker(true);
  setInterval(renderStatus, 1000);
  setInterval(() => { if (rec.session) loadSessions(); }, 10000);
  renderStatus(); renderLive(); loadSessions();
})();
