import { describe, expect, it } from 'vitest';
import { decodeFrame } from '../src/core/can.js';
import { DAY } from '../src/core/time.js';
import { bandStatus, bandsOf, COMPONENTS, faultEvents, readingsAt, scheduleRepair, vehicleTwin } from '../src/scenarios/components.js';
import { eventLogFor, filterLog, syncEventLog } from '../src/scenarios/eventlog.js';
import { assetRegister } from '../src/scenarios/assets.js';
import { routeRows } from '../src/scenarios/operations.js';
import { advanceFleet, createFleetWorld } from '../src/scenarios/fleet.js';
import { completeService } from '../src/scenarios/maintenance.js';

const partOf = (world, vin, id) => vehicleTwin(world, vin).components.find((c) => c.id === id);
const withOpen = (world, id) => world.fleet.find((v) => partOf(world, v.vin, id).openFaults > 0);

describe('R40 every signal has an operating range', () => {
  it('every sensor signal has a caution level and a limit', () => {
    for (const component of COMPONENTS.filter((c) => c.signal)) {
      const { min, low, high, max } = bandsOf(component.signal);
      expect(high !== undefined || low !== undefined).toBe(true);
      expect(min !== undefined || max !== undefined).toBe(true);
    }
  });

  it('the normal value sits in the normal band', () => {
    for (const { signal } of COMPONENTS.filter((c) => c.signal && !c.signal.load)) expect(bandStatus(signal.base, bandsOf(signal))).toBe('normal');
  });

  it('two-sided ranges catch both too low and too high', () => {
    const { signal } = COMPONENTS.find((c) => c.id === 'pack');
    expect(bandStatus(0, bandsOf(signal))).toBe('caution');
    expect(bandStatus(-20, bandsOf(signal))).toBe('limit');
    expect(bandStatus(50, bandsOf(signal))).toBe('caution');
    expect(bandStatus(70, bandsOf(signal))).toBe('limit');
    expect(bandStatus(25, bandsOf(signal))).toBe('normal');
  });

  it('low tire pressure fault drives the reading down, not up', () => {
    const world = createFleetWorld(1000);
    const { signals } = partOf(world, withOpen(world, 'tires').vin, 'tires');
    const pressure = signals.find((signal) => signal.label === 'Pressure');
    expect(pressure.value).toBeLessThan(pressure.points[0].value);
    expect(pressure.status).not.toBe('normal');
  });

  it('every graph has bands and a current status', () => {
    const world = createFleetWorld();
    for (const part of vehicleTwin(world, 'V-002').components) {
      for (const signal of part.signals) {
        expect(signal.bands).toBeDefined();
        expect(['normal', 'caution', 'limit']).toContain(signal.status);
      }
    }
  });

  it('a sustained reading outside normal puts a part on watch or worse', () => {
    const world = createFleetWorld(500);
    const days = [0, 1, 2];
    for (const vehicle of world.fleet.slice(0, 200)) {
      for (const part of vehicleTwin(world, vehicle.vin).components) {
        const signal = part.signals.find((item) => item.provenance === 'measured');
        if (!signal) continue;
        const outside = days.every((ago) => bandStatus(signal.points.at(-1 - ago).value, signal.bands) !== 'normal');
        if (outside) expect(['watch', 'fault']).toContain(part.state);
      }
    }
  });

  it('one reading outside normal changes nothing', () => {
    const world = createFleetWorld(500);
    const spike = world.fleet.flatMap((v) => vehicleTwin(world, v.vin).components)
      .find((part) => part.state === 'ok' && part.signals.some((s) => s.provenance === 'measured' && s.status !== 'normal'));
    expect(spike).toBeDefined();
    const count = assetRegister(createFleetWorld()).summary.needAttention;
    expect(count).toBeLessThanOrEqual(17);
  });

  it('a repair can’t rewrite past readings', () => {
    const world = createFleetWorld(1000);
    world.role = 'technician';
    const { vin } = withOpen(world, 'charger');
    const t = world.now - 2 * DAY;
    const before = readingsAt(world, vin, t).find((r) => r.part === 'charger').value;
    scheduleRepair(world, vin, 'charger');
    completeService(world, world.serviceOrders.at(-1).id);
    expect(readingsAt(world, vin, t).find((r) => r.part === 'charger').value).toBe(before);
  });

  it('readings return to normal after a repair', () => {
    const world = createFleetWorld(1000);
    world.role = 'technician';
    const { vin } = withOpen(world, 'charger');
    scheduleRepair(world, vin, 'charger');
    completeService(world, world.serviceOrders.at(-1).id);
    advanceFleet(world, 24);
    expect(partOf(world, vin, 'charger').signals.at(-1).status).toBe('normal');
  });

  it('verdicts follow the same state as the list', () => {
    const world = createFleetWorld(300);
    const words = { ok: 'OK to run', watch: 'Book service', fault: 'Service before next shift' };
    for (const row of assetRegister(world).vehicles) expect(vehicleTwin(world, row.id).verdict.label).toBe(words[row.condition]);
  });

  it('only a vehicle Today calls out of service gets that verdict', () => {
    const world = createFleetWorld();
    const row = routeRows(world)[0];
    expect(vehicleTwin(world, row.vehicle.vin).verdict.label).not.toBe('Out of service');
    row.vehicle.faulted = true;
    expect(vehicleTwin(world, row.vehicle.vin).verdict.label).toBe('Out of service');
    expect(routeRows(world)[0].status).toBe('OUT_OF_SERVICE');
  });

  it('the summary wording has no fault codes', () => {
    const world = createFleetWorld(1000);
    const part = partOf(world, withOpen(world, 'charger').vin, 'charger');
    expect(part.reason).toMatch(/CHG-/);
    expect(part.plain).not.toMatch(/CHG-/);
  });
});

describe('R41 the event log is append-only', () => {
  it('entries can’t be changed', () => {
    const world = createFleetWorld(1000);
    const { vin } = withOpen(world, 'charger');
    const [entry] = syncEventLog(world, vin);
    expect(() => { 'use strict'; entry.text = 'changed'; }).toThrow();
    expect(() => { 'use strict'; entry.freeze[0].value = 0; }).toThrow();
  });

  it('existing entries stay exactly as they were as time passes and work happens', () => {
    const world = createFleetWorld(1000);
    world.role = 'technician';
    const { vin } = withOpen(world, 'charger');
    const before = [...syncEventLog(world, vin)];
    const snapshot = JSON.stringify(before);
    scheduleRepair(world, vin, 'charger');
    completeService(world, world.serviceOrders.at(-1).id);
    advanceFleet(world, 24 * 10);
    const after = syncEventLog(world, vin);
    expect(after.length).toBeGreaterThan(before.length);
    expect(JSON.stringify(after.slice(0, before.length))).toBe(snapshot);
  });

  it('a repair adds an entry rather than editing the fault', () => {
    const world = createFleetWorld(1000);
    world.role = 'technician';
    const { vin } = withOpen(world, 'charger');
    scheduleRepair(world, vin, 'charger');
    completeService(world, world.serviceOrders.at(-1).id);
    const log = syncEventLog(world, vin);
    expect(log.some((e) => e.kind === 'fault' && e.part === 'charger')).toBe(true);
    expect(log.some((e) => /completed/.test(e.text))).toBe(true);
  });

  it('syncing twice adds nothing, and sequence numbers run in order', () => {
    const world = createFleetWorld();
    advanceFleet(world, 24 * 5);
    const first = syncEventLog(world, 'V-044').length;
    expect(syncEventLog(world, 'V-044').length).toBe(first);
    syncEventLog(world, 'V-044').forEach((entry, i) => expect(entry.seq).toBe(i + 1));
  });

  it('sequence follows arrival, so a late entry gets a later number', () => {
    const world = createFleetWorld(500);
    for (const { vin } of world.fleet.slice(0, 200)) {
      const log = syncEventLog(world, vin);
      for (let i = 1; i < log.length; i++) expect(log[i].receivedAt).toBeGreaterThanOrEqual(log[i - 1].receivedAt);
    }
  });

  it('marks late arrivals, and keeps both times', () => {
    const world = createFleetWorld(1000);
    const late = world.fleet.flatMap((v) => syncEventLog(world, v.vin)).filter((e) => e.late);
    expect(late.length).toBeGreaterThan(0);
    for (const entry of late) expect(entry.receivedAt - entry.at).toBeGreaterThanOrEqual(60);
  });

  it('a fault isn’t shown anywhere until it has arrived', () => {
    const world = createFleetWorld(2000);
    for (const { vin } of world.fleet.slice(0, 400)) {
      const twin = vehicleTwin(world, vin);
      const logged = syncEventLog(world, vin).filter((e) => e.kind === 'fault').length;
      expect(logged).toBe(twin.components.reduce((sum, part) => sum + part.failures, 0));
      for (const entry of syncEventLog(world, vin)) expect(entry.receivedAt).toBeLessThanOrEqual(world.now);
    }
  });

  it('no view counts a fault that’s still in the vehicle’s buffer', () => {
    const world = createFleetWorld(5000);
    for (const { vin } of world.fleet) {
      for (const event of faultEvents(world, vin)) expect(event.receivedAt).toBeLessThanOrEqual(world.now);
    }
  });

  it('a fault entry holds the reading, freeze frame, and firmware', () => {
    const world = createFleetWorld(1000);
    const { vin } = withOpen(world, 'charger');
    const entry = syncEventLog(world, vin).find((e) => e.kind === 'fault' && e.part === 'charger');
    expect(entry.reading.label).toBe('Inlet temperature');
    expect(entry.freeze.length).toBeGreaterThan(1);
    expect(entry.firmware).toBe('1.4.2');
    expect(entry.code).toMatch(/^CHG-/);
  });

  it('a raw frame decodes back to the logged reading', () => {
    const world = createFleetWorld(1000);
    const { vin } = withOpen(world, 'charger');
    const { frame, reading } = eventLogFor(world, vin, 'engineer').find((e) => e.frame);
    const bytes = frame.data.split(' ').map((byte) => Number.parseInt(byte, 16));
    const [decoded] = decodeFrame(bytes, [{ name: 'x', bytes: [0, 1], scale: 0.1, offset: -40, unit: '', decimals: 1 }]);
    expect(decoded.value).toBeCloseTo(reading.value, 1);
  });

  it('only engineers receive raw frames', () => {
    const world = createFleetWorld(1000);
    const { vin } = withOpen(world, 'charger');
    expect(eventLogFor(world, vin, 'engineer').some((e) => e.frame)).toBe(true);
    expect(eventLogFor(world, vin, 'technician').some((e) => e.frame)).toBe(false);
    expect(eventLogFor(world, vin, 'owner').some((e) => e.frame)).toBe(false);
  });

  it('technicians get no route or alert entries, and nobody’s log names a driver', () => {
    const world = createFleetWorld();
    advanceFleet(world, 24 * 2);
    const row = routeRows(world).find((r) => world.alerts.some((a) => a.vin === r.vehicle.vin)) ?? routeRows(world)[0];
    const { vin } = row.vehicle;
    world.alerts.push({ id: 999, vin, openedAt: world.now, title: 'R-01 entered a closure', severity: 'warning' });
    expect(eventLogFor(world, vin, 'owner').some((e) => e.kind === 'alert')).toBe(true);
    const tech = eventLogFor(world, vin, 'technician');
    expect(tech.some((e) => ['route', 'alert'].includes(e.kind))).toBe(false);
    expect(JSON.stringify(tech)).not.toMatch(/"lat"|"lng"|"lon"|driver/i);
  });

  it('filters by part, type, severity, and words', () => {
    const world = createFleetWorld(1000);
    const { vin } = withOpen(world, 'charger');
    const entries = eventLogFor(world, vin, 'engineer');
    expect(filterLog(entries, { part: 'charger' }).every((e) => e.part === 'charger')).toBe(true);
    expect(filterLog(entries, { kind: 'fault' }).every((e) => e.kind === 'fault')).toBe(true);
    expect(filterLog(entries, { search: 'chg' }).length).toBeGreaterThan(0);
    expect(filterLog(entries, { search: 'nothing-matches' })).toEqual([]);
  });

  it('remembers the firmware from the time, not today’s', async () => {
    const { runUpdate, startUpdate } = await import('../src/scenarios/firmware.js');
    const world = createFleetWorld(1000);
    const { vin } = withOpen(world, 'charger');
    syncEventLog(world, vin);
    advanceFleet(world, 9);
    world.role = 'technician';
    world.fleet.find((v) => v.vin === vin).online = true;
    const earlier = world.eventLogs[vin].entries[0];
    startUpdate(world, vin, '1.5.0');
    runUpdate(world, vin);
    expect(syncEventLog(world, vin)[0]).toBe(earlier);
    expect(earlier.firmware).toBe('1.4.2');
    expect(syncEventLog(world, vin).at(-1).firmware).toBe('1.5.0');
  });
});
