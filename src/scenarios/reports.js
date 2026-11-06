// Looking back. Each day closes at the end of the shift and never changes after that.
import { authorize } from '../core/roles.js';
import { isOnShift, SHIFT } from '../core/ota.js';
import { DAY, HOUR } from '../core/time.js';
import { defaultVehicle, ROUTES, routeRows, standingSwaps } from './operations.js';

const WH_PER_KM = 48;
const FAILED = ['WONT_FINISH', 'OUT_OF_SERVICE'];

export function createReportState() {
  return { reports: [], openDay: null };
}

function snapshot(world) {
  const rows = routeRows(world);
  return {
    day: Math.floor(world.now / DAY) + 1,
    routes: rows.length,
    finished: rows.filter((r) => !FAILED.includes(r.status)).length,
    km: Math.round(rows.reduce((sum, r) => sum + r.route.km * r.routeDone, 0)),
    faulted: world.fleet.filter((v) => v.faulted).length,
    fleetSize: world.fleet.length,
  };
}

function withActivity(world, base) {
  const inDay = (at) => Math.floor(at / DAY) + 1 === base.day;
  const alerts = world.alerts.filter((a) => inDay(a.openedAt));
  return {
    ...base,
    onTimePct: Math.round((base.finished / base.routes) * 100),
    uptimePct: Math.round((1 - base.faulted / base.fleetSize) * 100),
    energyKwh: Math.round((base.km * WH_PER_KM) / 100) / 10,
    swaps: standingSwaps(world).filter((s) => inDay(s.at)).length,
    alerts: alerts.length,
    alertsActed: alerts.filter((a) => a.status === 'acted').length,
  };
}

export function recordHour(world) {
  if (isOnShift(world.now)) {
    world.openDay = snapshot(world);
    return;
  }
  if (world.openDay && (world.now % DAY) / HOUR === SHIFT.endHour) {
    world.reports.push(Object.freeze(withActivity(world, world.openDay)));
    world.openDay = null;
  }
}

export function todaySoFar(world) {
  return isOnShift(world.now) ? withActivity(world, snapshot(world)) : null;
}

export function reportsCsv(world) {
  authorize(world, 'report.export');
  const columns = ['day', 'routes', 'finished', 'onTimePct', 'km', 'energyKwh', 'uptimePct', 'swaps', 'alerts', 'alertsActed'];
  return [columns.join(','), ...world.reports.map((r) => columns.map((c) => r[c]).join(','))].join('\n');
}

// Who had this vehicle at that moment? Built from the plan plus the swap log.
export function whoHad(world, vin, at) {
  if (at > world.now) return { driver: null, note: 'That time hasn’t happened yet.' };
  if (!isOnShift(at)) return { driver: null, note: 'Parked at the depot, outside shift hours.' };

  const day = Math.floor(at / DAY);
  const home = ROUTES.find((route) => defaultVehicle(world, route).vin === vin) ?? null;
  const last = world.swapLog.filter((s) => s.day === day && s.at <= at && (s.to === vin || s.from === vin)).at(-1);

  const route = last ? (last.to === vin ? ROUTES.find((r) => r.id === last.routeId) : null) : home;
  if (!route) return { driver: null, note: last ? 'Swapped out and back at the depot.' : 'A spare, not assigned at that time.' };
  const note = !last ? 'Assigned for this shift.' : last.undoes ? 'Back on this route after a swap was undone.' : 'Took over this route in a swap.';
  return { driver: route.driver, routeId: route.id, area: route.area, note };
}
