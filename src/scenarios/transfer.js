// Moving a vehicle between operators. The hard version: the vehicle is offline with an
// unsent trip when the transfer happens.
import { commission, createRegistry, entitlementsFor, grantEntitlement, provision, transfer } from '../core/identity.js';
import { createPipeline, flush, naiveReadFor, readFor, recordEvent } from '../core/telemetry.js';
import { addDriver, attemptStart, createAuthority, createVehicleAuth, sync } from '../core/auth.js';
import { at, HOUR } from '../core/time.js';

export const VIN = 'V-1042';
export const FLEET_A = 'Harbor Routes (Operator A)';
export const FLEET_B = 'Mesa Last Mile (Operator B)';
export const DRIVER_A = 'driver-A7';
export const DRIVER_B = 'driver-B2';

export function createTransferWorld() {
  const auth = createAuthority({ ttlMinutes: 12 * HOUR });
  addDriver(auth, { driverId: DRIVER_A, fleetId: FLEET_A });
  addDriver(auth, { driverId: DRIVER_B, fleetId: FLEET_B });
  return {
    reg: createRegistry(),
    pipe: createPipeline(),
    auth,
    vehicle: createVehicleAuth(VIN),
    now: at(1, 9),
    stepIndex: 0,
    log: [],
    starts: [],
  };
}

function tryStart(world, driverId) {
  const result = attemptStart(world.auth, world.reg, world.vehicle, driverId, world.now);
  world.starts.push({ at: world.now, driverId, ...result });
  return result;
}

export const TRANSFER_STEPS = [
  {
    title: 'Provision at the factory',
    note: 'The device gets its own certificate. It can connect, and it belongs to nobody yet.',
    run(w) {
      provision(w.reg, { deviceId: 'tcu-88213', vin: VIN, certificate: 'cert-88213', at: w.now });
      grantEntitlement(w.reg, { vin: VIN, feature: 'Battery health reports', scope: 'vehicle', at: w.now });
    },
  },
  {
    title: 'Self-commission to Operator A',
    note: 'Months later, in the field. No technician, so the operator does it.',
    run(w) {
      w.now = at(120, 8);
      commission(w.reg, { vin: VIN, fleetId: FLEET_A, at: w.now, by: 'Operator A owner' });
      grantEntitlement(w.reg, { vin: VIN, feature: 'Route range forecast', scope: 'contract', fleetId: FLEET_A, at: w.now });
      sync(w.auth, w.reg, w.vehicle, w.now);
    },
  },
  {
    title: 'Connected trip under Operator A',
    note: 'The normal path. The event arrives as it happens.',
    run(w) {
      w.now = at(121, 7);
      tryStart(w, DRIVER_A);
      recordEvent(w.vehicle, { eventId: 'trip-1', vin: VIN, at: w.now, kind: 'trip', data: { km: 31 }, location: 'Depot 1' });
      flush(w.pipe, w.vehicle, w.now + 2);
    },
  },
  {
    title: 'Offline trip under Operator A',
    note: 'The vehicle ends the day in a parking structure, with the trip still in its buffer.',
    run(w) {
      w.now = at(122, 7);
      sync(w.auth, w.reg, w.vehicle, w.now);
      w.vehicle.online = false;
      w.now = at(122, 16);
      recordEvent(w.vehicle, { eventId: 'trip-2', vin: VIN, at: w.now, kind: 'trip', data: { km: 27 }, location: 'Route 12' });
    },
  },
  {
    title: 'Transfer to Operator B while offline',
    note: 'The cloud changes instantly. The vehicle has no idea, so Operator A\'s driver still has a cached lease.',
    run(w) {
      w.now = at(122, 17);
      w.lastTransfer = transfer(w.reg, { vin: VIN, toFleetId: FLEET_B, at: w.now, by: 'Fleet ops' });
      tryStart(w, DRIVER_A);
      tryStart(w, DRIVER_B);
    },
  },
  {
    title: 'Lease expires, still offline',
    note: 'The window closes on its own. It also means nobody can start this vehicle until it reconnects.',
    run(w) {
      w.now = at(122, 19);
      tryStart(w, DRIVER_A);
      tryStart(w, DRIVER_B);
    },
  },
  {
    title: 'Vehicle reconnects',
    note: 'The old trip arrives after the transfer. It goes to the owner at event time, not arrival time.',
    run(w) {
      w.now = at(123, 6);
      w.vehicle.online = true;
      flush(w.pipe, w.vehicle, w.now);
      tryStart(w, DRIVER_A);
      tryStart(w, DRIVER_B);
    },
  },
  {
    title: 'First trip under Operator B',
    note: 'The new owner sees this trip and nothing from before the transfer.',
    run(w) {
      w.now = at(123, 7);
      recordEvent(w.vehicle, { eventId: 'trip-3', vin: VIN, at: w.now, kind: 'trip', data: { km: 22 }, location: 'Route 7' });
      flush(w.pipe, w.vehicle, w.now + 2);
    },
  },
];

export function advanceTransfer(world) {
  const next = TRANSFER_STEPS[world.stepIndex];
  if (!next) return false;
  next.run(world);
  world.log.push({ at: world.now, title: next.title, note: next.note });
  world.stepIndex += 1;
  return true;
}

export function transferViews(world) {
  const view = (fleetId) => ({
    fleetId,
    trips: readFor(world.pipe, world.reg, { fleetId, vin: VIN }),
    naiveTrips: naiveReadFor(world.pipe, world.reg, { fleetId, vin: VIN }),
    entitlements: entitlementsFor(world.reg, { vin: VIN, fleetId, at: world.now }),
  });
  return [view(FLEET_A), view(FLEET_B)];
}
