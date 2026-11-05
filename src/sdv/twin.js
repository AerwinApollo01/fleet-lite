// AD-4. Desired is what the cloud wants. Reported is what the vehicle actually runs.
// A generation applies whole or not at all, and the vehicle re-checks it on arrival.
import { isOnShift } from '../core/ota.js';
import { entitlementsFor, ownerAt } from '../core/identity.js';
import { DEFAULT_CONFIG, validateConfig } from './hardware.js';

const blank = (factory) => ({
  generation: 0,
  installed: [...factory.installed],
  entitled: [...factory.entitled],
  config: { ...DEFAULT_CONFIG },
});

// Generation 0 is the factory image. Anything after that happened post-delivery.
export function createTwin({ vin, hardwareRev, supplier, factory = { installed: [], entitled: [] } }) {
  return {
    vin, hardwareRev, supplier,
    online: true,
    desired: blank(factory),
    reported: { ...blank(factory), syncedAt: null, rejected: null },
  };
}

// The cloud-side check. Throws before anything is queued.
export function setDesired(twin, patch) {
  const errors = validateConfig(patch.config ?? {});
  if (errors.length) throw new Error(errors.join('; '));
  twin.desired = {
    ...twin.desired,
    ...patch,
    config: { ...twin.desired.config, ...patch.config },
    generation: twin.desired.generation + 1,
  };
}

const sameSet = (a, b) => a.length === b.length && a.every((item) => b.includes(item));

export function drift(twin) {
  const { desired, reported } = twin;
  const keys = [];
  if (!sameSet(desired.installed, reported.installed)) keys.push('installed');
  if (!sameSet(desired.entitled, reported.entitled)) keys.push('entitled');
  for (const key of Object.keys(desired.config)) {
    if (desired.config[key] !== reported.config[key]) keys.push(key);
  }
  return keys;
}

export function reconcile(twin, now) {
  const { desired, reported } = twin;
  if (!twin.online) return { applied: false, reason: 'offline' };
  if (desired.generation === reported.generation) return { applied: false, reason: 'in-sync' };

  // The vehicle's own check. It doesn't assume the cloud got this right.
  const errors = validateConfig(desired.config);
  if (errors.length) {
    reported.rejected = { generation: desired.generation, errors };
    return { applied: false, reason: 'rejected', errors };
  }
  if (!sameSet(desired.installed, reported.installed) && isOnShift(now)) {
    return { applied: false, reason: 'on-shift' };
  }

  twin.reported = {
    generation: desired.generation,
    installed: [...desired.installed],
    entitled: [...desired.entitled],
    config: { ...desired.config },
    syncedAt: now,
    rejected: null,
  };
  return { applied: true, reason: 'applied' };
}

// The registry is the source of truth for entitlement. The twin carries it to the vehicle.
export function syncEntitlements(twin, reg, now) {
  const fleetId = ownerAt(reg, twin.vin, now);
  const entitled = fleetId ? entitlementsFor(reg, { vin: twin.vin, fleetId, at: now }).map((e) => e.feature) : [];
  setDesired(twin, { entitled });
}
