// Canvas chart. data = {t:[], raw:[], lo:[], hi:[], filt:[], z:[]}  (t in seconds)
export function drawChart(canvas, data, o) {
  const dpr = window.devicePixelRatio || 1, W = canvas.clientWidth, H = canvas.clientHeight;
  canvas.width = W * dpr; canvas.height = H * dpr;
  const g = canvas.getContext('2d'); g.scale(dpr, dpr);
  g.fillStyle = '#101215'; g.fillRect(0, 0, W, H);
  const L = 56, R = 12, T = 8, B = 22;
  const hasZ = data.z.some((v) => v != null);
  const zH = hasZ ? Math.round((H - T - B) * 0.25) : 0, gap = hasZ ? 8 : 0;
  const sigH = H - T - B - zH - gap;
  const [x0, x1] = o.xRange;
  const px = (t) => L + (t - x0) / (x1 - x0 || 1) * (W - L - R);
  canvas._map = { L, R, W, x0, x1 };
  const idx = [];
  for (let i = 0; i < data.t.length; i++) if (data.t[i] >= x0 && data.t[i] <= x1) idx.push(i);
  const vals = [];
  for (const i of idx) for (const k of ['lo', 'hi', 'filt']) if (data[k][i] != null) vals.push(data[k][i]);
  if (o.threshold != null) vals.push(o.threshold);
  let lo = Infinity, hi = -Infinity;
  for (const v of vals) { if (v < lo) lo = v; if (v > hi) hi = v; }
  if (!isFinite(lo)) { lo = 0; hi = 1; }
  const pad = (hi - lo || 1) * 0.08; lo -= pad; hi += pad;
  if (o.yRange) { lo = o.yRange[0]; hi = o.yRange[1]; }
  const py = (v) => T + sigH - (v - lo) / (hi - lo) * sigH;
  Object.assign(canvas._map, { T, sigH, lo, hi });
  g.font = '11px monospace'; g.fillStyle = '#8a919c'; g.strokeStyle = '#262b33'; g.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = T + sigH * i / 4; g.beginPath(); g.moveTo(L, y); g.lineTo(W - R, y); g.stroke();
    g.textAlign = 'right'; g.fillText(Math.round(hi - (hi - lo) * i / 4), L - 6, y + 4);
  }
  g.textAlign = 'center';
  for (let i = 0; i <= 6; i++) {
    const t = x0 + (x1 - x0) * i / 6; g.fillText((t - o.tZero).toFixed(1) + 's', px(t), H - 6);
  }
  const line = (arr, color, w) => {
    g.strokeStyle = color; g.lineWidth = w; g.beginPath(); let pen = false;
    for (const i of idx) {
      const v = arr[i]; if (v == null) { pen = false; continue; }
      const x = px(data.t[i]), y = py(v); pen ? g.lineTo(x, y) : g.moveTo(x, y); pen = true;
    }
    g.stroke();
  };
  g.save(); g.beginPath(); g.rect(L, T, W - L - R, sigH); g.clip();
  if (o.band) {
    g.fillStyle = 'rgba(255,167,38,0.25)'; g.beginPath(); let started = false;
    for (const i of idx) if (data.hi[i] != null) { const x = px(data.t[i]), y = py(data.hi[i]); started ? g.lineTo(x, y) : g.moveTo(x, y); started = true; }
    for (let k = idx.length - 1; k >= 0; k--) { const i = idx[k]; if (data.lo[i] != null) g.lineTo(px(data.t[i]), py(data.lo[i])); }
    g.fill();
  }
  line(data.raw, '#ffa726', 1); line(data.filt, '#4da3ff', 1.5);
  if (o.threshold != null) {
    g.setLineDash([6, 4]); g.strokeStyle = '#ff6b6b'; g.beginPath(); g.moveTo(L, py(o.threshold)); g.lineTo(W - R, py(o.threshold)); g.stroke(); g.setLineDash([]);
  }
  g.restore();
  if (hasZ) {
    let zl = Infinity, zh = -Infinity;
    for (const i of idx) { const v = data.z[i]; if (v != null) { if (v < zl) zl = v; if (v > zh) zh = v; } }
    if (!isFinite(zl)) { zl = 0; zh = 1; }
    if (zh === zl) { zh += 1; zl -= 1; }
    const top = T + sigH + gap, zy = (v) => top + zH - (v - zl) / (zh - zl) * zH;
    g.strokeStyle = '#262b33'; g.strokeRect(L, top, W - L - R, zH);
    g.fillStyle = '#8a919c'; g.textAlign = 'right'; g.fillText(zh.toFixed(1), L - 6, top + 10); g.fillText(zl.toFixed(1), L - 6, top + zH);
    g.strokeStyle = '#7bd88f'; g.lineWidth = 1.2; g.beginPath(); let pen = false;
    for (const i of idx) {
      const v = data.z[i]; if (v == null) { pen = false; continue; }
      const x = px(data.t[i]), y = zy(v); pen ? g.lineTo(x, y) : g.moveTo(x, y); pen = true;
    }
    g.stroke();
  }
}
