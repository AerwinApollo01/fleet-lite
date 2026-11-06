import { describe, expect, it } from 'vitest';
import { at } from '../src/core/time.js';
import { advanceFleet, createFleetWorld, entitleInstalled, startRollout } from '../src/scenarios/fleet.js';
import { availableSpares, cautiousKm, explain, operationsView, POLICY, ROUTES, routeRow, STATUS, swapVehicle, undoSwap } from '../src/scenarios/operations.js';
import { setDesired, reconcile } from '../src/sdv/twin.js';

describe('R20 the operator gets one decision per route, from the real pipeline', () => {
  it('accounts for every route exactly once, on its own vehicle', () => {
    const view = operationsView(createFleetWorld());
    expect(view.rows).toHaveLength(ROUTES.length);
    expect(Object.values(view.counts).reduce((a, b) => a + b, 0)).toBe(ROUTES.length);
    expect(new Set(view.rows.map((r) => r.vehicle.vin)).size).toBe(ROUTES.length);
  });

  it('gives a realistic spread, so the screen has something to decide', () => {
    const { counts, needsDecision } = operationsView(createFleetWorld());
    expect(counts.ON_TRACK).toBeGreaterThan(ROUTES.length / 2);
    expect(needsDecision).toBeGreaterThan(0);
    expect(counts.UNCONFIRMED).toBeGreaterThan(0);
  });

  it('is deterministic for the same world', () => {
    const summary = () => operationsView(createFleetWorld()).rows.map((r) => r.status).join();
    expect(summary()).toBe(summary());
  });

  it('claims from the cautious end, using the shared policy', () => {
    for (const row of operationsView(createFleetWorld()).rows) {
      if (row.status === 'ON_TRACK') expect(cautiousKm(row)).toBeGreaterThanOrEqual(row.kmRemaining);
      expect(row.estimate.rangeKm.provenance).toBe('modeled');
    }
    expect(POLICY.owner).toBeTruthy();
  });

  it('never calls an offline vehicle on track', () => {
    const offline = operationsView(createFleetWorld()).rows.filter((r) => !r.vehicle.online);
    expect(offline.length).toBeGreaterThan(0);
    for (const row of offline) {
      expect(row.status).not.toBe('ON_TRACK');
      expect(row.lastSeenMin).toBeGreaterThanOrEqual(12);
    }
  });

  it('has a plain-language reason for every route', () => {
    for (const row of operationsView(createFleetWorld()).rows) {
      expect(explain(row).length).toBeGreaterThan(10);
      expect(explain(row)).not.toMatch(/P10|P50|undefined|NaN/);
      expect(STATUS[row.status]).toBeTruthy();
    }
  });

  it('treats a faulted vehicle as out of service, ahead of any range claim', () => {
    const world = createFleetWorld();
    world.fleet[0].faulted = true;
    expect(routeRow(world, 'R-01').status).toBe('OUT_OF_SERVICE');
  });

  it('shows no forecast when the entitlement is gone', () => {
    const world = createFleetWorld();
    const [twin] = world.fleet;
    twin.online = true;
    setDesired(twin, { entitled: ['battery-health'] });
    reconcile(twin, world.now);
    expect(routeRow(world, 'R-01').status).toBe('NO_FORECAST');
  });

  it('moves route progress forward through the shift', () => {
    const world = createFleetWorld();
    const before = routeRow(world, 'R-02').routeDone;
    advanceFleet(world, 2);
    expect(routeRow(world, 'R-02').routeDone).toBeGreaterThan(before);
  });

  it('plans the next shift after hours, with the whole route ahead', () => {
    const world = createFleetWorld();
    advanceFleet(world, 10);
    const view = operationsView(world);
    expect(view.phase).toBe('planning');
    for (const row of view.rows) expect(row.kmRemaining).toBe(row.route.km);
  });
});

describe('R21 a software change reaches the operator as a better decision', () => {
  it('switches to measured payload only after load-aware range is released', () => {
    const world = createFleetWorld();
    const headroomRoute = (w) => operationsView(w).rows.find((r) => r.vehicle.hardwareRev === 'headroom' && r.vehicle.online);
    expect(headroomRoute(world).payload.provenance).toBe('modeled');

    startRollout(world, 'load');
    advanceFleet(world, 24 * 12);
    expect(headroomRoute(world).payload.provenance).toBe('modeled');

    entitleInstalled(world, 'load-aware-range');
    advanceFleet(world, 24 * 7);
    expect(headroomRoute(world).payload.provenance).toBe('measured');
  });

  it('changes route decisions when the real load is known, across several days', () => {
    const baseline = createFleetWorld();
    const released = createFleetWorld();
    for (const twin of released.fleet.filter((v) => v.hardwareRev === 'headroom')) {
      setDesired(twin, {
        installed: [...twin.desired.installed, 'load-aware-range'],
        entitled: [...twin.desired.entitled, 'load-aware-range'],
      });
      const hold = twin.online;
      twin.online = true;
      reconcile(twin, at(1, 20));
      twin.online = hold;
    }

    let changed = 0;
    for (let hour = 0; hour < 24 * 4; hour += 1) {
      advanceFleet(baseline, 1);
      advanceFleet(released, 1);
      const before = operationsView(baseline).rows;
      const after = operationsView(released).rows;
      changed += after.filter((row, i) => row.status !== before[i].status).length;
    }
    expect(changed).toBeGreaterThan(0);
  });
});

describe('R22 decisions change the plan', () => {
  const firstDecision = (world) => operationsView(world).decisions.find((d) => d.spare);

  it('offers a spare that would finish, and never the same spare twice', () => {
    const { decisions } = operationsView(createFleetWorld());
    const offered = decisions.filter((d) => d.spare).map((d) => d.spare.vin);
    expect(offered.length).toBeGreaterThan(0);
    expect(new Set(offered).size).toBe(offered.length);
  });

  it('clears the decision after a swap, and frees the spare on undo', () => {
    const world = createFleetWorld();
    const { row, spare } = firstDecision(world);
    const before = operationsView(world).needsDecision;

    swapVehicle(world, row.route.id, spare.vin);
    const after = routeRow(world, row.route.id);
    expect(after.vehicle.vin).toBe(spare.vin);
    expect(after.status).toBe('ON_TRACK');
    expect(operationsView(world).needsDecision).toBe(before - 1);
    expect(availableSpares(world)).not.toContain(spare);

    undoSwap(world, row.route.id);
    expect(availableSpares(world)).toContain(spare);
  });

  it('ends a swap with the shift, so the next plan starts clean', () => {
    const world = createFleetWorld();
    const { row, spare } = firstDecision(world);
    swapVehicle(world, row.route.id, spare.vin);
    advanceFleet(world, 7);
    expect(routeRow(world, row.route.id).swapped).toBe(true);
    advanceFleet(world, 2);
    expect(routeRow(world, row.route.id).swapped).toBe(false);
    expect(routeRow(world, row.route.id).vehicle.vin).toBe(row.vehicle.vin);
  });

  it('counts vehicles faulted by a bad update, so the screen can warn about them', () => {
    const world = createFleetWorld();
    expect(operationsView(world).faulted).toBe(0);
    world.fleet[0].faulted = true;
    expect(operationsView(world).faulted).toBe(1);
  });

  it('refuses a vehicle that is not an available spare', () => {
    const world = createFleetWorld();
    expect(() => swapVehicle(world, 'R-01', 'V-001')).toThrow(/available/);
    expect(() => swapVehicle(world, 'R-99', 'V-010')).toThrow(/Unknown/);
  });

  it('does not reuse the replaced vehicle as a spare, since its charge has been used', () => {
    const world = createFleetWorld();
    const { row, spare } = firstDecision(world);
    const original = row.vehicle;
    swapVehicle(world, row.route.id, spare.vin);
    expect(availableSpares(world)).not.toContain(original);
  });
});
