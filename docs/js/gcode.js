// G-code -> toolpath segments with an estimated (Klipper-like) timeline.
// Segment flags: 1 = extruding move, 0 = travel, 4 = no geometry (dwell / extruder-only move, time only).

class Grow {
  constructor(Type) { this.Type = Type; this.a = new Type(1 << 16); this.n = 0; }
  push(v) {
    if (this.n === this.a.length) { const b = new this.Type(this.a.length * 2); b.set(this.a); this.a = b; }
    this.a[this.n++] = v;
  }
  done() { return this.a.slice(0, this.n); }
}

export const EXTRUDE = 1;
export const NOGEOM = 4;

export function parseGcode(text, opts = {}) {
  const o = { accel: 3000, scv: 5, defaultSpeed: 50, arcStep: 0.5, ...opts };
  const sx = new Grow(Float32Array), sy = new Grow(Float32Array), sz = new Grow(Float32Array);
  const ex = new Grow(Float32Array), ey = new Grow(Float32Array), ez = new Grow(Float32Array);
  const sa = new Grow(Float32Array), ea = new Grow(Float32Array);
  const fl = new Grow(Uint8Array), vc = new Grow(Float32Array), ac = new Grow(Float32Array), fx = new Grow(Float32Array);
  const fileEnd = new Grow(Float64Array), fileSegment = new Grow(Int32Array);
  const fileX = new Grow(Float32Array), fileY = new Grow(Float32Array), fileZ = new Grow(Float32Array);
  const encoder = new TextEncoder();
  let fileSize = 0;
  let pa = 0, na = 0, px = 0, py = 0, pz = 0, pe = 0, abs = true, eAbs = true, f = o.defaultSpeed * 60, accel = o.accel, spd = 1;

  const push = (x0, y0, z0, x1, y1, z1, flag, v, fixed) => {
    sx.push(x0); sy.push(y0); sz.push(z0); ex.push(x1); ey.push(y1); ez.push(z1);
    fl.push(flag); vc.push(v); ac.push(accel); fx.push(fixed);
    sa.push(pa); ea.push(na);
  };
  const move = (nx, ny, nz, de) => {
    const L = Math.hypot(nx - px, ny - py, nz - pz);
    const v = Math.max(1, (f / 60) * spd);
    const dA = Math.abs(na - pa);
    if (L < 1e-9) {
      // A-only move time assumes F is a rotary speed in deg/min; this is an estimate, not firmware kinematics.
      if (Math.abs(de) > 1e-9 || dA > 1e-9) push(px, py, pz, px, py, pz, NOGEOM, v, Math.max(Math.abs(de), dA) / v);
    } else {
      push(px, py, pz, nx, ny, nz, de > 1e-9 ? EXTRUDE : 0, v, 0);
    }
    px = nx; py = ny; pz = nz; pa = na;
  };

  const re = /([A-Za-z])\s*([-+]?(?:\d+\.?\d*|\.\d+))/g;
  let pos = 0;
  while (pos < text.length) {
    let nl = text.indexOf('\n', pos);
    if (nl < 0) nl = text.length;
    let line = text.slice(pos, nl);
    const raw = text.slice(pos, nl < text.length ? nl + 1 : nl);
    fileSize += /[^\x00-\x7f]/.test(raw) ? encoder.encode(raw).length : raw.length;
    pos = nl + 1;
    const sc = line.indexOf(';');
    if (sc >= 0) line = line.slice(0, sc);
    line = line.trim();
    if (!line) continue;
    const m = /^([GMgm])0*(\d+)/.exec(line);
    if (!m) continue;
    const code = m[1].toUpperCase() + parseInt(m[2], 10);
    const w = {};
    re.lastIndex = m[0].length;
    let a;
    while ((a = re.exec(line))) w[a[1].toUpperCase()] = parseFloat(a[2]);
    const oldN = sx.n, oldX = px, oldY = py, oldZ = pz;

    switch (code) {
      case 'G0': case 'G1': case 'G2': case 'G3': {
        const nx = w.X !== undefined ? (abs ? w.X : px + w.X) : px;
        const ny = w.Y !== undefined ? (abs ? w.Y : py + w.Y) : py;
        const nz = w.Z !== undefined ? (abs ? w.Z : pz + w.Z) : pz;
        let de = 0;
        if (w.E !== undefined) { de = eAbs ? w.E - pe : w.E; pe = eAbs ? w.E : pe + w.E; }
        if (w.F !== undefined) f = w.F;
        if (w.A !== undefined) na = abs ? w.A : pa + w.A;
        if ((code === 'G2' || code === 'G3') && (w.I !== undefined || w.J !== undefined)) {
          const cx = px + (w.I || 0), cy = py + (w.J || 0);
          const r = Math.hypot(px - cx, py - cy);
          const a0 = Math.atan2(py - cy, px - cx), a1 = Math.atan2(ny - cy, nx - cx);
          let d = a1 - a0;
          if (code === 'G2') { while (d >= -1e-9) d -= 2 * Math.PI; } else { while (d <= 1e-9) d += 2 * Math.PI; }
          const n = Math.max(2, Math.ceil((Math.abs(d) * r) / o.arcStep));
          const z0 = pz;
          for (let k = 1; k <= n; k++) {
            const ang = a0 + (d * k) / n;
            move(k === n ? nx : cx + r * Math.cos(ang), k === n ? ny : cy + r * Math.sin(ang), z0 + ((nz - z0) * k) / n, de / n);
          }
        } else {
          move(nx, ny, nz, de);
        }
        break;
      }
      case 'G4': {
        const d = w.P !== undefined ? w.P / 1000 : w.S || 0;
        if (d > 0) push(px, py, pz, px, py, pz, NOGEOM, 1, d);
        break;
      }
      case 'G28': {
        const axes = line.slice(m[0].length).toUpperCase();
        const any = /[XYZ]/.test(axes);
        if (!any || axes.includes('X')) px = 0;
        if (!any || axes.includes('Y')) py = 0;
        if (!any || axes.includes('Z')) pz = 0;
        break;
      }
      case 'G90': abs = true; break;
      case 'G91': abs = false; break;
      case 'G92':
        if (w.A !== undefined) { pa = na = w.A; }
        if (w.X !== undefined) px = w.X;
        if (w.Y !== undefined) py = w.Y;
        if (w.Z !== undefined) pz = w.Z;
        if (w.E !== undefined) pe = w.E;
        break;
      case 'M82': eAbs = true; break;
      case 'M83': eAbs = false; break;
      case 'M204': { const v = w.S ?? w.P; if (v > 0) accel = v; break; }
      case 'M220': if (w.S > 0) spd = w.S / 100; break;
      default:
    }
    if (sx.n !== oldN || px !== oldX || py !== oldY || pz !== oldZ) {
      fileEnd.push(fileSize); fileSegment.push(sx.n - 1);
      fileX.push(px); fileY.push(py); fileZ.push(pz);
    }
  }

  const g = {
    n: sx.n,
    x0: sx.done(), y0: sy.done(), z0: sz.done(), x1: ex.done(), y1: ey.done(), z1: ez.done(),
    flags: fl.done(), vc: vc.done(), accel: ac.done(),     fixed: fx.done(), a0: sa.done(), a1: ea.done(),
    fileSize, fileEnd: fileEnd.done(), fileSegment: fileSegment.done(),
    fileX: fileX.done(), fileY: fileY.done(), fileZ: fileZ.done(),
  };
  planTimes(g, o);
  findLayers(g);
  findBounds(g);
  return g;
}

// Last fully parsed command at a virtual_sdcard byte offset, not an executed physical pose.
export function positionAtFile(g, bytes) {
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > g.fileSize) return null;
  let lo = 0, hi = g.fileEnd.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (g.fileEnd[mid] <= bytes) lo = mid + 1; else hi = mid;
  }
  const k = lo - 1;
  if (k < 0) return { xyz: [0, 0, 0], time: 0, index: -1 };
  const i = g.fileSegment[k];
  return { xyz: [g.fileX[k], g.fileY[k], g.fileZ[k]], time: i < 0 ? 0 : i + 1 < g.n ? g.t0[i + 1] : g.totalTime, index: i };
}

// Look-ahead planner with Klipper's junction-deviation corner model. Fills g.t0 / g.dur / g.totalTime.
function planTimes(g, o) {
  const n = g.n;
  g.t0 = new Float64Array(n);
  g.dur = new Float32Array(n);
  g.totalTime = 0;
  if (!n) return;
  const len = (i) => Math.hypot(g.x1[i] - g.x0[i], g.y1[i] - g.y0[i], g.z1[i] - g.z0[i]);
  const geo = (i) => !(g.flags[i] & NOGEOM) && g.fixed[i] === 0;
  const b = new Float64Array(n + 1);
  for (let i = 1; i < n; i++) {
    if (!geo(i) || !geo(i - 1)) continue;
    const gap = Math.hypot(g.x0[i] - g.x1[i - 1], g.y0[i] - g.y1[i - 1], g.z0[i] - g.z1[i - 1]);
    if (gap > 1e-4) continue;
    const l0 = len(i - 1), l1 = len(i);
    const dot = ((g.x1[i - 1] - g.x0[i - 1]) * (g.x1[i] - g.x0[i]) + (g.y1[i - 1] - g.y0[i - 1]) * (g.y1[i] - g.y0[i]) + (g.z1[i - 1] - g.z0[i - 1]) * (g.z1[i] - g.z0[i])) / (l0 * l1);
    const s = Math.sqrt(Math.max(0, 0.5 * (1 + dot)));
    const a = g.accel[i];
    let vlim = Infinity;
    if (s < 0.99999) {
      const jd = (o.scv * o.scv * (Math.SQRT2 - 1)) / a;
      vlim = Math.sqrt(a * ((jd * s) / (1 - s)));
    }
    b[i] = Math.min(vlim, g.vc[i - 1], g.vc[i]);
  }
  for (let i = n - 1; i >= 0; i--) {
    if (geo(i)) b[i] = Math.min(b[i], Math.sqrt(b[i + 1] * b[i + 1] + 2 * g.accel[i] * len(i)));
  }
  for (let i = 0; i < n; i++) {
    if (geo(i)) b[i + 1] = Math.min(b[i + 1], Math.sqrt(b[i] * b[i] + 2 * g.accel[i] * len(i)));
  }
  let t = 0;
  for (let i = 0; i < n; i++) {
    g.t0[i] = t;
    let d;
    if (!geo(i)) d = g.fixed[i];
    else {
      const L = len(i), a = g.accel[i], vc = g.vc[i], vs = b[i], ve = b[i + 1];
      const da = Math.max(0, (vc * vc - vs * vs) / (2 * a)), dd = Math.max(0, (vc * vc - ve * ve) / (2 * a));
      if (da + dd > L) {
        const vp = Math.sqrt(Math.max(vs * vs, ve * ve, (2 * a * L + vs * vs + ve * ve) / 2));
        d = (vp - vs) / a + (vp - ve) / a;
      } else {
        d = (vc - vs) / a + (vc - ve) / a + (L - da - dd) / vc;
      }
    }
    g.dur[i] = d;
    t += d;
  }
  g.totalTime = t;
}

function findLayers(g) {
  g.layerStart = [];
  g.layerZ = [];
  let cur = -Infinity;
  for (let i = 0; i < g.n; i++) {
    if (!(g.flags[i] & EXTRUDE)) continue;
    if (g.z1[i] > cur + 0.001) { g.layerStart.push(i); g.layerZ.push(g.z1[i]); cur = g.z1[i]; }
  }
}

function findBounds(g) {
  const b = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity, minZ: Infinity, maxZ: -Infinity };
  let any = false;
  for (let pass = 0; pass < 2 && !any; pass++) {
    for (let i = 0; i < g.n; i++) {
      if (g.flags[i] & NOGEOM) continue;
      if (pass === 0 && !(g.flags[i] & EXTRUDE)) continue;
      any = true;
      for (const [x, y, z] of [[g.x0[i], g.y0[i], g.z0[i]], [g.x1[i], g.y1[i], g.z1[i]]]) {
        b.minX = Math.min(b.minX, x); b.maxX = Math.max(b.maxX, x);
        b.minY = Math.min(b.minY, y); b.maxY = Math.max(b.maxY, y);
        b.minZ = Math.min(b.minZ, z); b.maxZ = Math.max(b.maxZ, z);
      }
    }
  }
  if (!any) Object.assign(b, { minX: 0, maxX: 1, minY: 0, maxY: 1, minZ: 0, maxZ: 1 });
  g.bounds = b;
  g.nExtrude = 0;
  for (let i = 0; i < g.n; i++) if (g.flags[i] & EXTRUDE) g.nExtrude++;
}

// Toolpath position at gcode time tg (seconds) -> out[0..2].
export function posAt(g, tg, out) {
  const n = g.n;
  if (!n) { out[0] = out[1] = out[2] = 0; return out; }
  if (tg <= 0) { out[0] = g.x0[0]; out[1] = g.y0[0]; out[2] = g.z0[0]; return out; }
  let lo = 0, hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (g.t0[mid] <= tg) lo = mid; else hi = mid - 1;
  }

  const i = lo;
  const f = g.dur[i] > 0 ? Math.min(1, (tg - g.t0[i]) / g.dur[i]) : 1;
  out[0] = g.x0[i] + (g.x1[i] - g.x0[i]) * f;
  out[1] = g.y0[i] + (g.y1[i] - g.y0[i]) * f;
  out[2] = g.z0[i] + (g.z1[i] - g.z0[i]) * f;
  return out;
}

// Estimated commanded XYZ and segment direction; not a measured pose or orientation.
export function motionAt(g, tg) {
  if (!g.n || !Number.isFinite(tg)) return null;
  const time = Math.max(0, Math.min(g.totalTime, tg));
  let lo = 0, hi = g.n - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (g.t0[mid] <= time) lo = mid; else hi = mid - 1;
  }
  const i = lo, xyz = posAt(g, time, [0, 0, 0]);
  const delta = [g.x1[i] - g.x0[i], g.y1[i] - g.y0[i], g.z1[i] - g.z0[i]];
  const length = Math.hypot(...delta);
  const span = g.dur[i] > 0 ? Math.min(1, Math.max(0, (time - g.t0[i]) / g.dur[i])) : 1;
  const a = g.a0[i] + (g.a1[i] - g.a0[i]) * span;
  return { index: i, a, xyz, direction: length > 0 ? delta.map((v) => v / length) : null, extruding: !!(g.flags[i] & EXTRUDE) };
}
