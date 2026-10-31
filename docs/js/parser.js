// Parser for the FLY-ALPS USB serial protocol (derived from Mellow's web tool).
const PAIR = /^a=(-?\d+),b=(-?\d+)$/;
const SINGLE = /^([ab])=(-?\d+)$/;
const VERSION = /version:(\S+)/;
const THRESHOLD = /SAMPLE_THRESHOLD=(\d+)/;

// kind: "sample" (value [raw, filt], either may be null), "version", "threshold", "text"
export function parseLine(line) {
  line = line.trim();
  let m = PAIR.exec(line);
  if (m) return { kind: 'sample', value: [parseInt(m[1], 10), parseInt(m[2], 10)] };
  m = SINGLE.exec(line);
  if (m) {
    const v = parseInt(m[2], 10);
    return { kind: 'sample', value: m[1] === 'a' ? [v, null] : [null, v] };
  }
  m = VERSION.exec(line);
  if (m) return { kind: 'version', value: m[1] };
  m = THRESHOLD.exec(line);
  if (m) return { kind: 'threshold', value: parseInt(m[1], 10) };
  return { kind: 'text', value: line };
}

// Firmware 1.0 / 1.0.0 expects commands without a trailing newline.
export function newlineRequired(version) {
  return !(version == null || version === '1.0' || version === '1.0.0');
}
