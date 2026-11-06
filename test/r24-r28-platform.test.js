import { describe, expect, it } from 'vitest';
import { insideZone, circlePolygon, distanceKm } from '../src/core/geo.js';
import { authorize, can, ROLES } from '../src/core/roles.js';
import { at, HOUR } from '../src/core/time.js';
import { acknowledgeAlert, activeZones, alertSummary, dismissAlert, evaluateAlerts, setZone, swapRoute, undoRouteSwap, ZONES } from '../src/scenarios/alerts.js';
import { advanceFleet, createFleetWorld } from '../src/scenarios/fleet.js';
import { completeService, ITEMS, maintenanceView, scheduleService } from '../src/scenarios/maintenance.js';
import { operationsView, ROUTES } from '../src/scenarios/operations.js';
import { reportsCsv, todaySoFar, whoHad } from '../src/scenarios/reports.js';

const ALL = ROLES.engineer.tabs;

function fault(world, index = 0) {
  world.fleet[index].faulted = true;
  evaluateAlerts(world);
  return world.alerts.find((a) => a.vin === world.fleet[index].vin);
}

describe('R24 alerts earn their interruption', () => {
  it('raises a critical alert immediately', () => {
    const world = createFleetWorld();
    expect(fault(world)).toMatchObject({ severity: 'critical', rule: 'vehicle-fault', status: 'open' });
  });

  it('holds a warning until it has lasted an hour, however many checks run', () => {
    const world = createFleetWorld();
    const [row] = operationsView(world).decisions.map((d) => d.row).filter((r) => r.status === 'AT_RISK' && r.vehicle.online);
    expect(world.alerts.filter((a) => a.routeId === row.route.id)).toHaveLength(0);
    expect(world.heldBack).toBeGreaterThan(0);
    evaluateAlerts(world);
    evaluateAlerts(world);
    expect(world.alerts.filter((a) => a.routeId === row.route.id)).toHaveLength(0);
    advanceFleet(world, 1);
    expect(world.alerts.filter((a) => a.routeId === row.route.id)).toHaveLength(1);
  });

  it('never repeats an open alert', () => {
    const world = createFleetWorld();
    fault(world);
    evaluateAlerts(world);
    evaluateAlerts(world);
    expect(world.alerts.filter((a) => a.rule === 'vehicle-fault')).toHaveLength(1);
  });

  it('holds warnings on stale data, but lets critical alerts through', () => {
    const world = createFleetWorld();
    const { row } = operationsView(world).decisions.find((d) => d.row.status === 'AT_RISK');
    const twin = world.fleet.find((v) => v.vin === row.vehicle.vin);
    twin.pinnedOffline = true;
    advanceFleet(world, 3);
    const raised = world.alerts.filter((a) => a.routeId === row.route.id);
    expect(raised.filter((a) => a.severity === 'warning')).toHaveLength(0);
    expect(raised.every((a) => a.severity === 'critical')).toBe(true);
  });

  it('counts a swap as action and an alert that fades as noise', () => {
    const world = createFleetWorld();
    const decision = operationsView(world).decisions.find((d) => d.spare);
    advanceFleet(world, 1);
    const alert = world.alerts.find((a) => a.routeId === decision.row.route.id);
    swapRoute(world, decision.row.route.id, operationsView(world).spares[0].vin);
    expect(alert.status).toBe('acted');
    expect(alertSummary(world).actionRate).toBe(1);
  });

  it('mutes a dismissed alert for the rest of the day', () => {
    const world = createFleetWorld();
    const alert = fault(world);
    dismissAlert(world, alert.id);
    evaluateAlerts(world);
    expect(world.alerts.filter((a) => a.key === alert.key)).toHaveLength(1);
    expect(alertSummary(world).dismissed).toBe(1);
    expect(alertSummary(world).actionRate).toBe(0);
  });

  it('keeps an acknowledged alert open until the problem is gone', () => {
    const world = createFleetWorld();
    const alert = fault(world);
    const unread = alertSummary(world).unread;
    acknowledgeAlert(world, alert.id);
    expect(alertSummary(world).open).toContain(alert);
    expect(alert.status).toBe('acknowledged');
    expect(alertSummary(world).unread).toBe(unread - 1);
    world.fleet[0].faulted = false;
    evaluateAlerts(world);
    expect(alert.status).toBe('cleared');
  });

  it('closes everything at the end of the shift', () => {
    const world = createFleetWorld();
    fault(world);
    advanceFleet(world, 9);
    expect(alertSummary(world).open).toHaveLength(0);
  });

  it('reports no action rate before anything has closed', () => {
    expect(alertSummary(createFleetWorld()).actionRate).toBeNull();
  });
});

describe('R25 geofences use real geometry', () => {
  it('knows inside from outside', () => {
    const zone = { center: [-118.25, 34.05], radiusKm: 1 };
    expect(insideZone([-118.25, 34.054], zone)).toBe(true);
    expect(insideZone([-118.25, 34.07], zone)).toBe(false);
  });

  it('draws a closed circle of the right size', () => {
    const zone = ZONES[0];
    const ring = circlePolygon(zone);
    expect(ring[0][0]).toBeCloseTo(ring.at(-1)[0], 8);
    for (const point of ring) expect(distanceKm(point, zone.center)).toBeCloseTo(zone.radiusKm, 1);
  });

  it('has closures that real routes actually cross', () => {
    for (const zone of ZONES) expect(ROUTES.some((r) => r.path.some((p) => insideZone(p, zone)))).toBe(true);
  });

  it('alerts once per route per day, and not at all when the zone is off', () => {
    const run = (off) => {
      const world = createFleetWorld();
      if (off) ZONES.forEach((z) => setZone(world, z.id, false));
      advanceFleet(world, 7);
      return world.alerts.filter((a) => a.rule === 'zone-entry');
    };
    const fired = run(false);
    expect(fired.length).toBeGreaterThan(0);
    expect(new Set(fired.map((a) => a.key)).size).toBe(fired.length);
    expect(run(true)).toHaveLength(0);
  });

  it('turns zones on and off', () => {
    const world = createFleetWorld();
    setZone(world, 'expo', false);
    expect(activeZones(world).map((z) => z.id)).toEqual(['echo']);
    setZone(world, 'expo', true);
    expect(activeZones(world)).toHaveLength(2);
  });
});

describe('R26 maintenance says what is due and tracks the work', () => {
  it('finds a realistic amount of work', () => {
    const view = maintenanceView(createFleetWorld());
    expect(view.vehicles).toHaveLength(60);
    expect(view.work.length).toBeGreaterThan(0);
    expect(view.work.length).toBeLessThan(30);
    expect(view.overdue + view.dueSoon).toBe(view.work.length);
  });

  it('brings work closer as vehicles drive', () => {
    const world = createFleetWorld();
    const before = maintenanceView(world).vehicles[0].items[0].remainingKm;
    advanceFleet(world, 48);
    expect(maintenanceView(world).vehicles[0].items[0].remainingKm).toBeLessThan(before);
  });

  it('clears an item once its work order is done', () => {
    const world = createFleetWorld();
    const item = maintenanceView(world).work[0];
    scheduleService(world, item.vin, item.id);
    expect(maintenanceView(world).scheduled).toHaveLength(1);
    expect(() => scheduleService(world, item.vin, item.id)).toThrow(/already/);

    completeService(world, world.serviceOrders[0].id);
    const after = maintenanceView(world).vehicles.find((v) => v.vin === item.vin).items.find((i) => i.id === item.id);
    expect(after.status).toBe('OK');
    expect(after.remainingKm).toBe(ITEMS.find((i) => i.id === item.id).intervalKm);
  });

  it('shows a software fault as broken', () => {
    const world = createFleetWorld();
    world.fleet[3].faulted = true;
    expect(maintenanceView(world).broken.map((v) => v.vin)).toEqual([world.fleet[3].vin]);
  });

  it('only shows battery health when the feature is on', () => {
    const world = createFleetWorld();
    expect(maintenanceView(world).vehicles[0].batteryHealth).toBeGreaterThan(80);
    world.fleet[0].reported.entitled = [];
    expect(maintenanceView(world).vehicles[0].batteryHealth).toBeNull();
  });

  it('carries no driver or location data', () => {
    const text = JSON.stringify(maintenanceView(createFleetWorld()));
    expect(text).not.toMatch(/driver|position|location|Maya|Nora/i);
  });
});

describe('R27 reports close the day, and custody can be looked up', () => {
  it('closes a day at the end of the shift and keeps it fixed', () => {
    const world = createFleetWorld();
    expect(world.reports).toHaveLength(0);
    expect(todaySoFar(world)).toMatchObject({ day: 1, routes: 54 });
    advanceFleet(world, 8);
    expect(world.reports).toHaveLength(1);
    expect(world.reports[0]).toMatchObject({ day: 1, routes: 54 });
    expect(Object.isFrozen(world.reports[0])).toBe(true);
    expect(todaySoFar(world)).toBeNull();
  });

  it('adds one report per day', () => {
    const world = createFleetWorld();
    advanceFleet(world, 24 * 3);
    expect(world.reports.map((r) => r.day)).toEqual([1, 2, 3]);
    for (const report of world.reports) {
      expect(report.km).toBeGreaterThan(500);
      expect(report.onTimePct).toBeLessThanOrEqual(100);
    }
  });

  it('counts a failed route against on-time', () => {
    const world = createFleetWorld();
    world.fleet.slice(0, 5).forEach((v) => { v.faulted = true; });
    advanceFleet(world, 8);
    expect(world.reports[0].finished).toBeLessThanOrEqual(50);
    expect(world.reports[0].uptimePct).toBe(92);
  });

  it('exports the closed days', () => {
    const world = createFleetWorld();
    advanceFleet(world, 24);
    const [header, first] = reportsCsv(world).split('\n');
    expect(header).toMatch(/^day,routes,finished/);
    expect(first).toMatch(/^1,54,/);
  });

  it('answers who had a vehicle, including through a swap', () => {
    const world = createFleetWorld();
    const decision = operationsView(world).decisions.find((d) => d.spare);
    const { route } = decision.row;
    const original = decision.row.vehicle.vin;
    const spare = decision.spare.vin;

    expect(whoHad(world, original, at(1, 9))).toMatchObject({ driver: route.driver, routeId: route.id });
    expect(whoHad(world, spare, at(1, 9)).driver).toBeNull();

    const swappedAt = world.now;
    swapRoute(world, route.id, spare);
    advanceFleet(world, 2);
    expect(whoHad(world, spare, swappedAt + HOUR)).toMatchObject({ driver: route.driver, routeId: route.id });
    expect(whoHad(world, original, swappedAt + HOUR).driver).toBeNull();
    expect(whoHad(world, original, swappedAt - HOUR).driver).toBe(route.driver);
  });

  it('removes the record when a swap is undone', () => {
    const world = createFleetWorld();
    const { row, spare } = operationsView(world).decisions.find((d) => d.spare);
    swapRoute(world, row.route.id, spare.vin);
    undoRouteSwap(world, row.route.id);
    expect(world.swapLog).toHaveLength(0);
    expect(whoHad(world, row.vehicle.vin, world.now).driver).toBe(row.route.driver);
  });

  it('refuses the future and explains off-shift hours', () => {
    const world = createFleetWorld();
    expect(whoHad(world, 'V-001', at(9, 9)).note).toMatch(/hasn’t happened/);
    expect(whoHad(world, 'V-001', at(1, 2)).note).toMatch(/depot/);
  });
});

describe('R28 roles are enforced in the logic, not just hidden', () => {
  const as = (role) => Object.assign(createFleetWorld(), { role });

  it('gives each role a smaller surface than the platform engineer', () => {
    for (const [id, role] of Object.entries(ROLES)) {
      expect(role.tabs.length).toBeGreaterThan(0);
      for (const tab of role.tabs) expect(ALL).toContain(tab);
      if (id !== 'engineer') expect(role.tabs).not.toContain('ota');
    }
  });

  it('lets a dispatcher act on routes but not export or manage zones', () => {
    const world = as('dispatcher');
    const { row, spare } = operationsView(world).decisions.find((d) => d.spare);
    expect(() => swapRoute(world, row.route.id, spare.vin)).not.toThrow();
    expect(() => reportsCsv(world)).toThrow(/Dispatcher/);
    expect(() => setZone(world, 'expo', false)).toThrow(/Dispatcher/);
  });

  it('keeps a technician out of routes, but lets them finish work', () => {
    const world = as('technician');
    const { row, spare } = operationsView(world).decisions.find((d) => d.spare);
    expect(() => swapRoute(world, row.route.id, spare.vin)).toThrow(/technician/);
    const item = maintenanceView(world).work[0];
    scheduleService(world, item.vin, item.id);
    expect(() => completeService(world, 1)).not.toThrow();
  });

  it('lets an owner schedule work but not sign it off', () => {
    const world = as('owner');
    const item = maintenanceView(world).work[0];
    scheduleService(world, item.vin, item.id);
    expect(() => completeService(world, 1)).toThrow(/owner/);
  });

  it('keeps the calculation trace internal, and rejects unknown actions', () => {
    expect(can('owner', 'trace.view')).toBe(false);
    expect(can('engineer', 'trace.view')).toBe(true);
    expect(() => can('owner', 'made.up')).toThrow(/Unknown/);
    expect(() => authorize(as('owner'), 'trace.view')).toThrow();
  });

  it('defaults to the platform engineer when no role is set', () => {
    expect(() => authorize(createFleetWorld(), 'trace.view')).not.toThrow();
  });
});
