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

// Tare used for calibrated export: the captured tare, else the median raw count of the first 2 s.
export function exportTare(session, rows, calib) {
  if (calib && Number.isFinite(calib.tare)) return calib.tare;
  const v = rows.filter((r) => r[0] - session.started <= 2 && Number.isFinite(r[1])).map((r) => r[1]).sort((a, b) => a - b);
  return v.length ? v[v.length >> 1] : 0;
}

// Columns raw/filtered are always counts. When `calib` is calibrated, force_raw/force_filtered
// (in calib.unit, tare-subtracted) are appended so existing consumers keep working.
export function toCsv(session, rows, calib = null) {
  const cal = calib && isCalibrated(calib);
  const tare = cal ? exportTare(session, rows, calib) : 0;
  const u = cal ? (v) => (Number.isFinite(v) ? toUnits(v, calib, tare).toFixed(5) : '') : null;
  const lines = ['t_s,epoch,raw,filtered,z,x,y' + (cal ? `,force_raw_${calib.unit},force_filtered_${calib.unit}` : '')];
  for (const [t, raw, filt, z, x, y] of rows) {
    const line = [(t - session.started).toFixed(4), t.toFixed(4), raw ?? '', filt ?? '', z ?? '', x ?? '', y ?? ''];
    if (cal) line.push(u(raw), u(filt));
    lines.push(line.join(','));
  }
  return lines.join('\n') + '\n';
}

export function exportMeta(session, rows, calib) {
  const cal = !!calib && isCalibrated(calib);
  return {
    session: { id: session.id, name: session.name, source: session.source, started_epoch: session.started, ended_epoch: session.ended, samples: rows.length },
    columns: { raw: 'ADC counts', filtered: 'ADC counts (device filter)', z: 'mm (Moonraker)', x: 'mm', y: 'mm', t_s: 'seconds since session start', epoch: 'host arrival time, Unix seconds' },
    calibration: cal ? {
      unit: calib.unit, counts_per_gram: calib.countsPerGram, tare_counts: exportTare(session, rows, calib),
      tare_source: Number.isFinite(calib.tare) ? 'captured' : 'median of first 2 s',
      inverted: !!calib.invert, formula: 'force = (counts - tare) / counts_per_gram, converted to unit; sign flipped if inverted',
    } : null,
  };
}

export function safeName(name) {
  return String(name).replace(/[^A-Za-z0-9_.-]/g, '_');
}
