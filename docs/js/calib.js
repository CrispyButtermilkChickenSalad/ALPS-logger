// Counts -> force calibration. Default is "arbitrary counts" (no scale) until the user calibrates.

// ADS131M02: 24-bit, full-scale +/-1.2 V / gain  ->  1.2 V / 2^23 per count at gain 1 (TI datasheet).
export const VOLTS_PER_COUNT_G1 = 1.2 / 2 ** 23;
export const G_TO_N = 0.00980665;

export const DEFAULT_CALIB = { tare: null, countsPerGram: null, unit: 'g', invert: false, points: [], estimated: false };

// Least-squares fit of counts = tare + countsPerGram * grams.
export function fitCalibration(points) {
  const pts = points.filter((p) => Number.isFinite(p.grams) && Number.isFinite(p.counts));
  const n = pts.length;
  if (n < 2) return null;
  const mx = pts.reduce((s, p) => s + p.grams, 0) / n, my = pts.reduce((s, p) => s + p.counts, 0) / n;
  let sxx = 0, sxy = 0, syy = 0;
  for (const p of pts) { sxx += (p.grams - mx) ** 2; sxy += (p.grams - mx) * (p.counts - my); syy += (p.counts - my) ** 2; }
  if (sxx === 0) return null;
  const countsPerGram = sxy / sxx, tare = my - countsPerGram * mx;
  const ssRes = pts.reduce((s, p) => s + (p.counts - (tare + countsPerGram * p.grams)) ** 2, 0);
  return { tare, countsPerGram, r2: syy === 0 ? 1 : 1 - ssRes / syy, n };
}

export function isCalibrated(c) { return Number.isFinite(c.countsPerGram) && c.countsPerGram !== 0; }
export function unitLabel(c) { return isCalibrated(c) ? c.unit : 'counts'; }

// Converts raw counts to the display unit; autoTare is used when no tare has been captured.
export function toUnits(counts, c, autoTare = 0) {
  const tare = Number.isFinite(c.tare) ? c.tare : autoTare;
  const d = counts - tare;
  let v = d;
  if (isCalibrated(c)) {
    const grams = d / c.countsPerGram;
    v = c.unit === 'N' ? grams * G_TO_N : c.unit === 'kg' ? grams / 1000 : grams;
  }
  return c.invert ? -v : v;
}

// Counts per gram expected for a bridge load cell read by the ADS131M02 (an estimate, not a measurement).
export function estimateCountsPerGram({ capacityKg, sensitivityMvV, excitationV, gain }) {
  const fullScaleV = excitationV * sensitivityMvV * 1e-3;
  const voltsPerGram = fullScaleV / (capacityKg * 1000);
  const voltsPerCount = VOLTS_PER_COUNT_G1 / gain;
  return { countsPerGram: voltsPerGram / voltsPerCount, nanovoltsPerCount: voltsPerCount * 1e9, fullScaleCounts: 2 ** 23 };
}

export const REFERENCE_NOTES = [
  { title: 'Resolution of one count', body: 'The ALPS uses a 24-bit ADS131M02 with a +/-1.2 V input range divided by the PGA gain: 1 count = 143.05 nV at gain 1, 1.12 nV at gain 128 (TI ADS131M02 datasheet). Mellow does not publish the gain, sensor type or sensitivity of the ALPS, so counts cannot be converted to force from specifications alone.', url: 'https://www.ti.com/product/ADS131M02' },
  { title: 'Calibrate with a known mass', body: "Klipper's load-cell guide: tare (zero force), then press with a known weight and compute counts per gram. Use as much of the sensor's range as is safe, at least 1 kg if the toolhead and bed tolerate it, ideally pushing on a digital scale placed on the bed. Never guess the value.", url: 'https://www.klipper3d.org/Load_Cell.html#calibrating-a-load-cell' },
  { title: 'Trigger force and overshoot', body: "Klipper's guidance for load-cell probes: pick a conservative trigger force; a 100 g trigger can reach ~350 g peak before the toolhead stops, and overshoot grows with probing speed and low sample rate. Your module's current trigger threshold is shown on the main tab (the module reports it in counts).", url: 'https://www.klipper3d.org/Load_Cell.html#trigger_force' },
  { title: 'Tare drifts', body: 'Strain-gauge zero shifts with temperature and after mechanical stress. Re-capture the tare when the hotend/bed are at printing temperature, as Klipper tares before every probe.', url: 'https://www.klipper3d.org/Load_Cell.html#reference_tare_counts' },
];

export function loadCalib(storage) {
  try { return { ...DEFAULT_CALIB, ...JSON.parse(storage.getItem('alpsCalib') || '{}') }; } catch { return { ...DEFAULT_CALIB }; }
}
export function saveCalib(storage, c) { storage.setItem('alpsCalib', JSON.stringify(c)); }
