// The asset register: one record per thing you own, and one history for each.
import { authorize } from '../core/roles.js';
import { evaluateAlerts } from './alerts.js';
import { fleetHealth, supplierLabel } from './components.js';
import { releaseLabel } from './firmware.js';
import { HOME_DEPOT } from './fleet.js';
import { odometerKm } from './maintenance.js';
import { planningDay, routeRows } from './operations.js';
import { installPack, LOW_HEALTH_PCT, packHealth, packStatus, readyPacks } from './packs.js';
import { hash01 } from '../core/rng.js';
import { isOnShift } from '../core/ota.js';
import { HARDWARE } from '../sdv/hardware.js';

export const PACK_STATUS = { INSTALLED: 'Installed', READY: 'Ready', CHARGING: 'Charging' };

function vehicleStatus(world, vehicle, row) {
  if (vehicle.faulted) return 'Faulted';
  const mapped = vehicle.depot === HOME_DEPOT;
  if (mapped ? !row : hash01(`${vehicle.vin}:spare`) < 0.1) return 'Spare';
  return isOnShift(world.now) ? 'On route' : 'At depot';
}

export function assetRegister(world) {
  const rows = new Map(routeRows(world).map((row) => [row.vehicle.vin, row]));
  const health = fleetHealth(world);
  const installed = new Map(world.packs.filter((pack) => pack.vin).map((pack) => [pack.vin, pack]));
  const vehicles = world.fleet.map((vehicle) => {
    const row = rows.get(vehicle.vin);
    const { state, flagged, worst, openFaults } = health.get(vehicle.vin);
    return {
      id: vehicle.vin,
      type: 'Vehicle',
      status: vehicleStatus(world, vehicle, row),
      online: vehicle.online,
      condition: state,
      flagged,
      worst,
      openFaults,
      depot: vehicle.depot,
      hardware: HARDWARE[vehicle.hardwareRev].label,
      supplier: supplierLabel(vehicle.supplier),
      firmware: releaseLabel(vehicle),
      packId: installed.get(vehicle.vin).id,
      odometerKm: odometerKm(world, vehicle),
      routeId: row?.route.id ?? null,
      area: row?.route.area ?? null,
      ageDays: Math.round(90 + hash01(`${vehicle.vin}:age`) * 500),
      openOrders: world.serviceOrders.filter((o) => o.vin === vehicle.vin && o.status === 'scheduled').length,
    };
  });
  const packs = world.packs.map((pack) => ({
    id: pack.id,
    type: 'Battery pack',
    status: PACK_STATUS[packStatus(pack, world.now)],
    condition: packHealth(pack) < LOW_HEALTH_PCT ? 'watch' : 'ok',
    vin: pack.vin,
    healthPct: packHealth(pack),
    lowHealth: packHealth(pack) < LOW_HEALTH_PCT,
    cycles: pack.cycles,
    ageDays: pack.ageDays,
  }));
  const count = (list, status) => list.filter((asset) => asset.status === status).length;
  return {
    vehicles,
    packs,
    summary: {
      vehicles: vehicles.length,
      inUse: count(vehicles, 'On route') + count(vehicles, 'At depot'),
      spare: count(vehicles, 'Spare'),
      faulted: count(vehicles, 'Faulted'),
      needAttention: vehicles.filter((vehicle) => vehicle.condition !== 'ok').length,
      packs: packs.length,
      packsReady: count(packs, 'Ready'),
      packsCharging: count(packs, 'Charging'),
      packsLowHealth: packs.filter((pack) => pack.lowHealth).length,
    },
  };
}

// Built from the records each part of the system already keeps, so it can't disagree with them.
export function assetHistory(world, id) {
  const events = [];
  for (const event of world.packEvents) {
    if (event.vin === id) events.push({ at: event.at, text: `Battery swapped: ${event.removed} out, ${event.installed} in` });
    if (event.installed === id) events.push({ at: event.at, text: `Installed in ${event.vin}` });
    if (event.removed === id) events.push({ at: event.at, text: `Removed from ${event.vin} to charge` });
  }
  for (const swap of world.swapLog) {
    if (swap.to === id) events.push({ at: swap.at, text: swap.undoes ? `Swap undone, back on route ${swap.routeId}` : `Took over route ${swap.routeId}` });
    if (swap.from === id) events.push({ at: swap.at, text: swap.undoes ? `Swap undone, left route ${swap.routeId}` : `Replaced on route ${swap.routeId}` });
  }
  for (const order of world.serviceOrders.filter((o) => o.vin === id)) {
    events.push({ at: order.createdAt, text: `Work order #${order.id} scheduled` });
    if (order.doneAt !== null) events.push({ at: order.doneAt, text: `Work order #${order.id} completed` });
  }
  for (const alert of world.alerts.filter((a) => a.vin === id)) {
    events.push({ at: alert.openedAt, text: alert.title });
  }
  for (const entry of world.firmwareLog.filter((e) => e.vin === id)) events.push({ at: entry.at, text: entry.text });
  const install = world.campaign?.results.get(id);
  if (install) {
    events.push({ at: install.at, text: `Update ${world.campaign.toVersion} installed${install.outcome === 'fault' ? ', with a fault' : ''}` });
  }
  // Within the same minute, later entries came later, so reverse before the stable sort.
  return events.reverse().sort((a, b) => b.at - a.at);
}

export function swapPack(world, vin, packId) {
  authorize(world, 'pack.swap');
  const vehicle = world.fleet.find((v) => v.vin === vin);
  if (!vehicle) throw new Error(`Unknown vehicle ${vin}`);
  if (!vehicle.online) throw new Error(`${vin} has no signal, so the swap can’t be confirmed`);
  if (!readyPacks(world).some((pack) => pack.id === packId)) throw new Error(`${packId} isn’t ready`);
  installPack(world, vehicle, packId, planningDay(world.now));
  evaluateAlerts(world);
  world.onChange?.();
}
