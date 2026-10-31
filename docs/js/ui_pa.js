import { DEFAULT_PA, kValues, genGcode, analyzePa } from './pa.js';
import { loadColumns } from './sync.js';
import { colorAt } from './viewer3d.js';

const $ = (id) => document.getElementById(id);
const f = (v, d = 3) => (Number.isFinite(v) ? v.toFixed(d) : '–');
const NUM = ['kstart', 'kend', 'kstep', 'cycles', 'tslow', 'tfast', 'tgap', 'vfr', 'wobble', 'parkx', 'parky', 'parkz', 'vSlow', 'vFast', 'width', 'height', 'x0', 'y0', 'yStep', 'retract', 'bedLen', 'filament', 'accel'];
let last = null, lastAnalysis = null;

function readParams() {
  const p = { ...DEFAULT_PA, mode: $('pMode').value, axis: $('pAxis').value };
  for (const k of NUM) { const el = $('p_' + k); if (el && el.value !== '') p[k] = +el.value; }
  p.vfrLow = +$('p_vfrLow').value;
  p.x = p.parkx; p.y = p.parky; p.z = p.parkz;
  return p;
}

function lineChart(canvas, series, { xlabel = '', ylabel = '' } = {}) {
  const dpr = window.devicePixelRatio || 1, w = canvas.clientWidth, h = canvas.clientHeight;
  canvas.width = w * dpr; canvas.height = h * dpr;
  const c = canvas.getContext('2d'); c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, w, h);
  const pts = series.flatMap((s) => s.x.map((x, i) => [x, s.y[i]])).filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
  if (!pts.length) return;
  let x0 = Math.min(...pts.map((p) => p[0])), x1 = Math.max(...pts.map((p) => p[0]));
  let y0 = Math.min(...pts.map((p) => p[1])), y1 = Math.max(...pts.map((p) => p[1]));
  if (y1 === y0) { y1 += 1; y0 -= 1; }
  if (x1 === x0) x1 += 1;
  const L = 46, R = 8, T = 8, B = 22;
  const X = (x) => L + ((x - x0) / (x1 - x0)) * (w - L - R), Y = (y) => h - B - ((y - y0) / (y1 - y0)) * (h - T - B);
  c.strokeStyle = '#8884'; c.fillStyle = '#888'; c.font = '11px sans-serif';
  c.beginPath(); c.moveTo(L, T); c.lineTo(L, h - B); c.lineTo(w - R, h - B); c.stroke();
  if (y0 < 0 && y1 > 0) { c.beginPath(); c.moveTo(L, Y(0)); c.lineTo(w - R, Y(0)); c.stroke(); }
  c.fillText(f(y1, 2), 2, T + 8); c.fillText(f(y0, 2), 2, h - B);
  c.fillText(f(x0, 2) + ' ' + xlabel, L, h - 6); c.fillText(f(x1, 2), w - R - 28, h - 6);
  if (ylabel) c.fillText(ylabel, L + 6, T + 10);
  for (const s of series) {
    c.strokeStyle = s.color; c.lineWidth = s.width || 1.5; c.beginPath();
    let pen = false;
    s.x.forEach((x, i) => {
      const y = s.y[i];
      if (!Number.isFinite(x) || !Number.isFinite(y)) { pen = false; return; }
      pen ? c.lineTo(X(x), Y(y)) : c.moveTo(X(x), Y(y)); pen = true;
    });
    c.stroke();
    if (s.dots) for (let i = 0; i < s.x.length; i++) if (Number.isFinite(s.y[i])) { c.fillStyle = s.color; c.beginPath(); c.arc(X(s.x[i]), Y(s.y[i]), 3, 0, 7); c.fill(); }
  }
  if (series.vline && Number.isFinite(series.vline)) { c.strokeStyle = '#d33'; c.setLineDash([4, 3]); c.beginPath(); c.moveTo(X(series.vline), T); c.lineTo(X(series.vline), h - B); c.stroke(); c.setLineDash([]); }
}

export function initPa({ db }) {
  const p = DEFAULT_PA;
  for (const k of NUM) { const el = $('p_' + k); if (!el) continue; const key = { parkx: p.x, parky: p.y, parkz: p.z }[k]; el.value = key ?? p[k] ?? el.value; }
  $('p_vfrLow').value = p.vfrLow;

  $('pGen').onclick = () => {
    try {
      last = genGcode(readParams());
      $('pOut').value = last.gcode;
      $('pInfo').textContent = `${last.ks.length} K values (${last.ks[0]}…${last.ks[last.ks.length - 1]}), about ${last.seconds} s`;
      $('pInfo').className = 'pill';
      $('pNotes').innerHTML = last.notes.map((n) => `<p class="note"></p>`).join('');
      [...$('pNotes').children].forEach((el, i) => (el.textContent = last.notes[i]));
      $('pDl').disabled = false;
    } catch (e) { last = null; $('pInfo').textContent = e.message; $('pInfo').className = 'pill bad'; $('pDl').disabled = true; }
  };
  $('pDl').onclick = () => {
    if (!last) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([last.gcode], { type: 'text/plain' }));
    a.download = `pa_${readParams().mode}_test.gcode`; a.click(); URL.revokeObjectURL(a.href);
  };

  async function refresh() {
    const rows = await db.listSessions(), sel = $('aSession'), keep = sel.value;
    sel.innerHTML = '<option value="">– choose –</option>';
    for (const s of rows) { const o = document.createElement('option'); o.value = s.id; o.textContent = `#${s.id} ${s.name} (${s.n} samples)`; sel.append(o); }
    if (keep) sel.value = keep;
  }

  $('aRun').onclick = async () => {
    const out = $('aStatus');
    try {
      const id = +$('aSession').value;
      if (!id) throw new Error('Choose a recorded session');
      const q = readParams();
      const cols = await loadColumns(db, id, await db.getSession(id));
      // raw counts, so smoothing does not blur the edges
      const t = [], use = [];
      for (let i = 0; i < cols.n; i++) if (Number.isFinite(cols.t[i]) && Number.isFinite(cols.raw[i])) { t.push(cols.t[i]); use.push(cols.raw[i]); }
      const opt = { tslow: q.tslow, tfast: q.tfast, tgap: q.tgap, cycles: q.cycles, ks: kValues(q), invert: $('aInvert').value, blockOffset: +$('aOffset').value || 0 };
      const ts = parseFloat($('aStart').value), te = parseFloat($('aEnd').value);
      if (Number.isFinite(ts)) opt.tStart = ts; if (Number.isFinite(te)) opt.tEnd = te;
      const t0 = t[0];
      const tt = Float64Array.from(t, (x) => x - t0);
      lastAnalysis = analyzePa(tt, Float64Array.from(use), opt);
      render(lastAnalysis);
      out.textContent = lastAnalysis.ok ? `${lastAnalysis.nBursts} bursts in ${lastAnalysis.nBlocks} K blocks` : lastAnalysis.message;
      out.className = 'pill' + (lastAnalysis.ok ? '' : ' bad');
    } catch (e) { out.textContent = e.message; out.className = 'pill bad'; }
  };

  function render(a) {
    $('aResult').hidden = !a.ok;
    $('aWarn').innerHTML = '';
    for (const w of a.warnings || []) { const e = document.createElement('p'); e.className = 'note'; e.textContent = w; $('aWarn').append(e); }
    if (!a.ok) return;
    $('aKc').textContent = `K (composite) = ${f(a.kComposite, 4)}`;
    $('aKs').textContent = `K (signed zero) = ${f(a.kSigned, 4)}`;
    const body = $('aRows'); body.innerHTML = '';
    for (const r of a.rows) {
      const tr = document.createElement('tr');
      tr.innerHTML = ['k', 'nBursts', 'step', 'overshoot', 'undershoot', 'creep', 'tail', 'S'].map((k) => `<td>${k === 'nBursts' ? r[k] : f(r[k], k === 'k' ? 4 : 3)}</td>`).join('');
      body.append(tr);
    }
    const n = a.rows.length;
    const ov = a.overlay.map((o, i) => o && { x: o.x, y: o.y, color: `rgb(${colorAt(n > 1 ? i / (n - 1) : 0)})`, width: 1.3 }).filter(Boolean);
    lineChart($('aOverlay'), ov, { xlabel: 's from rise', ylabel: 'normalised burst, colour = K (low→high)' });
    const kk = a.rows.map((r) => r.k);
    const sMax = Math.max(...a.rows.map((r) => Math.abs(r.S)).filter(Number.isFinite), 1e-9), cMax = Math.max(...a.cost.filter(Number.isFinite), 1e-9);
    const S = [
      { x: kk, y: a.rows.map((r) => r.S / sMax), color: '#2a7', dots: true },
      { x: kk, y: a.cost.map((x) => x / cMax), color: '#47c', dots: true },
    ];
    S.vline = a.kSigned;
    lineChart($('aMetric'), S, { xlabel: 'K', ylabel: 'green = S (signed edge error), blue = composite cost (both normalised)' });
  }

  return { refresh };
}
