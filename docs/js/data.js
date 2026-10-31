// Pure helpers for viewing/exporting recorded rows.

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

export function toCsv(session, rows) {
  const lines = ['t_s,epoch,raw,filtered,z'];
  for (const [t, raw, filt, z] of rows) {
    lines.push([(t - session.started).toFixed(4), t.toFixed(4), raw ?? '', filt ?? '', z ?? ''].join(','));
  }
  return lines.join('\n') + '\n';
}

export function safeName(name) {
  return String(name).replace(/[^A-Za-z0-9_.-]/g, '_');
}
