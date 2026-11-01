import { parseGcode } from './gcode.js';
import { TimeMap, autoSync, aggregate, extractPoses, loadColumns, percentile, medianOf } from './sync.js';
import { Viewer, toBins, gradientCss } from './viewer3d.js';
import { initPa } from './ui_pa.js';
import { fillSessionSelect, parseSessionId } from './persist.js';
import { MoonrakerPoller } from './moonraker.js';
import { loadCalib, saveCalib, fitCalibration, toUnits, isCalibrated, unitLabel, estimateCountsPerGram, REFERENCE_NOTES, DEFAULT_CALIB } from './calib.js';

const $ = (id) => document.getElementById(id);
const fmtV = (v) => (Number.isFinite(v) ? (Math.abs(v) >= 1000 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(3)) : '–');

export function initTabs({ db, live }) {
  let calib = loadCalib(localStorage);
  const S = { id: null, session: null, cols: null, poses: null, g: null, map: null, agg: null, aggSignal: null };
  let viewer = null, pa = null;

  // ---- tabs -------------------------------------------------------------------------
  const show = (name) => {
    document.querySelectorAll('nav.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === name));
    for (const t of ['live', 'sessions', 'gcode', 'calib', 'pa', 'settings']) $('tab-' + t).hidden = t !== name;
    if (name === 'live' || name === 'sessions') window.dispatchEvent(new Event('resize'));
    if (name === 'pa') { if (!pa) pa = initPa({ db }); pa.refresh(); }
    if (name === 'gcode') { if (!viewer) { viewer = new Viewer($('v3d')); if (S.g) viewer.setModel(S.g); recolor(); } refreshSessions(); viewer.redraw(); }
  };
  document.querySelectorAll('nav.tabs button').forEach((b) => (b.onclick = () => show(b.dataset.tab)));

  // ---- G-code tab ---------------------------------------------------------------------
  async function refreshSessions() { await fillSessionSelect($('gSession'), db); }
  const setSync = (txt, cls = '') => { $('gSync').textContent = txt; $('gSync').className = 'pill ' + cls; };

  $('gSession').onchange = async () => {
    const id = parseSessionId($('gSession').value);
    S.id = id || null; S.cols = S.poses = S.map = S.agg = null;
    if (!id) return recolor();
    setSync('loading session…');
    try {
      S.session = await db.getSession(id);
      S.cols = await loadColumns(db, id, S.session);
    } catch (e) { setSync(e.message, 'bad'); return recolor(); }
    S.poses = extractPoses(S.cols);
    setSync((S.cols.fromEnv ? 'using envelope (' + S.cols.n + ' buckets); ' : '') + (S.poses.n ? `${S.poses.n} logged positions` : 'no positions logged: use manual offset'), S.poses.n ? '' : 'bad');
    if (S.g) await runAuto(true); else recolor();
  };

  async function loadGcodeText(text, name) {
    $('gInfo').textContent = 'parsing…';
    await new Promise((r) => setTimeout(r));
    S.g = parseGcode(text);
    const g = S.g;
    $('gInfo').textContent = `${name}: ${g.nExtrude} extrusion segments, ${g.layerStart.length} layers, est. ${(g.totalTime / 60).toFixed(1)} min`;
    const mx = Math.max(0, g.layerStart.length - 1);
    $('gLayer').max = mx; $('gLayer').value = mx; $('gLayerTxt').textContent = `${mx + 1}/${mx + 1}`;
    if (viewer) viewer.setModel(g);
    S.map = S.agg = null;
    if (S.cols) await runAuto(true); else recolor();
  }
  $('gFile').onchange = async (e) => { const f = e.target.files[0]; if (f) loadGcodeText(await f.text(), f.name).catch((x) => alert(x.message)); };
  $('gFetch').onclick = async () => {
    const url = $('mrUrl').value.trim();
    const name = (S.session && S.session.file) || prompt('G-code file name on Moonraker (e.g. part.gcode)');
    if (!url || !name) return alert('Enter the Moonraker URL on the first tab and select a session printed from a file.');
    try {
      const text = await new MoonrakerPoller(url, () => {}, { apiKey: $('mrKey').value.trim() }).fetchGcode(name);
      await loadGcodeText(text, name);
    } catch (e) { alert('Fetch failed: ' + e.message); }
  };

  async function runAuto(silent) {
    if (!S.g || !S.cols) return;
    if (!S.poses.n) { if (!silent) alert('This session has no logged toolhead positions. Use manual offset/scale.'); return recolor(); }
    setSync('fitting…');
    await new Promise((r) => setTimeout(r, 30));
    const r = autoSync(S.g, S.poses);
    if (!r) { S.map = null; setSync('auto-fit failed: use manual offset', 'bad'); return recolor(); }
    S.map = r.map; $('gOff').value = r.firstOffset.toFixed(1);
    setSync(`fitted ${r.matched}/${r.windows} windows, rms ${r.rmsMm} mm, print ${(r.printSeconds / 60).toFixed(1)} min`, 'ok');
    S.agg = null; recolor();
  }
  $('gAuto').onclick = () => runAuto(false);
  $('gManual').onclick = () => {
    if (!S.g || !S.cols) return alert('Choose a session and G-code first.');
    const off = +$('gOff').value, sc = +$('gScale').value;
    if (!Number.isFinite(off) || !(sc > 0)) return alert('Invalid offset/scale');
    S.map = TimeMap.linear(off, sc, S.g.totalTime); S.agg = null;
    setSync(`manual offset ${off}s, scale ${sc}`, 'ok'); recolor();
  };

  function recolor() {
    if (!viewer) return;
    $('gBar').style.background = gradientCss();
    if (!S.g || !S.map || !S.cols) { viewer.setBins(null); $('gLoTxt').textContent = $('gHiTxt').textContent = '–'; return; }
    const signal = $('gSignal').value;
    if (!S.agg || S.aggSignal !== signal) { S.agg = aggregate(S.g, S.map, S.cols, signal); S.aggSignal = signal; }
    const auto = medianOf(S.cols[signal]);
    const m = $('gMetric').value, n = S.g.n;
    const vals = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      if (m === 'dev') {
        const a = S.agg.min[i], b = S.agg.max[i];
        vals[i] = Number.isFinite(a) ? Math.max(Math.abs(toUnits(a, calib, auto)), Math.abs(toUnits(b, calib, auto))) : NaN;
      } else {
        const v = S.agg[m][i];
        vals[i] = Number.isFinite(v) ? toUnits(v, calib, auto) : NaN;
      }
    }
    let lo = $('gLo').value === '' ? percentile(vals, 2) : +$('gLo').value;
    let hi = $('gHi').value === '' ? percentile(vals, 98) : +$('gHi').value;
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) { hi = (Number.isFinite(lo) ? lo : 0) + 1; }
    const u = unitLabel(calib);
    $('gLoTxt').textContent = `${fmtV(lo)} ${u}`; $('gHiTxt').textContent = `${fmtV(hi)} ${u}`;
    viewer.setBins(toBins(vals, lo, hi));
  }
  for (const id of ['gMetric', 'gSignal', 'gLo', 'gHi']) $(id).onchange = recolor;
  $('gTravel').onchange = () => { if (viewer) { viewer.showTravel = $('gTravel').checked; viewer.redraw(); } };
  document.querySelectorAll('button[data-view]').forEach((b) => (b.onclick = () => viewer && viewer.preset(b.dataset.view)));
  $('gLayer').oninput = () => {
    const mx = +$('gLayer').max, v = +$('gLayer').value;
    $('gLayerTxt').textContent = `${v + 1}/${mx + 1}`;
    if (viewer) { viewer.layerMax = v >= mx ? Infinity : v; viewer.redraw(); }
  };

  // ---- calibration tab ----------------------------------------------------------------------
  function recent(sec) {
    const n = live.t.length;
    if (!n) return null;
    const end = live.t[n - 1];
    let i = n - 1; while (i > 0 && live.t[i - 1] >= end - sec) i--;
    const v = live.filt.slice(i).filter(Number.isFinite);
    if (!v.length) return null;
    const mean = v.reduce((a, b) => a + b, 0) / v.length;
    const sd = Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / v.length);
    return { mean, sd, n: v.length };
  }
  const persist = () => { saveCalib(localStorage, calib); renderCalib(); recolor(); };
  function renderCalib() {
    $('cUnitSel').value = calib.unit; $('cInvert').checked = calib.invert;
    $('cUnit').textContent = unitLabel(calib);
    $('cState').textContent = isCalibrated(calib) ? `${calib.estimated ? 'ESTIMATED' : 'calibrated'}: ${fmtV(calib.countsPerGram)} counts/g, tare ${fmtV(calib.tare)}` : `arbitrary counts (uncalibrated)${Number.isFinite(calib.tare) ? ', tare ' + fmtV(calib.tare) : ''}`;
    const tb = $('cPts'); tb.innerHTML = '';
    calib.points.forEach((p, i) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${p.grams}</td><td>${fmtV(p.counts)}</td><td></td>`;
      const d = document.createElement('button'); d.textContent = 'Remove'; d.className = 'danger';
      d.onclick = () => { calib.points.splice(i, 1); persist(); };
      tr.children[2].append(d); tb.append(tr);
    });
    const fit = fitCalibration(calib.points);
    $('cFit').textContent = fit ? `${fit.countsPerGram.toFixed(3)} counts/g, tare ${fit.tare.toFixed(0)}, R² ${fit.r2.toFixed(4)}` : 'need at least 2 points with different masses';
    $('cApply').disabled = !fit || fit.countsPerGram === 0;
  }
  $('cTare').onclick = () => {
    const r = recent(+$('cAvg').value); if (!r) return alert('No live data: connect the device first.');
    calib.tare = r.mean; persist();
  };
  $('cPoint').onclick = () => {
    const r = recent(+$('cAvg').value), g = +$('cMass').value;
    if (!r) return alert('No live data: connect the device first.');
    if (!Number.isFinite(g) || g < 0) return alert('Enter the mass in grams.');
    calib.points.push({ grams: g, counts: r.mean }); persist();
  };
  $('cApply').onclick = () => {
    const fit = fitCalibration(calib.points); if (!fit) return;
    calib.tare = fit.tare; calib.countsPerGram = fit.countsPerGram; calib.estimated = false; persist();
  };
  $('cReset').onclick = () => { if (confirm('Reset to arbitrary counts?')) { calib = { ...DEFAULT_CALIB, points: [] }; persist(); } };
  $('cUnitSel').onchange = () => { calib.unit = $('cUnitSel').value; persist(); };
  $('cInvert').onchange = () => { calib.invert = $('cInvert').checked; persist(); };

  $('cNotes').innerHTML = '';
  for (const n of REFERENCE_NOTES) {
    const d = document.createElement('div'); d.className = 'note';
    const b = document.createElement('b'); b.textContent = n.title + ': ';
    const a = document.createElement('a'); a.href = n.url; a.target = '_blank'; a.rel = 'noopener'; a.textContent = 'source';
    d.append(b, n.body + ' ', a); $('cNotes').append(d);
  }
  $('eSensor').onchange = () => { const v = $('eSensor').value; if (v) { const [c, s] = v.split(','); $('eCap').value = c; $('eSens').value = s; } };
  let est = null;
  $('eCalc').onclick = () => {
    est = estimateCountsPerGram({ capacityKg: +$('eCap').value, sensitivityMvV: +$('eSens').value, excitationV: +$('eExc').value, gain: +$('eGain').value });
    const ok = Number.isFinite(est.countsPerGram) && est.countsPerGram > 0;
    $('eOut').textContent = ok ? `≈ ${est.countsPerGram.toFixed(0)} counts/g (${est.nanovoltsPerCount.toFixed(2)} nV/count)` : 'invalid inputs';
    $('eUse').disabled = !ok; if (!ok) est = null;
  };
  $('eUse').onclick = () => {
    if (!est || !confirm('Use this theoretical estimate? Values will be approximate; a known-mass calibration is more accurate.')) return;
    if (!Number.isFinite(calib.tare)) { const r = recent(3); if (r) calib.tare = r.mean; }
    calib.countsPerGram = est.countsPerGram; calib.estimated = true; persist();
  };

  setInterval(() => {
    if ($('tab-calib').hidden) return;
    const r = recent(+$('cAvg').value);
    if (!r) { $('cVal').textContent = '–'; return; }
    const auto = Number.isFinite(calib.tare) ? calib.tare : 0;
    $('cVal').textContent = fmtV(toUnits(r.mean, calib, auto));
    $('cNoise').textContent = `noise σ ${r.sd.toFixed(1)} counts`;
  }, 250);
  renderCalib();
  return {
    refreshSessions,
    async openInGcode(id) {
      show('gcode'); await refreshSessions();
      $('gSession').value = String(id); $('gSession').dispatchEvent(new Event('change'));
    },
  };
}
