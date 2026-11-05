// Driver → vehicle. The cloud decides who may drive; the vehicle has to act on that decision
// with no signal. So the cloud issues short leases, the vehicle caches them, and the worst
// case for a revocation is the lease TTL rather than "whenever it reconnects".
import { ownerAt } from './identity.js';
import { HOUR } from './time.js';
import { mulberry32 } from './rng.js';

export function createAuthority({ ttlMinutes }) {
  if (!(ttlMinutes > 0)) throw new Error('Lease TTL must be positive');
  return { ttlMinutes, drivers: new Map() };
}

export function addDriver(auth, { driverId, fleetId }) {
  auth.drivers.set(driverId, { driverId, fleetId, revokedAt: null });
}

export function revokeDriver(auth, { driverId, at }) {
  const driver = auth.drivers.get(driverId);
  if (!driver) throw new Error(`Unknown driver ${driverId}`);
  driver.revokedAt = at;
}

export function createVehicleAuth(vin, online = true) {
  return { vin, online, leases: new Map(), lastSyncAt: null, buffer: [] };
}

// Replaces the whole lease table, so anyone revoked or transferred away simply disappears.
export function sync(auth, reg, vehicle, now) {
  if (!vehicle.online) return false;
  const fleetId = ownerAt(reg, vehicle.vin, now);
  const leases = new Map();
  for (const driver of auth.drivers.values()) {
    if (driver.fleetId === fleetId && driver.revokedAt === null) {
      leases.set(driver.driverId, now + auth.ttlMinutes);
    }
  }
  vehicle.leases = leases;
  vehicle.lastSyncAt = now;
  return true;
}

// Reads vehicle state only. This function must never look at the authority.
export function decideLocally(vehicle, driverId, now) {
  const expiresAt = vehicle.leases.get(driverId);
  if (expiresAt === undefined) return { allowed: false, reason: 'no-lease' };
  if (now >= expiresAt) return { allowed: false, reason: 'lease-expired' };
  return { allowed: true, reason: 'valid-lease', expiresAt };
}

export function attemptStart(auth, reg, vehicle, driverId, now) {
  const synced = sync(auth, reg, vehicle, now);
  return { ...decideLocally(vehicle, driverId, now), decidedFrom: synced ? 'fresh-sync' : 'vehicle-cache' };
}

// Minutes a revoked driver can still start this vehicle if it never reconnects.
export function exposureMinutes(vehicle, driverId, revokedAt) {
  const expiresAt = vehicle.leases.get(driverId);
  return expiresAt === undefined ? 0 : Math.max(0, expiresAt - revokedAt);
}

// Illustrative overnight parking, not measured data.
export function sampleOvernightParks({ seed = 7, count = 500, noSignalShare = 0.3 } = {}) {
  const random = mulberry32(seed);
  return Array.from({ length: count }, () => ({
    gapHours: 7 + random() * 5,
    hasSignalAtStart: random() >= noSignalShare,
  }));
}

export function ttlTradeoff(ttlHours, parks) {
  const lockouts = parks.filter((p) => !p.hasSignalAtStart && p.gapHours >= ttlHours).length;
  return { ttlHours, worstCaseExposureHours: ttlHours, lockouts, lockoutRate: lockouts / parks.length };
}

export const ttlMinutes = (hours) => hours * HOUR;
