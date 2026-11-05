// Layer 4, only as far as transfer needs it. Events keep two clocks: when they happened and
// when they arrived. Tenancy follows the first. Location is split out on arrival because it
// has its own retention clock, which is the one deliberate exception to "raw is immutable".
import { ownerAt } from './identity.js';

export function createPipeline() {
  return { raw: [], seen: new Set(), locations: new Map() };
}

export function recordEvent(vehicle, event) {
  vehicle.buffer.push(event);
}

export function ingest(pipe, event, receivedAt) {
  if (pipe.seen.has(event.eventId)) return false;
  pipe.seen.add(event.eventId);
  const { location, ...rest } = event;
  if (location) pipe.locations.set(event.eventId, { location, at: event.at });
  pipe.raw.push(Object.freeze({ ...rest, receivedAt }));
  return true;
}

export function flush(pipe, vehicle, receivedAt) {
  const stored = vehicle.buffer.filter((event) => ingest(pipe, event, receivedAt)).length;
  vehicle.buffer = [];
  return stored;
}

function withLocation(pipe, record) {
  const entry = pipe.locations.get(record.eventId);
  return entry ? { ...record, location: entry.location } : record;
}

export function readFor(pipe, reg, { fleetId, vin }) {
  return pipe.raw
    .filter((r) => r.vin === vin && ownerAt(reg, vin, r.at) === fleetId)
    .map((r) => withLocation(pipe, r));
}

// The bug, kept on purpose so the demo and the tests can show what it would leak.
export function naiveReadFor(pipe, reg, { fleetId, vin }) {
  return pipe.raw.filter((r) => r.vin === vin && ownerAt(reg, vin, r.receivedAt) === fleetId);
}

export function quarantined(pipe, reg) {
  return pipe.raw.filter((r) => ownerAt(reg, r.vin, r.at) === null);
}

export function expireLocations(pipe, now, retentionMinutes) {
  let removed = 0;
  for (const [eventId, entry] of pipe.locations) {
    if (now - entry.at >= retentionMinutes) {
      pipe.locations.delete(eventId);
      removed += 1;
    }
  }
  return removed;
}
