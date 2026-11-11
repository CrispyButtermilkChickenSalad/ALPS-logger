// Dependency-free canvas renderer for a parsed G-code toolpath, coloured per segment.
export const NBINS = 24;
export const NO_DATA = 255;

const STOPS = [[0, [49, 54, 149]], [0.25, [69, 117, 180]], [0.45, [116, 173, 209]], [0.55, [102, 189, 99]], [0.7, [254, 224, 82]], [0.85, [244, 109, 67]], [1, [165, 0, 38]]];
export function colorAt(f) {
  f = Math.min(1, Math.max(0, f));
  for (let i = 1; i < STOPS.length; i++) {
    if (f <= STOPS[i][0]) {
      const [a, ca] = STOPS[i - 1], [b, cb] = STOPS[i], u = (f - a) / (b - a);
      return ca.map((v, k) => Math.round(v + (cb[k] - v) * u));
    }
  }
  return STOPS[STOPS.length - 1][1];
}
export const binColor = (b) => { const c = colorAt((b + 0.5) / NBINS); return `rgb(${c[0]},${c[1]},${c[2]})`; };
export const gradientCss = () => `linear-gradient(to right, ${Array.from({ length: 12 }, (_, i) => { const c = colorAt(i / 11); return `rgb(${c})`; }).join(',')})`;

// values: per-segment numbers (NaN = no data) -> bin indices
export function toBins(values, lo, hi) {
  const out = new Uint8Array(values.length), span = hi - lo || 1;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    out[i] = Number.isFinite(v) ? Math.min(NBINS - 1, Math.max(0, Math.floor(((v - lo) / span) * NBINS))) : NO_DATA;
  }
  return out;
}

export class Viewer {
  constructor(canvas) {
    this.cv = canvas; this.g = null; this.bins = null; this.curve = null; this.curveBins = null; this.cursor = null;
    this.yaw = -0.6; this.pitch = 0.6; this.zoom = 1; this.pan = [0, 0];
    this.layerMax = Infinity; this.showTravel = false; this.dragging = false;
    this._raf = 0;
    let last = null;
    canvas.addEventListener('pointerdown', (e) => { last = [e.clientX, e.clientY, e.shiftKey || e.button === 2]; canvas.setPointerCapture(e.pointerId); this.dragging = true; });
    canvas.addEventListener('pointermove', (e) => {
      if (!last) return;
      const dx = e.clientX - last[0], dy = e.clientY - last[1];
      if (last[2]) { this.pan[0] += dx; this.pan[1] += dy; } else { this.yaw += dx * 0.008; this.pitch = Math.min(Math.PI / 2, Math.max(0, this.pitch + dy * 0.008)); }
      last = [e.clientX, e.clientY, last[2]]; this.redraw();
    });
    const up = () => { last = null; this.dragging = false; this.redraw(); };
    canvas.addEventListener('pointerup', up); canvas.addEventListener('pointercancel', up);
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener('wheel', (e) => { e.preventDefault(); this.zoom = Math.min(50, Math.max(0.2, this.zoom * Math.exp(-e.deltaY * 0.0015))); this.dragging = true; this.redraw(); clearTimeout(this._wt); this._wt = setTimeout(() => { this.dragging = false; this.redraw(); }, 150); }, { passive: false });
    canvas.addEventListener('dblclick', () => this.preset('iso'));
    new ResizeObserver(() => this.redraw()).observe(canvas);
  }
  setModel(g) { this.g = g; this.bins = this.curve = this.curveBins = null; this.preset('iso'); }
  setBins(bins) { this.bins = bins; this.curve = this.curveBins = null; this.redraw(); }
  setCurve(curve, bins) { this.curve = curve; this.curveBins = bins; this.bins = null; this.redraw(); }
  setCursor(xyz) { this.cursor = xyz; this.redraw(); }
  preset(name) {
    const p = { iso: [-0.6, 0.6], top: [0, Math.PI / 2], front: [0, 0], side: [Math.PI / 2, 0] }[name] || [-0.6, 0.6];
    [this.yaw, this.pitch] = p; this.zoom = 1; this.pan = [0, 0]; this.redraw();
  }
  redraw() { if (!this._raf) this._raf = requestAnimationFrame(() => { this._raf = 0; this.draw(); }); }
  draw() {
    const cv = this.cv, dpr = window.devicePixelRatio || 1;
    const w = cv.clientWidth, h = cv.clientHeight;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#101215'; ctx.fillRect(0, 0, w, h);
    const g = this.g;
    if (!g || !g.n) return;
    const b = g.bounds, cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2, cz = (b.minZ + b.maxZ) / 2;
    const cy_ = Math.cos(this.yaw), sy = Math.sin(this.yaw), cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    const ext = Math.hypot(b.maxX - b.minX, b.maxY - b.minY, b.maxZ - b.minZ) || 1;
    const sc = (Math.min(w, h) * 0.9 / ext) * this.zoom;
    const ox = w / 2 + this.pan[0], oy = h / 2 + this.pan[1];
    const PX = (x, y) => ox + ((x - cx) * cy_ - (y - cy) * sy) * sc;
    const PY = (x, y, z) => oy - ((z - cz) * cp + ((x - cx) * sy + (y - cy) * cy_) * sp) * sc;
    const end = Number.isFinite(this.layerMax) && this.layerMax + 1 < g.layerStart.length ? g.layerStart[this.layerMax + 1] : g.n;
    const step = this.dragging ? Math.max(1, Math.ceil(end / 80000)) : 1;
    const curveStep = this.dragging && this.curve ? Math.max(1, Math.ceil(this.curve.n / 80000)) : 1;
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    const colors = Array.from({ length: NBINS }, (_, i) => binColor(i));
    const style = (bin) => {
      if (bin === 254) { ctx.strokeStyle = 'rgba(120,120,120,0.35)'; ctx.lineWidth = 0.5; }
      else { ctx.strokeStyle = bin === NO_DATA ? '#5b616b' : colors[bin]; ctx.lineWidth = Math.max(0.8, Math.min(3, sc * 0.45)); }
    };
    let cur = -1, open = false;
    const stroke = (i, from, to, bin) => {
      if (to <= from) return;
      if (bin !== cur) { if (open) ctx.stroke(); ctx.beginPath(); style(bin); cur = bin; open = true; }
      const x = g.x0[i], y = g.y0[i], z = g.z0[i], dx = g.x1[i] - x, dy = g.y1[i] - y, dz = g.z1[i] - z;
      ctx.moveTo(PX(x + dx * from, y + dy * from), PY(x + dx * from, y + dy * from, z + dz * from));
      ctx.lineTo(PX(x + dx * to, y + dy * to), PY(x + dx * to, y + dy * to, z + dz * to));
    };
    for (let i = 0; i < end; i += step) {
      const f = g.flags[i];
      if (f & 4) continue;
      if (!(f & 1) && !this.showTravel) continue;
      if (this.curve) {
        let from = 0;
        for (let k = this.curve.offsets[i]; k < this.curve.offsets[i + 1]; k += curveStep) {
          stroke(i, from, this.curve.f0[k], NO_DATA);
          stroke(i, this.curve.f0[k], this.curve.f1[k], this.curveBins[k]);
          from = this.curve.f1[k];
        }
        stroke(i, from, 1, NO_DATA);
      } else stroke(i, 0, 1, !(f & 1) ? 254 : this.bins ? this.bins[i] : NO_DATA);
    }
    if (open) ctx.stroke();
    // bed outline for orientation
    ctx.strokeStyle = 'rgba(77,163,255,0.35)'; ctx.lineWidth = 1; ctx.beginPath();
    [[b.minX, b.minY], [b.maxX, b.minY], [b.maxX, b.maxY], [b.minX, b.maxY], [b.minX, b.minY]].forEach(([x, y], i) => { const px = PX(x, y), py = PY(x, y, b.minZ); i ? ctx.lineTo(px, py) : ctx.moveTo(px, py); });
    ctx.stroke();
    if (this.cursor) {
      const [x, y, z] = this.cursor;
      ctx.fillStyle = '#fff'; ctx.strokeStyle = '#101215'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(PX(x, y), PY(x, y, z), 5, 0, 2 * Math.PI); ctx.fill(); ctx.stroke();
    }
  }
}
