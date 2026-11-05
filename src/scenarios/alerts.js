// Alert fatigue is the real failure mode, not detection accuracy. So this layer is mostly
// about restraint: confirm before interrupting, never repeat, and measure whether alerts
// led to action. Critical alerts skip the wait.
import { insideZone } from '../core/geo.js';
import { authorize } from '../core/roles.js';
import { DAY, HOUR } from '../core/time.js';
import { isOnShift } from '../core/ota.js';
import { routeRows, swapVehicle, undoSwap } from './operations.js';

export const ZONES = [
  { id: 'expo', name: 'Exposition Park event closure', center: [-118.285, 34.02], radiusKm: 0.5 },
  { id: 'echo', name: 'Echo Park Lake street closure', center: [-118.26, 34.073], radiusKm: 0.35 },
];

const CONFIRM_MINUTES = HOUR;

export function createAlertState() {
  return { alerts: [], pendingAlerts: {}, heldBack: 0, firedToday: {}, zonesOn: ZONES.map((z) => z.id), nextAlertId: 1 };
}

export const activeZones = (world) => ZONES.filter((zone) => world.zonesOn.includes(zone.id));

function conditions(world) {
  const found = [];
  for (const row of routeRows(world)) {
    const base = { routeId: row.route.id, vin: row.vehicle.vin, area: row.route.area, driver: row.route.driver };
    if (row.status === 'OUT_OF_SERVICE') {
      found.push({ ...base, key: `fault:${row.vehicle.vin}`, rule: 'vehicle-fault', severity: 'critical', title: `${row.vehicle.vin} is out of service`, detail: `Route ${row.route.id} in ${row.route.area} needs another vehicle.` });
    } else if (row.status === 'WONT_FINISH') {
      found.push({ ...base, key: `route:${row.route.id}`, rule: 'route-risk', severity: 'critical', title: `${row.route.id} won’t finish`, detail: `${row.driver ?? row.route.driver} in ${row.route.area} doesn’t have the range for what’s left.` });
    } else if (row.status === 'AT_RISK') {
      found.push({ ...base, key: `route:${row.route.id}`, rule: 'route-risk', severity: 'warning', confirmed: row.vehicle.online, title: `${row.route.id} is at risk`, detail: `${row.route.driver} in ${row.route.area} may not finish.` });
    }
    if (!row.vehicle.online) continue;
    for (const zone of activeZones(world)) {
      if (insideZone(row.position, zone)) {
        found.push({ ...base, key: `zone:${zone.id}:${row.route.id}`, rule: 'zone-entry', severity: 'warning', oncePerDay: true, title: `${row.route.id} entered a closure`, detail: `${row.vehicle.vin} is inside the ${zone.name}.` });
      }
    }
  }
  return found;
}

const isOpen = (alert) => alert.status === 'open' || alert.status === 'acknowledged';

function close(world, alert) {
  const acted = world.swapLog.some((s) => s.routeId === alert.routeId && s.at >= alert.openedAt);
  alert.status = acted ? 'acted' : 'cleared';
  alert.closedAt = world.now;
}

export function evaluateAlerts(world) {
  const day = Math.floor(world.now / DAY);
  if (world.firedDay !== day) {
    world.firedDay = day;
    world.firedToday = {};
  }

  const found = isOnShift(world.now) ? conditions(world) : [];
  const keys = new Set(found.map((c) => c.key));
  const open = new Map(world.alerts.filter(isOpen).map((a) => [a.key, a]));

  for (const alert of open.values()) {
    if (!keys.has(alert.key)) close(world, alert);
  }
  for (const key of Object.keys(world.pendingAlerts)) {
    if (!keys.has(key)) delete world.pendingAlerts[key];
  }

  for (const condition of found) {
    const existing = open.get(condition.key);
    if (existing) {
      if (condition.severity === 'critical' && existing.severity !== 'critical') Object.assign(existing, { severity: 'critical', title: condition.title, detail: condition.detail });
      continue;
    }
    if (world.firedToday[condition.key] && (condition.oncePerDay || world.firedToday[condition.key] === 'muted')) continue;

    if (condition.severity === 'warning' && !condition.oncePerDay) {
      // Time has to pass, not just checks. Other actions can trigger a check at any moment.
      if (world.pendingAlerts[condition.key] === undefined) {
        world.pendingAlerts[condition.key] = world.now;
        world.heldBack += 1;
      }
      if (condition.confirmed === false) continue;
      if (world.now - world.pendingAlerts[condition.key] < CONFIRM_MINUTES) continue;
    }

    const { confirmed, oncePerDay, ...alert } = condition;
    world.alerts.push({ ...alert, id: world.nextAlertId, status: 'open', openedAt: world.now, closedAt: null });
    world.nextAlertId += 1;
    world.firedToday[condition.key] = 'fired';
    delete world.pendingAlerts[condition.key];
  }
}

function find(world, id) {
  const alert = world.alerts.find((a) => a.id === id);
  if (!alert) throw new Error(`Unknown alert ${id}`);
  return alert;
}

export function acknowledgeAlert(world, id) {
  authorize(world, 'alert.respond');
  const alert = find(world, id);
  if (alert.status === 'open') alert.status = 'acknowledged';
  world.onChange?.();
}

// "Not useful" is the signal that matters most: it closes the alert, mutes it for the day,
// and counts against the action rate.
export function dismissAlert(world, id) {
  authorize(world, 'alert.respond');
  const alert = find(world, id);
  alert.status = 'dismissed';
  alert.closedAt = world.now;
  world.firedToday[alert.key] = 'muted';
  world.onChange?.();
}

export function setZone(world, zoneId, on) {
  authorize(world, 'zone.manage');
  world.zonesOn = on ? [...new Set([...world.zonesOn, zoneId])] : world.zonesOn.filter((id) => id !== zoneId);
}

export function swapRoute(world, routeId, vin) {
  authorize(world, 'route.swap');
  swapVehicle(world, routeId, vin);
  evaluateAlerts(world);
  world.onChange?.();
}

export function undoRouteSwap(world, routeId) {
  authorize(world, 'route.swap');
  undoSwap(world, routeId);
  evaluateAlerts(world);
  world.onChange?.();
}

export function alertSummary(world) {
  const count = (status) => world.alerts.filter((a) => a.status === status).length;
  const open = world.alerts.filter(isOpen);
  const acted = count('acted');
  const closed = acted + count('cleared') + count('dismissed');
  return {
    open,
    unread: world.alerts.filter((a) => a.status === 'open').length,
    raised: world.alerts.length,
    acted,
    cleared: count('cleared'),
    dismissed: count('dismissed'),
    heldBack: world.heldBack,
    closed,
    actionRate: closed ? acted / closed : null,
    history: world.alerts.filter((a) => !isOpen(a)).reverse(),
  };
}

export const hoursOpen = (alert, now) => Math.round(((alert.closedAt ?? now) - alert.openedAt) / HOUR);
