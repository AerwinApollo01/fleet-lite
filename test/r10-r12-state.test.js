import { describe, expect, it } from 'vitest';
import { createClaimPolicy, estimateRange, explainChange, routeClaim } from '../src/core/range.js';
import { createPipeline, expireLocations, ingest } from '../src/core/telemetry.js';

const inputs = { packVolts: 50, tempC: 10, payloadKg: 120, gradePct: 1, stopsPerKm: 3 };
const policy = createClaimPolicy({ owner: 'Product lead' });

describe('R10 every number knows what it is', () => {
  it('labels provenance', () => {
    const estimate = estimateRange(inputs);
    expect(estimate.packVolts.provenance).toBe('measured');
    expect(estimate.tempC.provenance).toBe('measured');
    expect(estimate.soc.provenance).toBe('modeled');
    expect(estimate.rangeKm).toMatchObject({ provenance: 'modeled', modelVersion: 'range-1.0' });
    expect(estimate.rangeKm.inputs).toEqual(inputs);
  });

  it('explains a model update as a model change', () => {
    const before = estimateRange(inputs, 'range-1.0');
    const after = estimateRange(inputs, 'range-1.1');
    expect(after.rangeKm.value).not.toBe(before.rangeKm.value);
    expect(explainChange(before, after)).toEqual({ cause: 'model-change', from: 'range-1.0', to: 'range-1.1' });
  });

  it('explains a new reading as a vehicle change', () => {
    const later = estimateRange({ ...inputs, packVolts: 47 });
    expect(explainChange(estimateRange(inputs), later)).toEqual({ cause: 'vehicle-change' });
  });

  it('gets worse as conditions get worse', () => {
    const base = estimateRange(inputs).rangeKm.value;
    expect(estimateRange({ ...inputs, tempC: 0 }).rangeKm.value).toBeLessThan(base);
    expect(estimateRange({ ...inputs, payloadKg: 200 }).rangeKm.value).toBeLessThan(base);
  });

  it('clamps state of charge', () => {
    expect(estimateRange({ ...inputs, packVolts: 60 }).soc.value).toBe(1);
    expect(estimateRange({ ...inputs, packVolts: 30 }).soc.value).toBe(0);
  });
});

describe('R11 the customer gets a decision from the cautious end', () => {
  const estimate = estimateRange(inputs);
  const { p10, p50, p90 } = estimate.rangeKm.interval;

  it('says at risk where the median says fine', () => {
    const routeKm = (p10 + p50) / 2;
    expect(p50).toBeGreaterThan(routeKm);
    expect(routeClaim(estimate, routeKm, policy).status).toBe('AT_RISK');
  });

  it('resolves to the other two decisions', () => {
    expect(routeClaim(estimate, p10 - policy.reserveKm - 0.1, policy).status).toBe('WILL_FINISH');
    expect(routeClaim(estimate, p90 + 0.1, policy).status).toBe('WONT_FINISH');
  });

  it('counts the reserve', () => {
    expect(routeClaim(estimate, p10 - 0.5, policy).status).toBe('AT_RISK');
  });

  it('requires a named owner for the threshold', () => {
    expect(() => createClaimPolicy({ owner: '' })).toThrow(/own the threshold/);
  });
});

describe('R12 raw is immutable, except location', () => {
  it('expires location and leaves the rest of the record', () => {
    const pipe = createPipeline();
    ingest(pipe, { eventId: 'e1', vin: 'V', at: 0, kind: 'trip', data: { km: 9 }, location: 'home street' }, 1);
    ingest(pipe, { eventId: 'e2', vin: 'V', at: 100, kind: 'trip', data: { km: 4 }, location: 'depot' }, 101);

    expect(JSON.stringify(pipe.raw)).not.toContain('home street');
    expect(expireLocations(pipe, 90, 90)).toBe(1);
    expect(pipe.locations.has('e1')).toBe(false);
    expect(pipe.locations.has('e2')).toBe(true);
    expect(pipe.raw).toHaveLength(2);
    expect(pipe.raw[0].data).toEqual({ km: 9 });
  });
});
