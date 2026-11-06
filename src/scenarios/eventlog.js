// One vehicle's event log. Entries are added and never changed, so a correction is a new entry.
// Each keeps when it happened and when it arrived, because the gap between them explains a lot of
// "missing" data. The verdicts, readings, and frames people see at different depths all come from here.
import { decodeFrame } from '../core/can.js';
import { can } from '../core/roles.js';
import { DAY, HOUR } from '../core/time.js';
import { COMPONENTS, componentById, faultEvents, knownUntil, readingsAt, workLabel } from './components.js';
import { firmwareAt } from './firmware.js';

const HISTORY_START = -30 * DAY;
const SUSTAIN_DAYS = 3;
const LATE_MINUTES = HOUR;
const HIDDEN_FROM_SERVICE = ['route', 'alert']; // These can say where a vehicle or driver was.
const SCALE = 0.1;
const OFFSET = -40;

export const KINDS = { fault: 'Fault', tolerance: 'Operating range', service: 'Service', firmware: 'Firmware', battery: 'Battery', route: 'Route', alert: 'Alert' };
export const SEVERITIES = { fault: 'Fault', watch: 'Watch', info: 'Info' };

const hex = (byte) => byte.toString(16).toUpperCase().padStart(2, '0');

// The reading as it would look on the bus, decoded by the same code as the Learn screen's decoder.
function frameFor(reading) {
  const index = COMPONENTS.findIndex((component) => component.id === reading.part);
  const raw = Math.round((reading.value - OFFSET) / SCALE);
  const bytes = [Math.floor(raw / 256), raw % 256];
  const [decoded] = decodeFrame(bytes, [{ name: reading.label, bytes: [0, 1], scale: SCALE, offset: OFFSET, unit: reading.unit, decimals: 1 }]);
  return { id: `0x${(0x180 + index * 0x10).toString(16).toUpperCase()}`, data: bytes.map(hex).join(' '), raw: decoded.raw, formula: `(raw × ${SCALE}) − ${Math.abs(OFFSET)}`, value: decoded.value, unit: reading.unit };
}

function snapshot(world, vin, t, part) {
  const readings = readingsAt(world, vin, t);
  const main = readings.find((reading) => reading.part === part) ?? null;
  const system = componentById(part)?.system;
  const freeze = readings.filter((reading) => reading.system === system).map(({ label, value, unit, status }) => ({ label, value, unit, status }));
  return { reading: main && { label: main.label, value: main.value, unit: main.unit, limit: main.limit, status: main.status }, freeze, frame: main ? frameFor(main) : null };
}

function faultEntries(world, vehicle) {
  return faultEvents(world, vehicle.vin).map((event) => ({
    key: `fault:${event.componentId}:${event.at}`, at: event.at, receivedAt: event.receivedAt, kind: 'fault', part: event.componentId,
    severity: event.severity, code: event.code, text: event.title, km: event.km,
    ...snapshot(world, vehicle.vin, event.at, event.componentId),
  }));
}

// A change of operating range counts once it has lasted, so a brief spike leaves no entry.
function toleranceEntries(world, vehicle) {
  const known = knownUntil(world, vehicle.vin);
  const entries = [];
  const parts = COMPONENTS.filter((component) => component.signal);
  const state = new Map(parts.map((component) => [component.id, { current: 'normal', pending: null, run: 0 }]));
  for (let day = HISTORY_START / DAY; day * DAY + 12 * HOUR <= known; day++) {
    const t = day * DAY + 12 * HOUR;
    for (const reading of readingsAt(world, vehicle.vin, t)) {
      const track = state.get(reading.part);
      track.run = reading.status === track.pending ? track.run + 1 : 1;
      track.pending = reading.status;
      if (track.run < SUSTAIN_DAYS || reading.status === track.current) continue;
      track.current = reading.status;
      const text = { normal: `${reading.label} back in its normal range`, caution: `${reading.label} outside its normal range`, limit: `${reading.label} reached its limit` }[reading.status];
      entries.push({
        key: `tol:${reading.part}:${day}:${reading.status}`, at: t, receivedAt: t + 2, kind: 'tolerance', part: reading.part,
        severity: { normal: 'info', caution: 'watch', limit: 'fault' }[reading.status], code: null, text,
        ...snapshot(world, vehicle.vin, t, reading.part),
      });
    }
  }
  return entries;
}

const record = (key, at, kind, part, text, severity = 'info') => ({ key, at, receivedAt: at, kind, part, severity, code: null, text });

function recordEntries(world, vehicle) {
  const { vin } = vehicle;
  const entries = [];
  for (const order of world.serviceOrders.filter((o) => o.vin === vin)) {
    entries.push(record(`order:${order.id}`, order.createdAt, 'service', order.itemId, `Work order #${order.id} scheduled: ${workLabel(order.itemId)}`));
    if (order.doneAt !== null) entries.push(record(`order:${order.id}:done`, order.doneAt, 'service', order.itemId, `Work order #${order.id} completed: ${workLabel(order.itemId)}. Open faults on this part closed`));
  }
  for (const swap of world.packEvents.filter((e) => e.vin === vin)) {
    entries.push(record(`pack:${swap.at}:${swap.installed}`, swap.at, 'battery', 'pack', `Battery swapped: ${swap.removed} out, ${swap.installed} in`));
  }
  world.firmwareLog.filter((e) => e.vin === vin).forEach((entry, i) => entries.push(record(`fw:${i}`, entry.at, 'firmware', null, entry.text)));
  const install = world.campaign?.results.get(vin);
  if (install) entries.push(record(`campaign:${world.campaign.id}`, install.at, 'firmware', 'vcu', `Fleet rollout installed ${world.campaign.toVersion}${install.outcome === 'fault' ? ', with a fault' : ''}`, install.outcome === 'fault' ? 'fault' : 'info'));
  vehicle.fixes.forEach((fix, i) => entries.push(record(`fix:${i}:${fix.at}`, fix.at, 'service', fix.part, `Fix applied for issue #${fix.issueId}: ${fix.label}`)));
  world.swapLog.filter((swap) => swap.to === vin || swap.from === vin).forEach((swap) => entries.push(record(`swap:${swap.id}:${vin}`, swap.at, 'route', null, swap.to === vin ? `Took over route ${swap.routeId}` : `Replaced on route ${swap.routeId}`)));
  world.alerts.filter((alert) => alert.vin === vin).forEach((alert) => entries.push(record(`alert:${alert.id ?? alert.key}:${alert.openedAt}`, alert.openedAt, 'alert', null, alert.title, alert.severity === 'critical' ? 'fault' : 'watch')));
  return entries;
}

const deepFreeze = (value) => {
  if (value && typeof value === 'object') Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
};

// Adds what's new and leaves what's there alone. Sequence is arrival order.
export function syncEventLog(world, vin) {
  const vehicle = world.fleet.find((v) => v.vin === vin);
  const log = world.eventLogs[vin] ?? { entries: [], keys: new Set() };
  world.eventLogs[vin] = log;
  const fresh = [...faultEntries(world, vehicle), ...toleranceEntries(world, vehicle), ...recordEntries(world, vehicle)]
    .filter((entry) => !log.keys.has(entry.key) && entry.receivedAt <= world.now)
    .sort((a, b) => a.receivedAt - b.receivedAt || a.at - b.at);
  for (const entry of fresh) {
    log.keys.add(entry.key);
    log.entries.push(deepFreeze({
      ...entry, seq: log.entries.length + 1, vin, partLabel: entry.part ? workLabel(entry.part) : null,
      firmware: firmwareAt(vehicle, entry.at), late: entry.receivedAt - entry.at >= LATE_MINUTES,
    }));
  }
  return log.entries;
}

// What this persona may read. Limits are applied here, not only on screen.
export function eventLogFor(world, vin, role) {
  const entries = syncEventLog(world, vin).filter((entry) => role !== 'technician' || !HIDDEN_FROM_SERVICE.includes(entry.kind));
  const raw = can(role, 'trace.view');
  return entries.map((entry) => (raw ? entry : { ...entry, frame: null })).sort((a, b) => b.at - a.at || b.seq - a.seq);
}

export function filterLog(entries, { part = '', kind = '', severity = '', search = '' } = {}) {
  const words = search.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return entries.filter((entry) => (!part || entry.part === part) && (!kind || entry.kind === kind) && (!severity || entry.severity === severity)
    && words.every((word) => `${entry.text} ${entry.code ?? ''} ${entry.partLabel ?? ''}`.toLowerCase().includes(word)));
}

