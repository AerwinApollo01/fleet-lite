// "What's broken, and what will break?" Odometer is measured. Wear is an estimate. Figures are
// assumptions. This view deliberately carries no driver or location data.
import { hash01 } from '../core/rng.js';
import { authorize } from '../core/roles.js';
import { DAY } from '../core/time.js';
import { resolveCapabilities } from '../sdv/resolver.js';
import { packFor, packHealth } from './packs.js';

export const DAILY_KM = 22;
const DUE_SOON_KM = 300;

export const ITEMS = [
  { id: 'service', label: 'Scheduled service', intervalKm: 3000 },
  { id: 'brakes', label: 'Brake pads', intervalKm: 6000 },
  { id: 'tires', label: 'Tires', intervalKm: 8000 },
];

const daysElapsed = (world) => Math.floor(world.now / DAY);

export function odometerKm(world, vehicle) {
  return Math.round(4000 + hash01(`${vehicle.vin}:odo`) * 9000 + daysElapsed(world) * DAILY_KM);
}

function lastDoneKm(world, vehicle, item) {
  const done = world.serviceOrders.filter((o) => o.vin === vehicle.vin && o.itemId === item.id && o.status === 'done');
  if (done.length) return done.at(-1).odometerKm;
  // Every vehicle starts part-way through each interval, so work comes due at different times.
  const start = 4000 + hash01(`${vehicle.vin}:odo`) * 9000;
  return start - hash01(`${vehicle.vin}:${item.id}:used`) * item.intervalKm * 1.02;
}

function itemState(world, vehicle, item) {
  const odometer = odometerKm(world, vehicle);
  const remainingKm = Math.round(lastDoneKm(world, vehicle, item) + item.intervalKm - odometer);
  const order = world.serviceOrders.find((o) => o.vin === vehicle.vin && o.itemId === item.id && o.status === 'scheduled') ?? null;
  const status = remainingKm < 0 ? 'OVERDUE' : remainingKm <= DUE_SOON_KM ? 'DUE_SOON' : 'OK';
  return { ...item, vin: vehicle.vin, remainingKm, days: Math.max(0, Math.round(remainingKm / DAILY_KM)), status, order };
}

function batteryHealth(vehicle, world) {
  if (!resolveCapabilities(vehicle).active.includes('battery-health')) return null;
  return packHealth(packFor(world, vehicle));
}

export function maintenanceView(world) {
  const vehicles = world.fleet.map((vehicle) => {
    const items = ITEMS.map((item) => itemState(world, vehicle, item));
    return { vin: vehicle.vin, hardwareRev: vehicle.hardwareRev, faulted: vehicle.faulted, odometer: odometerKm(world, vehicle), batteryHealth: batteryHealth(vehicle, world), items };
  });
  const work = vehicles
    .flatMap((v) => v.items.filter((i) => i.status !== 'OK').map((i) => ({ ...i, odometer: v.odometer })))
    .sort((a, b) => a.remainingKm - b.remainingKm);
  return {
    vehicles,
    work,
    broken: vehicles.filter((v) => v.faulted),
    overdue: work.filter((i) => i.status === 'OVERDUE').length,
    dueSoon: work.filter((i) => i.status === 'DUE_SOON').length,
    scheduled: world.serviceOrders.filter((o) => o.status === 'scheduled'),
    lowBattery: vehicles.filter((v) => v.batteryHealth !== null && v.batteryHealth < 90).length,
  };
}

export function scheduleService(world, vin, itemId) {
  authorize(world, 'service.schedule');
  if (world.serviceOrders.some((o) => o.vin === vin && o.itemId === itemId && o.status === 'scheduled')) {
    throw new Error('That work is already scheduled');
  }
  world.serviceOrders.push({ id: world.serviceOrders.length + 1, vin, itemId, status: 'scheduled', createdAt: world.now, doneAt: null, odometerKm: null });
  world.onChange?.();
}

export function completeService(world, orderId) {
  authorize(world, 'service.complete');
  const order = world.serviceOrders.find((o) => o.id === orderId);
  if (!order || order.status !== 'scheduled') throw new Error('There is no open work order with that number');
  const vehicle = world.fleet.find((v) => v.vin === order.vin);
  Object.assign(order, { status: 'done', doneAt: world.now, odometerKm: odometerKm(world, vehicle) });
  world.onChange?.();
}
