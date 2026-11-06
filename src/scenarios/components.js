// What a vehicle is made of, and how each part is doing. The live state comes from the records
// the system already keeps: packs, service items, firmware, connectivity, and hardware revision.
// Fault events and sensor signals are simulated from fixed rates, so the same fleet always tells
// the same story. Codes are made up for this simulator. Nothing here holds driver or location data.
import { hash01 } from '../core/rng.js';
import { DAY, HOUR } from '../core/time.js';
import { CATALOG } from '../sdv/catalog.js';
import { BATTERY_SUPPLIERS } from '../sdv/hal.js';
import { HARDWARE, PLATFORM_RESERVED } from '../sdv/hardware.js';
import { resolveCapabilities } from '../sdv/resolver.js';
import { drift } from '../sdv/twin.js';
import { releaseLabel } from './firmware.js';
import { DAILY_KM, DUE_SOON_KM, ITEMS, odometerKm, scheduleService, serviceItem, startOdometerKm } from './maintenance.js';
import { lastSeenMinutes } from './operations.js';
import { LOW_HEALTH_PCT, packHealth } from './packs.js';

export const SYSTEMS = ['Energy', 'Drive', 'Chassis', 'Compute and sensing'];
export const STATE = {
  fault: { label: 'Fault', rank: 0 },
  watch: { label: 'Watch', rank: 1 },
  ok: { label: 'Healthy', rank: 2 },
  absent: { label: 'Not fitted', rank: 3 },
};

const OPEN_WINDOW = 14 * DAY; // Older faults from before the simulation count as already closed.
const PRECURSOR = 10 * DAY; // A failing part drifts toward its limit for this long first.
const SUSTAIN_DAYS = 3; // A brief spike doesn't change anyone's status.
const HORIZON_KM = 60000;
const TREND_DAYS = 30;
const LATE_SHARE = 0.15;
const TREND_WEEKS = 12;
const MIN_FAILURES = 5;
const MIN_RATIO = 1.5;
const MIN_Z = 2;

export const COMPONENTS = [
  { id: 'pack', label: 'Battery pack', system: 'Energy', capability: 'battery', rate: 1.2,
    does: 'Stores the energy for the shift. It’s removable, so it has its own record.',
    signal: { label: 'Cell temperature', unit: '°C', base: 26, noise: 8, limit: 60, bands: { min: -10, low: 5, high: 45, max: 60 } },
    faults: [{ code: 'BAT-101', title: 'Cell running hot', severity: 'watch' }] },
  { id: 'bms', label: 'Battery management', system: 'Energy', capability: 'battery', rate: 1.5, supplierRate: { bravo: 3 },
    does: 'Watches each cell and protects the pack.',
    signal: { label: 'Cell voltage spread', unit: 'mV', base: 18, noise: 6, high: 40, limit: 60 },
    faults: [{ code: 'BMS-204', title: 'Cell sensor dropout', severity: 'fault' }, { code: 'BMS-211', title: 'Slow cell balancing', severity: 'watch' }] },
  { id: 'charger', label: 'On-board charger', system: 'Energy', rate: 2,
    does: 'Turns depot power into pack charge.',
    signal: { label: 'Inlet temperature', unit: '°C', base: 38, noise: 8, high: 65, limit: 80 },
    faults: [{ code: 'CHG-301', title: 'Charge session stopped early', severity: 'watch' }, { code: 'CHG-317', title: 'Inlet over temperature', severity: 'fault' }] },
  { id: 'inverter', label: 'Motor controller', system: 'Drive', rate: 1.5,
    does: 'Turns pack power into controlled current for the motor.',
    signal: { label: 'Peak temperature', unit: '°C', base: 62, noise: 8, high: 88, limit: 105 },
    faults: [{ code: 'INV-503', title: 'Phase current imbalance', severity: 'fault' }, { code: 'INV-509', title: 'Running hot', severity: 'watch' }] },
  { id: 'motor', label: 'Drive motor', system: 'Drive', rate: 1,
    does: 'Moves the vehicle, and recovers energy when slowing.',
    signal: { label: 'Peak winding temperature', unit: '°C', base: 78, noise: 10, high: 115, limit: 140 },
    faults: [{ code: 'MOT-402', title: 'Winding over temperature', severity: 'watch' }, { code: 'MOT-415', title: 'Rotor position sensor fault', severity: 'fault' }] },
  { id: 'brakes', label: 'Brakes', system: 'Chassis', item: 'brakes', rate: 0.5,
    does: 'Stops the vehicle. Bound at manufacture, so software can’t change it.',
    faults: [{ code: 'BRK-602', title: 'Pressure sensor out of range', severity: 'fault' }] },
  { id: 'tires', label: 'Tires', system: 'Chassis', item: 'tires', rate: 3,
    does: 'Wear with distance, and affect range when pressure is low.',
    signal: { label: 'Pressure', unit: 'kPa', base: 265, noise: 8, limit: 200, bands: { min: 200, low: 235, high: 300, max: 330 } },
    faults: [{ code: 'TIR-701', title: 'Low pressure', severity: 'watch' }] },
  { id: 'vcu', label: 'Vehicle computer', system: 'Compute and sensing', rate: 0.8, hardwareRate: { lean: 2.5 },
    does: 'Runs the vehicle logic and hosts software features.',
    signal: { label: 'Compute load', unit: '%', base: 70, noise: 3, high: 95, limit: 99, load: true },
    faults: [{ code: 'VCU-803', title: 'Watchdog reset', severity: 'watch' }] },
  { id: 'gateway', label: 'Telematics gateway', system: 'Compute and sensing', rate: 3,
    does: 'Buffers data and carries it between the vehicle and the cloud.',
    signal: { label: 'Reconnects per day', unit: '', base: 3, noise: 3, high: 18, limit: 30 },
    faults: [{ code: 'TCU-902', title: 'Modem reset', severity: 'watch' }, { code: 'TCU-911', title: 'Store-and-forward buffer full', severity: 'watch' }] },
  { id: 'position', label: 'Position sensor', system: 'Compute and sensing', capability: 'position', rate: 1,
    does: 'Reports where the vehicle is.',
    signal: { label: 'Time to first fix', unit: 's', base: 9, noise: 5, high: 35, limit: 60 },
    faults: [{ code: 'POS-120', title: 'Slow position fix', severity: 'watch' }] },
  { id: 'motion', label: 'Motion sensor', system: 'Compute and sensing', capability: 'motion', rate: 0.6,
    does: 'Measures acceleration, which driver coaching depends on.',
    signal: { label: 'Sensor drift', unit: 'mg', base: 6, noise: 3, high: 25, limit: 40 },
    faults: [{ code: 'IMU-140', title: 'Calibration drift', severity: 'watch' }] },
  { id: 'cargo', label: 'Cargo load sensor', system: 'Compute and sensing', capability: 'cargo-load', rate: 1.5,
    does: 'Weighs what’s on board, so range can account for load.',
    signal: { label: 'Zero-load offset', unit: 'kg', base: 2, noise: 2, high: 15, limit: 25 },
    faults: [{ code: 'LOD-160', title: 'Load reading stuck', severity: 'fault' }] },
  { id: 'proximity', label: 'Proximity sensor', system: 'Compute and sensing', capability: 'proximity', rate: 2,
    does: 'Detects nearby objects for proximity alerts.',
    signal: { label: 'Blocked readings', unit: '%', base: 2, noise: 2, high: 18, limit: 30 },
    faults: [{ code: 'PRX-180', title: 'Sensor blocked', severity: 'watch' }] },
];

// Operating ranges are assumptions here. Real ones come from supplier specs and validation.
export const bandsOf = (signal) => signal.bands ?? { high: signal.high, max: signal.limit };

export function bandStatus(value, { min, low, high, max }) {
  if ((min !== undefined && value <= min) || (max !== undefined && value >= max)) return 'limit';
  if ((low !== undefined && value < low) || (high !== undefined && value > high)) return 'caution';
  return 'normal';
}

export const componentById = (id) => COMPONENTS.find((component) => component.id === id);
export const supplierLabel = (id) => BATTERY_SUPPLIERS[id]?.label ?? id;
export const workLabel = (id) => ITEMS.find((item) => item.id === id)?.label ?? componentById(id)?.label ?? id;

const fitted = (vehicle, component) =>
  !component.capability || HARDWARE[vehicle.hardwareRev].capabilities.includes(component.capability);

const ratePerKm = (vehicle, component) => component.rate / 100000
  * (component.supplierRate?.[vehicle.supplier] ?? 1)
  * (component.hardwareRate?.[vehicle.hardwareRev] ?? 1);

const schedules = new WeakMap();

// Failures arrive at random distances, at a rate set by the part. Fixed per vehicle, like its fate.
function failureSchedule(vehicle, component) {
  if (!schedules.has(vehicle)) schedules.set(vehicle, new Map());
  const cache = schedules.get(vehicle);
  if (cache.has(component.id)) return cache.get(component.id);
  const events = [];
  const rate = ratePerKm(vehicle, component);
  const startKm = startOdometerKm(vehicle);
  let km = 0;
  for (let i = 0; fitted(vehicle, component); i++) {
    km += -Math.log(1 - hash01(`${vehicle.vin}:${component.id}:gap:${i}`) * 0.999999) / rate;
    if (km > HORIZON_KM) break;
    const type = component.faults[Math.floor(hash01(`${vehicle.vin}:${component.id}:type:${i}`) * component.faults.length)];
    const at = Math.round(((km - startKm) / DAILY_KM) * DAY);
    // Most events arrive in minutes. Some wait in the vehicle's buffer until it reconnects.
    const buffered = hash01(`${vehicle.vin}:${component.id}:late:${i}`) < LATE_SHARE;
    const delay = hash01(`${vehicle.vin}:${component.id}:delay:${i}`);
    const receivedAt = at + Math.round(buffered ? (2 + delay * 12) * HOUR : 1 + delay * 3);
    events.push({ ...type, km: Math.round(km), at, receivedAt, componentId: component.id });
  }
  cache.set(component.id, events);
  return events;
}

function repairIndex(world) {
  const index = new Map();
  for (const order of world.serviceOrders) {
    if (order.status !== 'done') continue;
    const key = `${order.vin}:${order.itemId}`;
    index.set(key, [...(index.get(key) ?? []), order.doneAt]);
  }
  return index;
}

// A repair closes what already happened, and heads off a failure that was still building.
function classify(vehicle, component, repairs, knownUntil, now) {
  const done = repairs.get(`${vehicle.vin}:${component.id}`) ?? [];
  const schedule = failureSchedule(vehicle, component);
  const events = schedule.filter((event) => !done.some((at) => at < event.at && at >= event.at - PRECURSOR));
  const repaired = (event) => done.some((at) => at >= event.at);
  const seen = events.filter((event) => event.at <= knownUntil && event.receivedAt <= now);
  const open = seen.filter((event) => !repaired(event) && event.at >= -OPEN_WINDOW);
  // How each failure bent the signal, and when that stopped. Past readings stay as they were.
  const drifts = schedule.filter((event) => event.at - PRECURSOR <= knownUntil).map((event) => ({
    from: event.at - PRECURSOR,
    until: done.find((at) => at >= event.at - PRECURSOR) ?? (event.at < -OPEN_WINDOW ? event.at + 3 * DAY : Infinity),
  }));
  return { seen, open, drifts, repaired };
}

function rampAt(t, classified) {
  const active = classified.drifts.filter((drift) => t >= drift.from && t < drift.until);
  return Math.max(0, ...active.map((drift) => Math.min(1.1, (t - drift.from) / PRECURSOR)));
}

function measuredValue(vehicle, component, classified, t) {
  const { signal } = component;
  const base = signal.load ? loadBase(vehicle) : signal.base;
  const wobble = (hash01(`${vehicle.vin}:${component.id}:sig:${Math.floor(t / DAY)}`) - 0.5) * signal.noise;
  const value = base + wobble + (signal.limit - base) * rampAt(t, classified);
  return Math.round((signal.bands ? value : Math.max(0, value)) * 10) / 10;
}

// Outside normal for days on end, rather than for one reading.
function sustained(vehicle, component, classified, knownUntil) {
  const days = Array.from({ length: SUSTAIN_DAYS }, (_, i) => knownUntil - i * DAY);
  return days.every((t) => bandStatus(measuredValue(vehicle, component, classified, t), bandsOf(component.signal)) !== 'normal');
}

const worstOf = (states) => states.reduce((worst, state) => (STATE[state].rank < STATE[worst].rank ? state : worst), 'ok');

// Works out one part's condition. Cheap enough to run across thousands of vehicles.
function condition(world, vehicle, component, pack, repairs, knownUntil) {
  if (!fitted(vehicle, component)) return { state: 'absent', classified: null, open: [], reason: `Not fitted on ${HARDWARE[vehicle.hardwareRev].label}.` };
  const classified = classify(vehicle, component, repairs, knownUntil, world.now);
  const { open } = classified;
  const item = component.item ? serviceItem(world, vehicle, component.item) : null;
  const signs = [];
  if (vehicle.firmware[component.id]?.state === 'bricked') signs.push(['fault', 'A firmware update didn’t finish, and this part won’t start.']);
  if (component.id === 'vcu' && vehicle.faulted) signs.push(['fault', 'A software update left this vehicle faulted.']);
  for (const event of open) signs.push([event.severity, `${event.title} (${event.code}).`]);
  if (item?.status === 'OVERDUE') signs.push(['fault', `${item.label} overdue by ${Math.abs(item.remainingKm)} km.`]);
  if (item?.status === 'DUE_SOON') signs.push(['watch', `${item.label} due within ${Math.max(item.remainingKm, 0)} km.`]);
  if (component.id === 'pack' && packHealth(pack) < LOW_HEALTH_PCT) signs.push(['watch', `Estimated health is ${packHealth(pack)}%, below the ${LOW_HEALTH_PCT}% replacement line.`]);
  if (component.signal && sustained(vehicle, component, classified, knownUntil)) signs.push(['watch', `${component.signal.label} has been outside its normal range for ${SUSTAIN_DAYS} days.`]);
  const state = worstOf(signs.map(([level]) => level));
  const reason = signs.find(([level]) => level === state)?.[1] ?? 'No open faults.';
  return { state, reason, classified, open, item };
}

const knownUntilFor = (world, vehicle) => (vehicle.online ? world.now : world.now - lastSeenMinutes(vehicle, world.now));

// One line per vehicle, for lists and the fleet grid.
export function fleetHealth(world) {
  const repairs = repairIndex(world);
  const packs = new Map(world.packs.filter((pack) => pack.vin).map((pack) => [pack.vin, pack]));
  return new Map(world.fleet.map((vehicle) => {
    const knownUntil = knownUntilFor(world, vehicle);
    const parts = COMPONENTS.map((component) => ({ component, ...condition(world, vehicle, component, packs.get(vehicle.vin), repairs, knownUntil) }));
    const flagged = parts.filter((part) => part.state === 'fault' || part.state === 'watch')
      .sort((a, b) => STATE[a.state].rank - STATE[b.state].rank);
    return [vehicle.vin, {
      state: worstOf(flagged.map((part) => part.state)),
      flagged: flagged.map((part) => part.component.id),
      worst: flagged[0]?.component.label ?? null,
      openFaults: parts.reduce((sum, part) => sum + part.open.length, 0),
    }];
  }));
}

function loadBase(vehicle) {
  const active = resolveCapabilities(vehicle).active.map((id) => CATALOG.find((feature) => feature.id === id));
  const used = PLATFORM_RESERVED.cpu + active.reduce((sum, feature) => sum + feature.cpu, 0);
  return Math.round((used / HARDWARE[vehicle.hardwareRev].capacity.cpu) * 100);
}

const dayList = () => Array.from({ length: TREND_DAYS }, (_, i) => TREND_DAYS - 1 - i);

function describe(signal) {
  const values = signal.points.map((point) => point.value);
  return { ...signal, value: values.at(-1), status: bandStatus(values.at(-1), signal.bands) };
}

// A part's graphs: its wear estimate if it has one, then what its sensors report.
function signalsFor(vehicle, component, pack, part, knownUntil) {
  const days = dayList();
  const round = (value) => Math.round(value * 10) / 10;
  const list = [];
  if (component.id === 'pack') {
    list.push({ label: 'Estimated health', unit: '%', provenance: 'estimate', limit: LOW_HEALTH_PCT, bands: { min: 80, low: LOW_HEALTH_PCT },
      points: days.map((ago) => ({ ago, value: round(packHealth(pack) + ago * 0.012) })) });
  }
  if (part.item) {
    const left = (ago) => Math.min(100, Math.max(0, ((part.item.remainingKm + ago * DAILY_KM) / part.item.intervalKm) * 100));
    list.push({ label: `${component.label} life left`, unit: '%', provenance: 'estimate', limit: 0, bands: { min: 0, low: round((DUE_SOON_KM / part.item.intervalKm) * 100) },
      points: days.map((ago) => ({ ago, value: round(left(ago)) })) });
  }
  if (component.signal) {
    const { label, unit, limit } = component.signal;
    list.push({ label, unit, provenance: 'measured', limit, bands: bandsOf(component.signal),
      points: days.map((ago) => ({ ago, value: measuredValue(vehicle, component, part.classified, knownUntil - ago * DAY) })) });
  }
  return list.map(describe);
}

// What every sensor read at one moment. The event log uses this for its snapshots.
export function readingsAt(world, vin, t) {
  const vehicle = world.fleet.find((v) => v.vin === vin);
  const repairs = repairIndex(world);
  const knownUntil = knownUntilFor(world, vehicle);
  return COMPONENTS.filter((component) => component.signal && fitted(vehicle, component)).map((component) => {
    const value = measuredValue(vehicle, component, classify(vehicle, component, repairs, knownUntil, world.now), t);
    const bands = bandsOf(component.signal);
    return { part: component.id, partLabel: component.label, system: component.system, label: component.signal.label, unit: component.signal.unit, value, limit: component.signal.limit, status: bandStatus(value, bands) };
  });
}

export function faultEvents(world, vin) {
  const vehicle = world.fleet.find((v) => v.vin === vin);
  const repairs = repairIndex(world);
  const knownUntil = knownUntilFor(world, vehicle);
  return COMPONENTS.filter((component) => fitted(vehicle, component))
    .flatMap((component) => classify(vehicle, component, repairs, knownUntil, world.now).seen);
}

export const knownUntil = (world, vin) => knownUntilFor(world, world.fleet.find((v) => v.vin === vin));

// One plain answer for people who don't need the numbers. Only a vehicle the Today screen also
// treats as out of service gets that word here, so the two screens can't disagree.
const VERDICTS = {
  ok: { level: 'ok', label: 'OK to run', action: 'No action needed.' },
  watch: { level: 'service', label: 'Book service', action: 'Keep running, and book it in.' },
  fault: { level: 'urgent', label: 'Service before next shift', action: 'Get this looked at before it goes out again.' },
  out: { level: 'stop', label: 'Out of service', action: 'Don’t run it until the software is rolled back.' },
};
export const verdictFor = (state, outOfService = false) => (outOfService ? VERDICTS.out : VERDICTS[state]);

const plainReason = (reason) => reason.replace(/\s*\([A-Z]+-\d+\)/, '');

// Which features stop working if this part does. Only capabilities link parts to features.
function dependents(vehicle, component) {
  if (!component.capability) return [];
  const active = resolveCapabilities(vehicle).active;
  return CATALOG.filter((feature) => feature.requires.includes(component.capability) && active.includes(feature.id)).map((feature) => feature.label);
}

// The whole vehicle, part by part, as of its last report.
export function vehicleTwin(world, vin) {
  const vehicle = world.fleet.find((v) => v.vin === vin);
  if (!vehicle) return null;
  const repairs = repairIndex(world);
  const pack = world.packs.find((p) => p.vin === vin);
  const knownUntil = knownUntilFor(world, vehicle);
  const odometer = odometerKm(world, vehicle);
  const components = COMPONENTS.map((component) => {
    const part = condition(world, vehicle, component, pack, repairs, knownUntil);
    const base = { id: component.id, label: component.label, system: component.system, does: component.does, state: part.state, reason: part.reason, plain: plainReason(part.reason) };
    if (part.state === 'absent') return { ...base, faults: [], openFaults: 0, dependents: [], signal: null, signals: [], failures: 0, verdict: null };
    const signals = signalsFor(vehicle, component, pack, part, knownUntil);
    const { seen, repaired } = part.classified;
    const faults = [...seen].reverse().map((event) => ({
      code: event.code, title: event.title, severity: event.severity, at: event.at, km: event.km,
      daysAgo: Math.max(0, Math.round((world.now - event.at) / DAY)),
      open: part.open.includes(event), repaired: repaired(event),
    }));
    return {
      ...base, faults, openFaults: part.open.length, failures: seen.length,
      dependents: dependents(vehicle, component),
      signals, signal: signals[0] ?? null,
      verdict: verdictFor(part.state, component.id === 'vcu' && vehicle.faulted),
      order: world.serviceOrders.find((o) => o.vin === vin && o.itemId === component.id && o.status === 'scheduled') ?? null,
      packId: component.id === 'pack' ? pack.id : null,
    };
  });
  const state = worstOf(components.filter((c) => c.state !== 'absent').map((c) => c.state));
  return {
    vin, hardware: HARDWARE[vehicle.hardwareRev].label, supplier: supplierLabel(vehicle.supplier), firmware: releaseLabel(vehicle),
    depot: vehicle.depot, online: vehicle.online, stale: !vehicle.online, reportedAgoMin: world.now - knownUntil, odometer,
    drift: drift(vehicle), faulted: vehicle.faulted, components,
    state, verdict: verdictFor(state, vehicle.faulted),
  };
}

export function scheduleRepair(world, vin, componentId) {
  if (!componentById(componentId)) throw new Error(`Unknown component ${componentId}`);
  scheduleService(world, vin, componentId);
}

const per100k = (failures, km) => (km > 0 ? Math.round((failures / km) * 1000000) / 10 : 0);

// Is one group really different from everyone else, or is this just a small sample?
function compareGroup(group, total) {
  const others = { failures: total.failures - group.failures, km: total.km - group.km };
  if (group.failures < MIN_FAILURES || others.failures < MIN_FAILURES) return null;
  const ratio = (group.failures / group.km) / (others.failures / others.km);
  const z = Math.log(ratio) / Math.sqrt(1 / group.failures + 1 / others.failures);
  return ratio >= MIN_RATIO && z >= MIN_Z ? Math.round(ratio * 10) / 10 : null;
}

// Failures per distance, by part, with the groups that fail more often than the rest.
export function componentReliability(world) {
  const repairs = repairIndex(world);
  return COMPONENTS.map((component) => {
    const total = { failures: 0, km: 0, open: 0, vehicles: 0 };
    const weekly = Array(TREND_WEEKS).fill(0);
    const groups = new Map();
    const add = (key, label, kind, failures, km) => {
      const group = groups.get(key) ?? { key, label, kind, failures: 0, km: 0 };
      group.failures += failures;
      group.km += km;
      groups.set(key, group);
    };
    for (const vehicle of world.fleet) {
      if (!fitted(vehicle, component)) continue;
      const { seen, open } = classify(vehicle, component, repairs, knownUntilFor(world, vehicle), world.now);
      const km = odometerKm(world, vehicle);
      total.vehicles += 1;
      for (const event of seen) {
        const weeksAgo = Math.floor((world.now - event.at) / (7 * DAY));
        if (weeksAgo < TREND_WEEKS) weekly[TREND_WEEKS - 1 - weeksAgo] += 1;
      }
      total.failures += seen.length;
      total.km += km;
      total.open += open.length;
      add(`s:${vehicle.supplier}`, supplierLabel(vehicle.supplier), 'Battery supplier', seen.length, km);
      add(`h:${vehicle.hardwareRev}`, HARDWARE[vehicle.hardwareRev].label, 'Hardware', seen.length, km);
    }
    const breakdown = [...groups.values()].map((group) => ({
      ...group, per100k: per100k(group.failures, group.km), timesRest: compareGroup(group, total),
    }));
    const finding = breakdown.filter((group) => group.timesRest !== null).sort((a, b) => b.timesRest - a.timesRest)[0] ?? null;
    return {
      id: component.id, label: component.label, system: component.system,
      vehicles: total.vehicles, failures: total.failures, open: total.open, km: total.km,
      per100k: per100k(total.failures, total.km),
      mtbfKm: total.failures > 0 ? Math.round(total.km / total.failures) : null,
      breakdown, finding, weekly,
    };
  }).sort((a, b) => b.per100k - a.per100k);
}
