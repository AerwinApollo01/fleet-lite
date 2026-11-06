// The operator's day, computed from the shared fleet. Routes, charge levels, and loads are
// simulated. Every claim on the Today screen comes through the real HAL, range model,
// and claim policy, so the screen can't drift from the architecture underneath it.
import { isOnShift, SHIFT } from '../core/ota.js';
import { hash01 } from '../core/rng.js';
import { createClaimPolicy, routeClaim } from '../core/range.js';
import { DAY, HOUR } from '../core/time.js';
import { pointAlong } from '../core/geo.js';
import routeData from '../data/la-routes.json';
import { FULL_VOLTS, lastPackSwap, packFor, packHealth, readyPacks } from './packs.js';
import { runRangeApp } from '../sdv/apps.js';
import { BATTERY_SUPPLIERS, createHal } from '../sdv/hal.js';
import { HARDWARE } from '../sdv/hardware.js';
import { resolveCapabilities } from '../sdv/resolver.js';
import { criticalFault } from './components.js';

export const POLICY = createClaimPolicy({ owner: 'Fleet product owner', reserveKm: 2 });

export const STATUS = {
  ON_TRACK: { label: 'On track', icon: '✓', rank: 4 },
  UNCONFIRMED: { label: 'No recent signal', icon: '?', rank: 3 },
  NO_FORECAST: { label: 'No forecast', icon: '–', rank: 5 },
  AT_RISK: { label: 'At risk', icon: '!', rank: 2 },
  WONT_FINISH: { label: 'Won’t finish', icon: '✕', rank: 1 },
  PART_FAULT: { label: 'Part fault', icon: '!', rank: 1.5 },
  OUT_OF_SERVICE: { label: 'Out of service', icon: '✕', rank: 0 },
};

const FIRST = ['Maya', 'Theo', 'Priya', 'Luis', 'Nora', 'Sam', 'Ines', 'Omar', 'Kira'];
const LAST = ['A.', 'B.', 'C.', 'D.', 'F.', 'G.'];
const VOLTS_PER_KM = 0.3;

const isSpareSlot = (index) => index % 10 === 9;

export const DEPOT = routeData.depot;

// Street geometry and distance are real. Drivers, loads, and stop density are simulated.
export const ROUTES = routeData.routes.map((route, i) => ({
  ...route,
  index: i,
  driver: `${FIRST[i % FIRST.length]} ${LAST[Math.floor(i / FIRST.length) % LAST.length]}`,
  payloadKg: Math.round(70 + hash01(`${route.id}:kg`) * 120),
  gradePct: Math.round(hash01(`${route.id}:g`) * 2) / 2,
  stopsPerKm: Math.round((1.5 + hash01(`${route.id}:s`) * 1.5) * 2) / 2,
}));

function shiftProgress(now) {
  if (!isOnShift(now)) return 0;
  const hours = (now % DAY) / HOUR;
  return (hours - SHIFT.startHour) / (SHIFT.endHour - SHIFT.startHour);
}

// After the shift ends, the screen is planning the next one.
export function planningDay(now) {
  const hours = (now % DAY) / HOUR;
  return Math.floor(now / DAY) + (hours >= SHIFT.endHour ? 1 : 0);
}

export function defaultVehicle(world, route) {
  const slots = world.fleet.filter((_, i) => !isSpareSlot(i));
  return slots[route.index];
}

// A swap covers one shift. The next plan starts from the normal assignments.
function activeSwap(world, route) {
  const swap = world.swaps[route.id];
  return swap?.day === planningDay(world.now) ? swap : null;
}

export function vehicleFor(world, route) {
  const swap = activeSwap(world, route);
  return swap ? world.fleet.find((v) => v.vin === swap.vin) : defaultVehicle(world, route);
}

// How long ago a vehicle last reported. Connected vehicles report every few minutes.
export function lastSeenMinutes(vehicle, now) {
  return vehicle.online
    ? 1 + Math.floor(hash01(`${vehicle.vin}:fresh:${now}`) * 4)
    : 12 + Math.floor(hash01(`${vehicle.vin}:seen:${planningDay(now)}`) * 78);
}

function morningVolts(packId, day) {
  const undercharged = hash01(`${packId}:low:${day}`) < 0.08;
  const spread = hash01(`${packId}:charge:${day}`);
  return undercharged ? 47.5 + spread * 2 : 53.4 + spread * 1.2;
}

// One vehicle on one route, at one moment. `fresh` means it hasn't driven any of it yet.
function evaluate(world, vehicle, route, { fresh = false, withPack = null } = {}) {
  const day = planningDay(world.now);
  const pack = withPack ?? packFor(world, vehicle);
  const packSwap = lastPackSwap(world, vehicle.vin, day);
  const lastSeenMin = lastSeenMinutes(vehicle, world.now);
  const reportedAt = vehicle.online ? world.now : world.now - lastSeenMin;

  const swap = activeSwap(world, route);
  const progress = shiftProgress(reportedAt);
  const handover = Math.max(swap ? shiftProgress(swap.at) : 0, packSwap ? shiftProgress(packSwap.at) : 0);
  const driven = fresh || withPack ? 0 : Math.max(0, progress - handover);
  const routeDone = fresh ? shiftProgress(world.now) : progress;
  const kmRemaining = route.km * (1 - routeDone);

  const burn = 0.92 + hash01(`${vehicle.vin}:${route.id}:${day}`) * 0.4;
  const startVolts = withPack || packSwap ? FULL_VOLTS : morningVolts(pack.id, day);
  const packVolts = Math.max(42, startVolts - driven * route.km * VOLTS_PER_KM * burn);
  const tempC = 9 + hash01(`temp:${day}`) * 11;

  const capabilities = resolveCapabilities(vehicle);
  const hal = createHal({
    hardware: HARDWARE[vehicle.hardwareRev],
    supplier: vehicle.supplier,
    plant: { packVolts, tempC, payloadKg: route.payloadKg },
  });
  const { estimate, payload } = runRangeApp(hal, {
    gradePct: route.gradePct,
    stopsPerKm: route.stopsPerKm,
    useCargoSensor: capabilities.active.includes('load-aware-range'),
    healthPct: packHealth(pack),
  });

  return {
    pack,
    kmRemaining,
    routeDone,
    position: pointAlong(route.path, routeDone),
    lastSeenMin,
    estimate,
    payload,
    raw: hal.rawBattery(),
    reading: hal.read('battery'),
    capabilities,
    claim: routeClaim(estimate, kmRemaining, POLICY),
  };
}

function statusOf(vehicle, facts) {
  if (vehicle.faulted) return 'OUT_OF_SERVICE';
  if (facts.partFault) return 'PART_FAULT';
  if (!facts.capabilities.active.includes('range-forecast')) return 'NO_FORECAST';
  if (facts.claim.status === 'WONT_FINISH') return 'WONT_FINISH';
  if (facts.claim.status === 'AT_RISK') return 'AT_RISK';
  return vehicle.online ? 'ON_TRACK' : 'UNCONFIRMED';
}

function rowFor(world, route) {
  const vehicle = vehicleFor(world, route);
  const facts = { ...evaluate(world, vehicle, route), partFault: criticalFault(world, vehicle) };
  return { route, vehicle, ...facts, status: statusOf(vehicle, facts), swapped: Boolean(activeSwap(world, route)) };
}

export function availableSpares(world) {
  const assigned = new Set(ROUTES.map((route) => vehicleFor(world, route).vin));
  const released = new Set(ROUTES.filter((route) => activeSwap(world, route)).map((route) => defaultVehicle(world, route).vin));
  const local = (v) => v.depot === world.fleet[0].depot;
  return world.fleet.filter((v) => local(v) && !assigned.has(v.vin) && !released.has(v.vin) && !v.faulted && v.online);
}

const WHY = {
  OUT_OF_SERVICE: (row) => `${row.vehicle.vin} has a fault and shouldn’t run this route.`,
  PART_FAULT: (row) => `${row.vehicle.vin} has an open fault on its ${row.partFault.label.toLowerCase()}: ${row.partFault.title.toLowerCase()}. It should get service before running this route.`,
  WONT_FINISH: (row) => `Even the best case falls short of the ${row.kmRemaining.toFixed(0)} km left.`,
  AT_RISK: (row) => `The cautious range is ${cautiousKm(row).toFixed(0)} km, and ${row.kmRemaining.toFixed(0)} km are left.`,
};

export const cautiousKm = (row) => Math.max(0, row.estimate.rangeKm.interval.p10 - POLICY.reserveKm);

export function explain(row) {
  if (WHY[row.status]) return WHY[row.status](row);
  if (row.status === 'NO_FORECAST') return 'Route forecasting isn’t turned on for this vehicle.';
  if (row.status === 'UNCONFIRMED') return `Looked fine ${row.lastSeenMin} minutes ago, but this can’t be confirmed until it reconnects.`;
  return `The cautious range of ${cautiousKm(row).toFixed(0)} km covers the ${row.kmRemaining.toFixed(0)} km left.`;
}

export function operationsView(world) {
  const rows = routeRows(world);
  const counts = Object.fromEntries(Object.keys(STATUS).map((key) => [key, rows.filter((r) => r.status === key).length]));

  const actions = rows
    .filter((row) => ['OUT_OF_SERVICE', 'PART_FAULT', 'WONT_FINISH', 'AT_RISK'].includes(row.status))
    .sort((a, b) => STATUS[a.status].rank - STATUS[b.status].rank || a.route.index - b.route.index);

  // A spare can only be recommended once, so two decisions never promise the same vehicle.
  const promised = new Set();
  const promisedPacks = new Set();
  const decisions = actions.map((row) => {
    const candidates = availableSpares(world).filter((v) => !promised.has(v.vin));
    const spare = bestSpare(world, row.route, candidates);
    if (spare) promised.add(spare.vin);
    const pack = bestPack(world, row, readyPacks(world).filter((p) => !promisedPacks.has(p.id)));
    if (pack) promisedPacks.add(pack.id);
    return { row, spare, pack, why: explain(row) };
  });

  return {
    phase: isOnShift(world.now) ? 'shift' : 'planning',
    rows,
    counts,
    decisions,
    needsDecision: actions.length,
    faulted: rows.filter((row) => row.vehicle.faulted).length,
    spares: availableSpares(world),
  };
}

function bestSpare(world, route, candidates) {
  const ranked = candidates
    .map((vehicle) => ({ vehicle, facts: evaluate(world, vehicle, route, { fresh: true }) }))
    .filter(({ facts }) => facts.claim.status === 'WILL_FINISH')
    .sort((a, b) => b.facts.estimate.rangeKm.interval.p10 - a.facts.estimate.rangeKm.interval.p10);
  return ranked[0]?.vehicle ?? null;
}

// A charged pack is the cheaper fix: same vehicle, same driver. It can't help a faulted vehicle,
// and a vehicle with no signal can't confirm the swap.
function bestPack(world, row, candidates) {
  if (row.vehicle.faulted || row.partFault || !row.vehicle.online) return null;
  const works = candidates
    .filter((pack) => evaluate(world, row.vehicle, row.route, { withPack: pack }).claim.status === 'WILL_FINISH')
    .sort((a, b) => packHealth(b) - packHealth(a));
  return works[0] ?? null;
}

function appendSwap(world, entry) {
  world.swapLog.push(Object.freeze({ id: world.swapLog.length + 1, ...entry }));
}

export function swapVehicle(world, routeId, vin) {
  const route = ROUTES.find((r) => r.id === routeId);
  if (!route) throw new Error(`Unknown route ${routeId}`);
  if (!availableSpares(world).some((v) => v.vin === vin)) throw new Error(`${vin} isn’t available as a spare`);
  const from = vehicleFor(world, route).vin;
  const day = planningDay(world.now);
  world.swaps[routeId] = { vin, at: world.now, day };
  appendSwap(world, { routeId, from, to: vin, at: world.now, day });
}

// The log is append-only. An undo is a new entry pointing at the swap it reverses, the way a
// ledger is corrected with another line. The original swap stays on the record.
export function undoSwap(world, routeId) {
  const swap = world.swaps[routeId];
  if (!swap) throw new Error(`Route ${routeId} has no swap to undo`);
  const entry = world.swapLog.findLast((e) => e.routeId === routeId && !e.undoes);
  delete world.swaps[routeId];
  appendSwap(world, { routeId, from: entry.to, to: entry.from, at: world.now, day: entry.day, undoes: entry.id });
}

// Swaps that still stand: not undo entries, and not reversed by one.
export function standingSwaps(world) {
  const undone = new Set(world.swapLog.filter((e) => e.undoes).map((e) => e.undoes));
  return world.swapLog.filter((e) => !e.undoes && !undone.has(e.id));
}

export const routeRows = (world) => ROUTES.map((route) => rowFor(world, route));

export function routeRow(world, routeId) {
  return rowFor(world, ROUTES.find((r) => r.id === routeId));
}

export const supplierLabel = (vehicle) => BATTERY_SUPPLIERS[vehicle.supplier].label;
