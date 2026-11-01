// Pure helpers for viewing/exporting recorded rows.
import { isCalibrated, toUnits } from './calib.js';

// Bucket rows into <= maxPoints entries: [t, rawMean, rawMin, rawMax, filtMean, zMean].
// min/max of raw are kept so short spikes survive decimation.
export function downsample(rows, maxPoints) {
  const n = rows.length;
  if (!n) return [];
  const stride = Math.max(1, Math.ceil(n / Math.max(10, maxPoints)));
  const out = [];
  for (let i = 0; i < n; i += stride) {
    let ts = 0, tc = 0, rs = 0, rc = 0, fs = 0, fc = 0, zs = 0, zc = 0, lo = null, hi = null;
    for (let j = i; j < Math.min(n, i + stride); j++) {
      const [t, raw, filt, z] = rows[j];
      ts += t; tc++;
      if (raw != null) { rs += raw; rc++; lo = lo == null ? raw : Math.min(lo, raw); hi = hi == null ? raw : Math.max(hi, raw); }
      if (filt != null) { fs += filt; fc++; }
      if (z != null) { zs += z; zc++; }
    }
    out.push([ts / tc, rc ? rs / rc : null, lo, hi, fc ? fs / fc : null, zc ? zs / zc : null]);
  }
  return out;
}

// Tare used for calibrated export: the captured tare, else the median raw count of the first 2 s
// (taken from the envelope when the raw rows don't cover that time, e.g. triggered-only capture).
export function exportTare(session, rows, calib, env = []) {
  if (calib && Number.isFinite(calib.tare)) return calib.tare;
  const first = (rs, i) => rs.filter((r) => r[0] - session.started <= 2 && Number.isFinite(r[i])).map((r) => r[i]).sort((a, b) => a - b);
  let v = first(rows, 1);
  if (!v.length) v = first(env, 2);
  return v.length ? v[v.length >> 1] : 0;
}

// Columns raw/filtered are always counts. When `calib` is calibrated, force_raw/force_filtered
// (in calib.unit, tare-subtracted) are appended so existing consumers keep working.
export function toCsv(session, rows, calib = null, env = []) {
  const cal = calib && isCalibrated(calib);
  const tare = cal ? exportTare(session, rows, calib, env) : 0;
  const u = cal ? (v) => (Number.isFinite(v) ? toUnits(v, calib, tare).toFixed(5) : '') : null;
  const lines = ['t_s,epoch,raw,filtered,z,x,y' + (cal ? `,force_raw_${calib.unit},force_filtered_${calib.unit}` : '')];
  for (const [t, raw, filt, z, x, y] of rows) {
    const line = [(t - session.started).toFixed(4), t.toFixed(4), raw ?? '', filt ?? '', z ?? '', x ?? '', y ?? ''];
    if (cal) line.push(u(raw), u(filt));
    lines.push(line.join(','));
  }
  return lines.join('\n') + '\n';
}

export function exportMeta(session, rows, calib, env = []) {
  const cal = !!calib && isCalibrated(calib);
  return {
    session: { id: session.id, name: session.name, source: session.source, started_epoch: session.started, ended_epoch: session.ended, samples: rows.length },
    capture: session.capture || null,
    columns: { raw: 'ADC counts', filtered: 'ADC counts (device filter)', z: 'mm (Moonraker)', x: 'mm', y: 'mm', t_s: 'seconds since session start', epoch: 'host arrival time, Unix seconds' },
    calibration: cal ? {
      unit: calib.unit, counts_per_gram: calib.countsPerGram, tare_counts: exportTare(session, rows, calib, env),
      tare_source: Number.isFinite(calib.tare) ? 'captured' : 'median of first 2 s',
      inverted: !!calib.invert, formula: 'force = (counts - tare) / counts_per_gram, converted to unit; sign flipped if inverted',
    } : null,
  };
}

// ---- long-print capture exports (envelope / layers / events) ---------------------------------------
export const KINDS = {
  env: { suffix: 'summary', head: ['t_s', 'epoch', 'raw_min', 'raw_mean', 'raw_max', 'raw_std', 'filtered_mean', 'z', 'x', 'y', 'n'], absolute: [2, 3, 4, 6], diff: [5] },
  layer: { suffix: 'layers', head: ['layer', 't_start_s', 't_end_s', 'epoch_start', 'epoch_end', 'z', 'baseline', 'noise_std', 'raw_min', 'raw_max', 'peak_dev', 'events', 'samples'], absolute: [6, 8, 9], diff: [7, 10] },
  evt: { suffix: 'events', head: ['t_s', 'epoch', 'duration_s', 'triggers', 'peak_dev', 'peak_t_s', 'baseline', 'z', 'x', 'y'], absolute: [6], diff: [4] },
};

const fix = (v, d) => (v == null || !Number.isFinite(v) ? '' : v.toFixed(d));

// Maps a stored row to its CSV cells (times as seconds since session start plus epoch).
function kindCells(kind, s, r) {
  const e = (t) => fix(t - s.started, 4);
  if (kind === 'env') return [e(r[0]), fix(r[0], 3), r[1], r[2], r[3], r[4], r[5] ?? '', r[6] ?? '', r[7] ?? '', r[8] ?? '', r[9]];
  if (kind === 'layer') return [r[3], e(r[0]), e(r[1]), fix(r[0], 3), fix(r[1], 3), r[2], r[4], r[5], r[6], r[7], r[8], r[9], r[10]];
  return [e(r[0]), fix(r[0], 3), fix(r[1] - r[0], 3), r[2], r[3], e(r[4]), r[5], r[6] ?? '', r[7] ?? '', r[8] ?? ''];
}

// With a calibration, force columns (in calib.unit, tare-subtracted like the raw export) are appended.
export function kindToCsv(kind, session, rows, calib = null, env = [], header = true) {
  const k = KINDS[kind], cal = calib && isCalibrated(calib);
  const tare = cal ? exportTare(session, [], calib, env) : 0;
  const names = k.head.map((h, i) => [h, i]);
  const absCols = k.absolute.map((i) => names[i][0]), diffCols = (k.diff || []).map((i) => names[i][0]);
  const extra = cal ? [...absCols, ...diffCols].map((h) => `${h}_${calib.unit}`) : [];
  const lines = header ? [[...k.head, ...extra].join(',')] : [];
  for (const r of rows) {
    const cells = kindCells(kind, session, r);
    if (cal) {
      for (const i of k.absolute) cells.push(Number.isFinite(+cells[i]) && cells[i] !== '' ? toUnits(+cells[i], calib, tare).toFixed(5) : '');
      for (const i of k.diff || []) cells.push(Number.isFinite(+cells[i]) && cells[i] !== '' ? toUnits(+cells[i] + tare, calib, tare).toFixed(5) : '');
    }
    lines.push(cells.join(','));
  }
  return lines.length ? lines.join('\n') + '\n' : '';
}

export function safeName(name) {
  return String(name).replace(/[^A-Za-z0-9_.-]/g, '_');
}
