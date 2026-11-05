import { describe, expect, it } from 'vitest';
import { commission, createRegistry, entitlementsFor, grantEntitlement, ownerAt, provision, transfer } from '../src/core/identity.js';
import { createPipeline, flush, ingest, naiveReadFor, quarantined, readFor, recordEvent } from '../src/core/telemetry.js';
import { advanceTransfer, createTransferWorld, DRIVER_A, DRIVER_B, FLEET_A, FLEET_B, transferViews, TRANSFER_STEPS } from '../src/scenarios/transfer.js';

const setup = () => {
  const reg = createRegistry();
  provision(reg, { deviceId: 'd1', vin: 'V1', certificate: 'c1', at: 0 });
  return reg;
};

describe('R1 provisioning is not commissioning', () => {
  it('leaves a provisioned vehicle with no owner', () => {
    expect(ownerAt(setup(), 'V1', 10)).toBeNull();
  });

  it('quarantines data from an unowned vehicle', () => {
    const reg = setup();
    const pipe = createPipeline();
    ingest(pipe, { eventId: 'e1', vin: 'V1', at: 5, kind: 'ping' }, 6);
    commission(reg, { vin: 'V1', fleetId: 'A', at: 10, by: 'owner' });
    expect(quarantined(pipe, reg)).toHaveLength(1);
    expect(readFor(pipe, reg, { fleetId: 'A', vin: 'V1' })).toHaveLength(0);
  });

  it('refuses a shared certificate', () => {
    expect(() => provision(setup(), { deviceId: 'd2', vin: 'V2', certificate: 'c1', at: 0 })).toThrow(/shared/);
  });

  it('refuses to commission an unprovisioned or failed vehicle, or one with an owner', () => {
    const reg = setup();
    expect(() => commission(reg, { vin: 'NOPE', fleetId: 'A', at: 1, by: 'o' })).toThrow(/provisioned/);
    expect(() => commission(reg, { vin: 'V1', fleetId: 'A', at: 1, by: 'o', selfTestPassed: false })).toThrow(/first-use/);
    commission(reg, { vin: 'V1', fleetId: 'A', at: 1, by: 'o' });
    expect(() => commission(reg, { vin: 'V1', fleetId: 'B', at: 2, by: 'o' })).toThrow(/owner/);
  });
});

describe('R2 data follows the owner at event time', () => {
  const offlineTransfer = () => {
    const reg = setup();
    commission(reg, { vin: 'V1', fleetId: 'A', at: 10, by: 'o' });
    const pipe = createPipeline();
    const vehicle = { vin: 'V1', buffer: [] };
    recordEvent(vehicle, { eventId: 't1', vin: 'V1', at: 20, kind: 'trip', location: 'somewhere' });
    transfer(reg, { vin: 'V1', toFleetId: 'B', at: 30, by: 'ops' });
    flush(pipe, vehicle, 40);
    return { reg, pipe };
  };

  it('shows a late trip to the old owner and not the new one', () => {
    const { reg, pipe } = offlineTransfer();
    expect(readFor(pipe, reg, { fleetId: 'A', vin: 'V1' })).toHaveLength(1);
    expect(readFor(pipe, reg, { fleetId: 'B', vin: 'V1' })).toHaveLength(0);
  });

  it('proves received-time attribution would leak it', () => {
    const { reg, pipe } = offlineTransfer();
    expect(naiveReadFor(pipe, reg, { fleetId: 'B', vin: 'V1' })).toHaveLength(1);
  });

  it('treats the transfer instant as the new owner', () => {
    const reg = setup();
    commission(reg, { vin: 'V1', fleetId: 'A', at: 10, by: 'o' });
    transfer(reg, { vin: 'V1', toFleetId: 'B', at: 30, by: 'ops' });
    expect(ownerAt(reg, 'V1', 29)).toBe('A');
    expect(ownerAt(reg, 'V1', 30)).toBe('B');
  });
});

describe('R3 store-and-forward is idempotent', () => {
  it('stores a redelivered event once', () => {
    const pipe = createPipeline();
    const event = { eventId: 'e1', vin: 'V1', at: 1, kind: 'trip' };
    expect(ingest(pipe, event, 2)).toBe(true);
    expect(ingest(pipe, event, 3)).toBe(false);
    expect(pipe.raw).toHaveLength(1);
  });

  it('keeps raw records immutable', () => {
    const pipe = createPipeline();
    ingest(pipe, { eventId: 'e1', vin: 'V1', at: 1, kind: 'trip' }, 2);
    expect(Object.isFrozen(pipe.raw[0])).toBe(true);
  });
});

describe('R4 entitlements are visible and survive the right way', () => {
  it('ends contract entitlements on transfer and keeps vehicle ones', () => {
    const reg = setup();
    commission(reg, { vin: 'V1', fleetId: 'A', at: 10, by: 'o' });
    grantEntitlement(reg, { vin: 'V1', feature: 'hw', scope: 'vehicle', at: 10 });
    grantEntitlement(reg, { vin: 'V1', feature: 'contract', scope: 'contract', fleetId: 'A', at: 10 });
    expect(entitlementsFor(reg, { vin: 'V1', fleetId: 'A', at: 20 }).map((e) => e.feature)).toEqual(['hw', 'contract']);

    const result = transfer(reg, { vin: 'V1', toFleetId: 'B', at: 30, by: 'ops' });
    expect(result.endedEntitlements).toEqual(['contract']);
    expect(entitlementsFor(reg, { vin: 'V1', fleetId: 'B', at: 40 }).map((e) => e.feature)).toEqual(['hw']);
  });

  it('shows nothing to a fleet that does not own the vehicle', () => {
    const reg = setup();
    commission(reg, { vin: 'V1', fleetId: 'A', at: 10, by: 'o' });
    grantEntitlement(reg, { vin: 'V1', feature: 'hw', scope: 'vehicle', at: 10 });
    expect(entitlementsFor(reg, { vin: 'V1', fleetId: 'B', at: 20 })).toEqual([]);
  });
});

describe('the full transfer scenario', () => {
  const run = () => {
    const world = createTransferWorld();
    while (advanceTransfer(world));
    return world;
  };

  it('runs every step', () => {
    expect(run().stepIndex).toBe(TRANSFER_STEPS.length);
  });

  it('ends with each operator seeing only its own trips', () => {
    const [a, b] = transferViews(run());
    expect(a.fleetId).toBe(FLEET_A);
    expect(a.trips.map((t) => t.eventId)).toEqual(['trip-1', 'trip-2']);
    expect(b.fleetId).toBe(FLEET_B);
    expect(b.trips.map((t) => t.eventId)).toEqual(['trip-3']);
    expect(b.naiveTrips.map((t) => t.eventId)).toContain('trip-2');
  });

  it('gives the old driver a bounded window, then hands the vehicle over', () => {
    const starts = run().starts;
    const outcomes = (driver) => starts.filter((s) => s.driverId === driver).map((s) => s.allowed);
    expect(outcomes(DRIVER_A)).toEqual([true, true, false, false]);
    expect(outcomes(DRIVER_B)).toEqual([false, false, true]);
  });
});
