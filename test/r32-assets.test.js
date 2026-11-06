import { describe, expect, it } from 'vitest';
import { assetHistory, assetRegister, swapPack } from '../src/scenarios/assets.js';
import { alertSummary, swapRoute } from '../src/scenarios/alerts.js';
import { advanceFleet, createFleetWorld } from '../src/scenarios/fleet.js';
import { scheduleService, completeService, maintenanceView } from '../src/scenarios/maintenance.js';
import { operationsView, routeRow } from '../src/scenarios/operations.js';
import { FULL_VOLTS, packFor, packHealth, packStatus, readyPacks } from '../src/scenarios/packs.js';
import { estimateRange } from '../src/core/range.js';
import { HOUR } from '../src/core/time.js';

const packDecision = (world) => operationsView(world).decisions.find((d) => d.pack);

function atRiskWorld() {
  const world = createFleetWorld();
  const decision = packDecision(world);
  expect(decision).toBeTruthy();
  return { world, decision, vin: decision.row.vehicle.vin, routeId: decision.row.route.id };
}

describe('R32 a battery pack is its own asset', () => {
  it('gives every vehicle exactly one pack, with spares left over', () => {
    const world = createFleetWorld();
    const installed = world.packs.filter((p) => p.vin);
    expect(installed).toHaveLength(60);
    expect(new Set(installed.map((p) => p.vin)).size).toBe(60);
    expect(world.packs.length).toBeGreaterThan(60);
    expect(new Set(world.packs.map((p) => p.id)).size).toBe(world.packs.length);
  });

  it('starts with some spares ready and some still charging', () => {
    const world = createFleetWorld();
    const states = world.packs.filter((p) => !p.vin).map((p) => packStatus(p, world.now));
    expect(states).toContain('READY');
    expect(states).toContain('CHARGING');
  });

  it('finishes charging over time', () => {
    const world = createFleetWorld();
    const before = readyPacks(world).length;
    advanceFleet(world, 8);
    expect(readyPacks(world).length).toBeGreaterThan(before);
  });

  it('lets health change range', () => {
    const inputs = { packVolts: 50, tempC: 15, payloadKg: 100, gradePct: 0, stopsPerKm: 2 };
    const healthy = estimateRange({ ...inputs, healthPct: 100 }).rangeKm.value;
    const worn = estimateRange({ ...inputs, healthPct: 85 }).rangeKm.value;
    expect(worn).toBeCloseTo(healthy * 0.85, 6);
    expect(estimateRange(inputs).rangeKm.value).toBe(healthy);
  });

  it('ties a vehicle’s range to the pack in it', () => {
    const { world, vin, routeId } = atRiskWorld();
    const before = routeRow(world, routeId);
    expect(before.pack.vin).toBe(vin);
    expect(before.estimate.rangeKm.inputs.healthPct).toBe(packHealth(before.pack));
  });

  it('moves health with the pack, not the vehicle', () => {
    const { world, decision, vin } = atRiskWorld();
    swapPack(world, vin, decision.pack.id);
    const vehicle = world.fleet.find((v) => v.vin === vin);
    expect(maintenanceView(world).vehicles.find((v) => v.vin === vin).batteryHealth).toBe(packHealth(decision.pack));
    expect(packFor(world, vehicle).id).toBe(decision.pack.id);
  });
});

describe('R32 swapping a pack is a real decision', () => {
  it('offers a ready pack only where it would fix the route, and never twice', () => {
    const world = createFleetWorld();
    const offered = operationsView(world).decisions.filter((d) => d.pack).map((d) => d.pack.id);
    expect(offered.length).toBeGreaterThan(0);
    expect(new Set(offered).size).toBe(offered.length);
  });

  it('fixes the route, keeps the vehicle and driver, and clears the decision', () => {
    const { world, decision, vin, routeId } = atRiskWorld();
    const before = operationsView(world).needsDecision;
    swapPack(world, vin, decision.pack.id);
    const after = routeRow(world, routeId);
    expect(after.vehicle.vin).toBe(vin);
    expect(after.status).toBe('ON_TRACK');
    expect(after.reading.packVolts).toBeCloseTo(FULL_VOLTS, 1);
    expect(operationsView(world).needsDecision).toBe(before - 1);
  });

  it('sends the old pack to charge, and adds a cycle', () => {
    const { world, decision, vin } = atRiskWorld();
    const old = packFor(world, world.fleet.find((v) => v.vin === vin));
    const cycles = old.cycles;
    swapPack(world, vin, decision.pack.id);
    expect(packStatus(old, world.now)).toBe('CHARGING');
    expect(old.vin).toBeNull();
    expect(old.cycles).toBe(cycles + 1);
    expect(packStatus(old, world.now + 5 * HOUR)).toBe('READY');
  });

  it('drains the new pack as the vehicle drives', () => {
    const { world, decision, vin, routeId } = atRiskWorld();
    swapPack(world, vin, decision.pack.id);
    const start = routeRow(world, routeId).reading.packVolts;
    world.fleet.find((v) => v.vin === vin).pinnedOffline = false;
    world.now += 2 * HOUR;
    world.fleet.find((v) => v.vin === vin).online = true;
    expect(routeRow(world, routeId).reading.packVolts).toBeLessThan(start);
  });

  it('counts as acting on the alert', () => {
    const { world, decision, vin, routeId } = atRiskWorld();
    advanceFleet(world, 1);
    const fresh = operationsView(world).decisions.find((d) => d.row.route.id === routeId && d.pack);
    expect(fresh).toBeTruthy();
    const alert = world.alerts.find((a) => a.routeId === routeId);
    swapPack(world, vin, fresh.pack.id);
    expect(alert.status).toBe('acted');
    expect(alertSummary(world).acted).toBe(1);
    expect(decision).toBeTruthy();
  });

  it('refuses a pack that is not ready, or a vehicle with no signal', () => {
    const world = createFleetWorld();
    const charging = world.packs.find((p) => packStatus(p, world.now) === 'CHARGING');
    const online = world.fleet.find((v) => v.online);
    const offline = world.fleet.find((v) => !v.online);
    const ready = readyPacks(world)[0];
    expect(() => swapPack(world, online.vin, charging.id)).toThrow(/isn’t ready/);
    expect(() => swapPack(world, online.vin, packFor(world, online).id)).toThrow(/isn’t ready/);
    expect(() => swapPack(world, offline.vin, ready.id)).toThrow(/no signal/);
    expect(() => swapPack(world, 'V-999', ready.id)).toThrow(/Unknown/);
  });

  it('offers no pack for a faulted vehicle, since a battery will not fix that', () => {
    const world = createFleetWorld();
    const vehicle = world.fleet.find((v) => v.online);
    vehicle.faulted = true;
    const decision = operationsView(world).decisions.find((d) => d.row.vehicle.vin === vehicle.vin);
    if (decision) expect(decision.pack).toBeNull();
  });

  it('starts the next day back on normal morning charge', () => {
    const { world, decision, vin, routeId } = atRiskWorld();
    swapPack(world, vin, decision.pack.id);
    advanceFleet(world, 21);
    world.fleet.find((v) => v.vin === vin).online = true;
    expect(routeRow(world, routeId).pack.id).toBe(decision.pack.id);
    expect(routeRow(world, routeId).reading.packVolts).not.toBeCloseTo(FULL_VOLTS, 2);
  });

  it('allows every working role to swap a pack', () => {
    for (const role of ['owner', 'dispatcher', 'technician', 'engineer']) {
      const world = Object.assign(createFleetWorld(), { role });
      const { row, pack } = packDecision(world);
      expect(() => swapPack(world, row.vehicle.vin, pack.id)).not.toThrow();
    }
  });
});

describe('R33 the asset register is one record of what you own', () => {
  it('lists every vehicle and pack with consistent totals', () => {
    const world = createFleetWorld();
    const { vehicles, packs, summary } = assetRegister(world);
    expect(vehicles).toHaveLength(60);
    expect(packs).toHaveLength(world.packs.length);
    expect(summary.inUse + summary.spare + summary.faulted).toBe(60);
    expect(summary.spare).toBe(6);
  });

  it('reports where each pack is, from both directions', () => {
    const { vehicles, packs } = assetRegister(createFleetWorld());
    for (const vehicle of vehicles) {
      expect(packs.find((p) => p.id === vehicle.packId).vin).toBe(vehicle.id);
    }
  });

  it('flags low-health packs', () => {
    const { packs, summary } = assetRegister(createFleetWorld());
    expect(summary.packsLowHealth).toBe(packs.filter((p) => p.healthPct < 90).length);
    expect(summary.packsLowHealth).toBeGreaterThan(0);
  });

  it('changes vehicle status with the shift and with faults', () => {
    const world = createFleetWorld();
    world.fleet[0].faulted = true;
    expect(assetRegister(world).vehicles[0].status).toBe('Faulted');
    expect(assetRegister(world).vehicles[1].status).toBe('On route');
    advanceFleet(world, 10);
    expect(assetRegister(world).vehicles[1].status).toBe('At depot');
  });

  it('keeps driver data out of the register', () => {
    expect(JSON.stringify(assetRegister(createFleetWorld()))).not.toMatch(/driver|Maya|Nora/i);
  });

  it('builds one history from pack swaps, route swaps, and work orders', () => {
    const { world, decision, vin } = atRiskWorld();
    const packId = decision.pack.id;
    const oldPack = packFor(world, world.fleet.find((v) => v.vin === vin)).id;
    swapPack(world, vin, packId);
    scheduleService(world, vin, 'tires');
    completeService(world, 1);

    const texts = assetHistory(world, vin).map((e) => e.text).join(' | ');
    expect(texts).toContain(`${oldPack} out, ${packId} in`);
    expect(texts).toContain('Work order #1 completed');
    expect(assetHistory(world, packId)[0].text).toBe(`Installed in ${vin}`);
    expect(assetHistory(world, oldPack)[0].text).toBe(`Removed from ${vin} to charge`);
  });

  it('records route swaps on both vehicles, newest first', () => {
    const world = createFleetWorld();
    const { row, spare } = operationsView(world).decisions.find((d) => d.spare);
    swapRoute(world, row.route.id, spare.vin);
    expect(assetHistory(world, spare.vin)[0].text).toContain(`Took over route ${row.route.id}`);
    expect(assetHistory(world, row.vehicle.vin).map((e) => e.text).join()).toContain('Replaced on route');
    const times = assetHistory(world, row.vehicle.vin).map((e) => e.at);
    expect(times).toEqual([...times].sort((a, b) => b - a));
  });

  it('returns an empty history for an asset nothing has happened to', () => {
    expect(assetHistory(createFleetWorld(), 'P-1070')).toEqual([]);
  });
});
