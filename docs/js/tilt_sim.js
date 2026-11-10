// Illustrative Y-Z plane model; all inputs are hypothetical and are not sensor calibration.
export function simulateTilt({ angle, forceY, forceZ, lever, axialGain, lateralGain, momentGain }) {
  const values = [angle, forceY, forceZ, lever, axialGain, lateralGain, momentGain];
  if (!values.every(Number.isFinite) || lever < 0) throw new RangeError('Enter finite values and a non-negative lever length.');
  const rad = angle * Math.PI / 180, sin = Math.sin(rad), cos = Math.cos(rad);
  const axial = forceY * sin + forceZ * cos;
  const lateral = forceY * cos - forceZ * sin;
  // The tip is lever mm below the sensor along the assumed nozzle axis.
  const moment = lever * lateral;
  const counts = axialGain * axial + lateralGain * lateral + momentGain * moment;
  const sensitivityY = axialGain * sin + (lateralGain + lever * momentGain) * cos;
  const sensitivityZ = axialGain * cos - (lateralGain + lever * momentGain) * sin;
  const norm = Math.hypot(sensitivityY, sensitivityZ);
  if (![axial, lateral, moment, counts, sensitivityY, sensitivityZ, norm].every(Number.isFinite)) {
    throw new RangeError('Values are too large for this model.');
  }
  const alternative = norm > 0 ? {
    forceY: forceY + sensitivityZ / norm,
    forceZ: forceZ - sensitivityY / norm,
  } : null;
  return { axial, lateral, moment, counts, sensitivityY, sensitivityZ, alternative };
}

// Flat circular face perpendicular to the assumed nozzle axis, above a flat horizontal plane.
export function nozzleGeometry({ angle, diameter, centerGap }) {
  if (![angle, diameter, centerGap].every(Number.isFinite) || Math.abs(angle) >= 90 || diameter <= 0 || centerGap < 0) {
    throw new RangeError('Enter an angle between -90 and 90 degrees, a positive diameter and a non-negative centre gap.');
  }
  const radians = angle * Math.PI / 180;
  const halfWidth = diameter * Math.cos(radians) / 2;
  const halfDifference = diameter * Math.sin(radians) / 2;
  const minusY = centerGap + halfDifference, plusY = centerGap - halfDifference;
  if (![halfWidth, minusY, plusY, diameter * 2 + centerGap].every(Number.isFinite)) throw new RangeError('Geometry values are too large.');
  return { halfWidth, minusY, plusY, minimum: Math.min(minusY, plusY), maximum: Math.max(minusY, plusY), difference: 2 * Math.abs(halfDifference) };
}

export function drawNozzleGeometry(canvas, input, geometry) {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (!w || !h) return;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#101215'; ctx.fillRect(0, 0, w, h);
  const a = input.angle * Math.PI / 180, sin = Math.sin(a), cos = Math.cos(a);
  const axisLength = input.diameter * 0.8;
  const maxHeight = Math.max(input.centerGap + axisLength * cos, geometry.maximum, 0);
  const minHeight = Math.min(0, geometry.minimum);
  const maxY = Math.max(geometry.halfWidth, Math.abs(axisLength * sin)) + input.diameter * 0.15;
  const sc = Math.min((w - 40) / (2 * maxY), (h - 45) / (maxHeight - minHeight + input.diameter * 0.2));
  const px = (v) => w / 2 + v * sc;
  const py = (v) => h - 25 - (v - minHeight) * sc;
  ctx.strokeStyle = '#78828f'; ctx.lineWidth = 2; ctx.beginPath();
  ctx.moveTo(12, py(0)); ctx.lineTo(w - 12, py(0)); ctx.stroke();
  ctx.strokeStyle = '#9da7b5'; ctx.lineWidth = 5; ctx.beginPath();
  ctx.moveTo(px(0), py(input.centerGap));
  ctx.lineTo(px(axisLength * sin), py(input.centerGap + axisLength * cos)); ctx.stroke();
  ctx.strokeStyle = '#ffa726'; ctx.lineWidth = 4; ctx.beginPath();
  ctx.moveTo(px(-geometry.halfWidth), py(geometry.minusY));
  ctx.lineTo(px(geometry.halfWidth), py(geometry.plusY)); ctx.stroke();
  ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(px(0), py(input.centerGap), 3, 0, 2 * Math.PI); ctx.fill();
  ctx.fillStyle = '#c9d1d9'; ctx.font = '12px sans-serif';
  ctx.fillText('Y →   Z ↑   orange: assumed flat face   grey: plane', 10, 15);
}

export function drawTilt(canvas, input) {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (!w || !h) return;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#101215'; ctx.fillRect(0, 0, w, h);
  const angle = input.angle * Math.PI / 180, sin = Math.sin(angle), cos = Math.cos(angle);
  const x = w / 2, y = h * 0.72, len = Math.min(h * 0.45, w * 0.28);
  const sx = x + sin * len, sy = y - cos * len;
  ctx.strokeStyle = '#5b616b'; ctx.lineWidth = 3;
  ctx.beginPath(); ctx.moveTo(12, y + 3); ctx.lineTo(w - 12, y + 3); ctx.stroke();
  ctx.strokeStyle = '#9da7b5'; ctx.lineWidth = 10;
  ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(sx, sy); ctx.stroke();
  ctx.fillStyle = '#4da3ff'; ctx.fillRect(sx - 8, sy - 5, 16, 10);
  ctx.fillStyle = '#ffa726'; ctx.beginPath(); ctx.arc(x, y, 4, 0, 2 * Math.PI); ctx.fill();
  const mag = Math.hypot(input.forceY, input.forceZ);
  if (mag > 0) {
    const dx = input.forceY / mag * 40, dy = -input.forceZ / mag * 40;
    const ex = x + dx, ey = y + dy, a = Math.atan2(dy, dx);
    ctx.strokeStyle = '#ffdd65'; ctx.lineWidth = 2; ctx.beginPath();
    ctx.moveTo(x, y); ctx.lineTo(ex, ey); ctx.lineTo(ex - 9 * Math.cos(a - 0.45), ey - 9 * Math.sin(a - 0.45));
    ctx.moveTo(ex, ey); ctx.lineTo(ex - 9 * Math.cos(a + 0.45), ey - 9 * Math.sin(a + 0.45)); ctx.stroke();
  }
  ctx.fillStyle = '#c9d1d9'; ctx.font = '12px sans-serif';
  ctx.fillText('Y →   Z ↑    side view, not to scale', 10, 18);
  ctx.fillText('blue: assumed sensor   orange: tip   yellow: assumed force', 10, h - 10);
}

// A sweep of the same hypothetical load, not a time series or recording.
export function drawAngleSweep(canvas, input) {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (!w || !h) return;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#101215'; ctx.fillRect(0, 0, w, h);
  const samples = [];
  for (let angle = -90; angle <= 90; angle++) samples.push(simulateTilt({ ...input, angle }).counts);
  const max = Math.max(1, ...samples.map(Math.abs)), left = 44, right = w - 12, top = 14, bottom = h - 25;
  const x = (angle) => left + (angle + 90) / 180 * (right - left);
  const y = (v) => (top + bottom) / 2 - (v / max) * (bottom - top) / 2;
  ctx.strokeStyle = '#5b616b'; ctx.lineWidth = 1; ctx.beginPath();
  ctx.moveTo(left, y(0)); ctx.lineTo(right, y(0)); ctx.moveTo(x(0), top); ctx.lineTo(x(0), bottom); ctx.stroke();
  ctx.strokeStyle = '#ffa726'; ctx.beginPath();
  samples.forEach((v, i) => { if (i === 0) ctx.moveTo(x(i - 90), y(v)); else ctx.lineTo(x(i - 90), y(v)); });
  ctx.stroke();
  if (input.angle >= -90 && input.angle <= 90) {
    ctx.fillStyle = '#fff'; ctx.beginPath();
    ctx.arc(x(input.angle), y(simulateTilt(input).counts), 4, 0, 2 * Math.PI); ctx.fill();
  }
  ctx.fillStyle = '#c9d1d9'; ctx.font = '11px sans-serif';
  ctx.fillText('+' + max.toPrecision(3), 2, top + 8); ctx.fillText('−' + max.toPrecision(3), 2, bottom);
  ctx.fillText('−90°', left, h - 6); ctx.fillText('0°', x(0) - 5, h - 6); ctx.fillText('+90°', right - 28, h - 6);
}
