import { describe, expect, it } from 'vitest';
import { assetRegister, swapPack } from '../src/scenarios/assets.js';
import { COMPONENTS, componentReliability, fleetHealth, scheduleRepair, vehicleTwin } from '../src/scenarios/components.js';
import { advanceFleet, createFleetWorld, startRollout } from '../src/scenarios/fleet.js';
import { completeService, ITEMS, serviceItem } from '../src/scenarios/maintenance.js';
import { readyPacks } from '../src/scenarios/packs.js';
import { DAY } from '../src/core/time.js';

const partOf = (world, vin, id) => vehicleTwin(world, vin).components.find((c) => c.id === id);
const anyOpen = (world, id) => {
  for (const vehicle of world.fleet) {
    if (partOf(world, vehicle.vin, id).openFaults > 0) return vehicle;
  }
  throw new Error(`No open fault on ${id}`);
};

describe('R36 a vehicle can be read as a system', () => {
  it('every part has one state, and the vehicle is as bad as its worst part', () => {
    const world = createFleetWorld();
    for (const { vin } of world.fleet) {
      const twin = vehicleTwin(world, vin);
      expect(twin.components).toHaveLength(COMPONENTS.length);
      const fitted = twin.components.filter((c) => c.state !== 'absent').map((c) => c.state);
      if (fitted.includes('fault')) expect(twin.state).toBe('fault');
      else if (fitted.includes('watch')) expect(twin.state).toBe('watch');
      else expect(twin.state).toBe('ok');
    }
  });

  it('the list and the twin never disagree', () => {
    const world = createFleetWorld(500);
    advanceFleet(world, 24 * 3);
    for (const row of assetRegister(world).vehicles) expect(vehicleTwin(world, row.id).state).toBe(row.condition);
  });

  it('a part that hardware doesn’t carry shows as not fitted, with no data', () => {
    const world = createFleetWorld();
    const lean = world.fleet.find((v) => v.hardwareRev === 'lean');
    const cargo = partOf(world, lean.vin, 'cargo');
    expect(cargo.state).toBe('absent');
    expect(cargo.signal).toBeNull();
    expect(cargo.failures).toBe(0);
  });

  it('battery health comes from the installed pack, and follows a swap', () => {
    const world = createFleetWorld();
    const { vin } = world.fleet.find((v) => v.online);
    const before = partOf(world, vin, 'pack').packId;
    const incoming = readyPacks(world)[0];
    swapPack(world, vin, incoming.id);
    const part = partOf(world, vin, 'pack');
    expect(part.packId).toBe(incoming.id);
    expect(part.packId).not.toBe(before);
    expect(part.signal.provenance).toBe('estimate');
  });

  it('brakes and tires use the same numbers as Maintenance', () => {
    const world = createFleetWorld();
    for (const vehicle of world.fleet) {
      const item = serviceItem(world, vehicle, 'brakes');
      const part = partOf(world, vehicle.vin, 'brakes');
      if (item.status === 'OVERDUE') expect(part.state).toBe('fault');
      const left = (item.remainingKm / item.intervalKm) * 100;
      expect(part.signal.points.at(-1).value).toBeCloseTo(Math.min(100, Math.max(0, left)), 0);
    }
  });

  it('a software fault shows on the vehicle computer', () => {
    const world = createFleetWorld();
    world.fleet[0].faulted = true;
    expect(partOf(world, world.fleet[0].vin, 'vcu').state).toBe('fault');
  });

  it('every signal says whether it is measured or an estimate', () => {
    const world = createFleetWorld();
    for (const part of vehicleTwin(world, 'V-002').components) {
      if (part.signal) expect(['measured', 'estimate']).toContain(part.signal.provenance);
    }
  });

  it('compute load comes from the features actually running', () => {
    const world = createFleetWorld();
    const lean = world.fleet.find((v) => v.hardwareRev === 'lean' && partOf(world, v.vin, 'vcu').openFaults === 0);
    const rich = world.fleet.find((v) => v.hardwareRev === 'headroom' && partOf(world, v.vin, 'vcu').openFaults === 0);
    const load = (vin) => partOf(world, vin, 'vcu').signal.points.at(-1).value;
    expect(load(lean.vin)).toBeGreaterThan(load(rich.vin));
  });

  it('says which active features depend on a part', () => {
    const world = createFleetWorld();
    expect(partOf(world, 'V-002', 'bms').dependents).toContain('Route range forecast');
    expect(partOf(world, 'V-002', 'motor').dependents).toEqual([]);
  });

  it('a signal crosses its limit by the time a fault opens', () => {
    const world = createFleetWorld(1000);
    const vehicle = anyOpen(world, 'bms');
    const { signal } = partOf(world, vehicle.vin, 'bms');
    expect(signal.points.at(-1).value).toBeGreaterThan(signal.limit * 0.9);
    expect(signal.points[0].value).toBeLessThan(signal.limit);
  });

  it('a part can go on watch before any fault, then fail if ignored', () => {
    const world = createFleetWorld(500);
    const early = world.fleet.flatMap((v) => COMPONENTS.filter((c) => c.signal).map((c) => [v.vin, c.id]))
      .find(([vin, id]) => { const part = partOf(world, vin, id); return part.state === 'watch' && part.openFaults === 0 && /outside its normal range/.test(part.reason); });
    expect(early).toBeDefined();
    advanceFleet(world, 24 * 11);
    const later = partOf(world, ...early);
    expect(later.openFaults).toBeGreaterThan(0);
  });

  it('acting on the early warning heads the failure off', () => {
    const world = createFleetWorld(500);
    world.role = 'technician';
    const early = world.fleet.flatMap((v) => COMPONENTS.filter((c) => c.signal).map((c) => [v.vin, c.id]))
      .find(([vin, id]) => { const part = partOf(world, vin, id); return part.state === 'watch' && part.openFaults === 0 && /outside its normal range/.test(part.reason); });
    const failures = partOf(world, ...early).failures;
    scheduleRepair(world, ...early);
    completeService(world, world.serviceOrders.at(-1).id);
    advanceFleet(world, 24 * 11);
    expect(partOf(world, ...early).failures).toBe(failures);
  });

  it('a repair closes the fault and keeps it in the record', () => {
    const world = createFleetWorld(1000);
    world.role = 'technician';
    const { vin } = anyOpen(world, 'charger');
    const before = partOf(world, vin, 'charger');
    scheduleRepair(world, vin, 'charger');
    expect(partOf(world, vin, 'charger').order).not.toBeNull();
    completeService(world, world.serviceOrders.at(-1).id);
    const after = partOf(world, vin, 'charger');
    expect(after.openFaults).toBe(0);
    expect(after.failures).toBe(before.failures);
    expect(after.faults.some((fault) => fault.repaired)).toBe(true);
  });

  it('a dispatcher can’t schedule a repair', () => {
    const world = createFleetWorld();
    world.role = 'dispatcher';
    expect(() => scheduleRepair(world, 'V-002', 'motor')).toThrow();
  });

  it('a repair can’t be scheduled twice, or for a part that doesn’t exist', () => {
    const world = createFleetWorld();
    scheduleRepair(world, 'V-002', 'motor');
    expect(() => scheduleRepair(world, 'V-002', 'motor')).toThrow();
    expect(() => scheduleRepair(world, 'V-002', 'warp-drive')).toThrow();
  });

  it('scheduled service items still share one work order with their part', () => {
    expect(COMPONENTS.filter((c) => c.item).every((c) => ITEMS.some((item) => item.id === c.id))).toBe(true);
  });

  it('an offline vehicle shows nothing newer than its last report', () => {
    const world = createFleetWorld(1000);
    advanceFleet(world, 24 * 2);
    const offline = world.fleet.filter((v) => !v.online);
    expect(offline.length).toBeGreaterThan(0);
    for (const { vin } of offline) {
      const twin = vehicleTwin(world, vin);
      expect(twin.stale).toBe(true);
      expect(twin.reportedAgoMin).toBeGreaterThan(0);
      for (const part of twin.components) {
        for (const fault of part.faults) expect(fault.at).toBeLessThanOrEqual(world.now - twin.reportedAgoMin);
      }
    }
  });

  it('holds no driver or location data', () => {
    const world = createFleetWorld();
    const text = JSON.stringify(vehicleTwin(world, 'V-002'));
    expect(text).not.toMatch(/driver"|"lat|"lng|"lon|routeId|"area/i);
    for (const row of world.fleet) expect(fleetHealth(world).get(row.vin)).not.toHaveProperty('driver');
  });

  it('gives the same answer for the same fleet', () => {
    expect(vehicleTwin(createFleetWorld(), 'V-007')).toEqual(vehicleTwin(createFleetWorld(), 'V-007'));
  });

  it('a fault keeps its date as time passes', () => {
    const world = createFleetWorld(1000);
    const { vin } = anyOpen(world, 'tires');
    const at = partOf(world, vin, 'tires').faults[0].at;
    advanceFleet(world, 24 * 3);
    expect(partOf(world, vin, 'tires').faults.some((fault) => fault.at === at)).toBe(true);
    expect(at).toBeLessThanOrEqual(world.now - 3 * DAY);
  });
});

describe('R37 reliability shows patterns the fleet can act on', () => {
  const parts = componentReliability(createFleetWorld(5000));
  const part = (id) => parts.find((p) => p.id === id);

  it('finds the supplier problem in a large fleet', () => {
    const { finding } = part('bms');
    expect(finding.label).toBe('Supplier Bravo');
    expect(finding.timesRest).toBeGreaterThan(2.3);
    expect(finding.timesRest).toBeLessThan(3.8);
  });

  it('finds the hardware problem in a large fleet', () => {
    expect(part('vcu').finding.label).toBe('Lean BOM');
  });

  it('flags nothing on parts with no real difference', () => {
    const planted = ['bms', 'vcu'];
    for (const item of parts.filter((p) => !planted.includes(p.id))) expect(item.finding).toBeNull();
  });

  it('won’t call a pattern from a small sample', () => {
    const small = componentReliability(createFleetWorld());
    expect(small.filter((p) => p.finding).every((p) => p.finding.failures >= 5)).toBe(true);
    expect(small.find((p) => p.id === 'vcu').finding).toBeNull();
  });

  it('only counts distance on vehicles that have the part', () => {
    const world = createFleetWorld();
    const list = componentReliability(world);
    const fitted = world.fleet.filter((v) => v.hardwareRev === 'headroom').length;
    expect(list.find((p) => p.id === 'cargo').vehicles).toBe(fitted);
    expect(list.find((p) => p.id === 'motor').vehicles).toBe(world.fleet.length);
  });

  it('the rate and the distance between failures agree', () => {
    for (const item of parts) expect(item.mtbfKm).toBeCloseTo(100000 / (item.failures / item.km * 100000), -2);
    for (const item of parts) expect(item.per100k).toBeCloseTo((item.failures / item.km) * 100000, 1);
  });

  it('a group’s failures add up to the part’s total', () => {
    const { breakdown, failures } = part('bms');
    const sum = (kind) => breakdown.filter((g) => g.kind === kind).reduce((total, g) => total + g.failures, 0);
    expect(sum('Battery supplier')).toBe(failures);
    expect(sum('Hardware')).toBe(failures);
  });

  it('weekly counts cover recent failures and grow as time passes', () => {
    const world = createFleetWorld(1000);
    const before = componentReliability(world).find((p) => p.id === 'tires');
    expect(before.weekly).toHaveLength(12);
    const sum = (weeks) => weeks.reduce((total, count) => total + count, 0);
    expect(sum(before.weekly)).toBeGreaterThan(0);
    expect(sum(before.weekly)).toBeLessThan(before.failures);
    advanceFleet(world, 24 * 7);
    const after = componentReliability(world).find((p) => p.id === 'tires');
    expect(after.weekly.slice(0, 11)).toEqual(before.weekly.slice(1));
    expect(after.failures - before.failures).toBeGreaterThan(0);
  });

  it('a software rollout fault doesn’t change hardware reliability', () => {
    const world = createFleetWorld();
    const before = componentReliability(world).find((p) => p.id === 'vcu').failures;
    startRollout(world, 'fw-bad');
    world.fleet[0].faulted = true;
    expect(componentReliability(world).find((p) => p.id === 'vcu').failures).toBe(before);
  });
});
