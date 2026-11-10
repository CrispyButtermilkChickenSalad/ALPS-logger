import test from 'node:test';
import assert from 'node:assert/strict';
import { simulateTilt } from '../docs/js/tilt_sim.js';

const example = { angle: 0, forceY: 2, forceZ: 3, lever: 10, axialGain: 100, lateralGain: 20, momentGain: 2 };
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);

test('projects world forces and computes lever moment at zero tilt', () => {
  const r = simulateTilt(example);
  close(r.axial, 3); close(r.lateral, 2); close(r.moment, 20); close(r.counts, 380);
});

test('positive tilt moves the assumed axis towards positive Y', () => {
  const r = simulateTilt({ ...example, angle: 90 });
  close(r.axial, 2); close(r.lateral, -3); close(r.moment, -30); close(r.counts, 80);
});

test('an alternative force produces the same scalar at multiple angles', () => {
  for (const angle of [-45, 0, 30, 90]) {
    const r = simulateTilt({ ...example, angle });
    const alt = simulateTilt({ ...example, angle, ...r.alternative });
    close(alt.counts, r.counts);
    close(Math.hypot(r.alternative.forceY - example.forceY, r.alternative.forceZ - example.forceZ), 1);
  }
});

test('a blind model and invalid inputs are handled explicitly', () => {
  const r = simulateTilt({ ...example, axialGain: 0, lateralGain: -20, momentGain: 2 });
  assert.equal(r.counts, 0);
  assert.equal(r.alternative, null);
  for (const invalid of [{ angle: NaN }, { lever: -1 }, { forceZ: Infinity }, { forceZ: 1e308, axialGain: 1e308 }]) {
    assert.throws(() => simulateTilt({ ...example, ...invalid }), RangeError);
  }
});
