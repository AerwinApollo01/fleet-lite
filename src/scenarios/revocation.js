// Revoking a driver in the evening, before the next shift. Built from the real auth code, so the table can't drift from it.
import { commission, createRegistry, provision } from '../core/identity.js';
import { addDriver, attemptStart, createAuthority, createVehicleAuth, exposureMinutes, revokeDriver, sync, ttlMinutes } from '../core/auth.js';
import { at } from '../core/time.js';

export const LAST_SYNC = at(1, 20);
export const REVOKED_AT = at(1, 21);
export const SHIFT_START = at(2, 5);

export function revocationNight(ttlHours) {
  const reg = createRegistry();
  const auth = createAuthority({ ttlMinutes: ttlMinutes(ttlHours) });
  const fleetId = 'operator';
  addDriver(auth, { driverId: 'revoked', fleetId });
  addDriver(auth, { driverId: 'legit', fleetId });

  const setUp = (vin, n) => {
    provision(reg, { deviceId: `d-${n}`, vin, certificate: `c-${n}`, at: 0 });
    commission(reg, { vin, fleetId, at: 1, by: 'owner' });
    const vehicle = createVehicleAuth(vin);
    sync(auth, reg, vehicle, LAST_SYNC);
    return vehicle;
  };
  const connected = setUp('connected', 1);
  const garaged = setUp('garaged', 2);
  garaged.online = false;

  revokeDriver(auth, { driverId: 'revoked', at: REVOKED_AT });
  const exposure = exposureMinutes(garaged, 'revoked', REVOKED_AT);

  const attempt = (vehicle, driverId) => attemptStart(auth, reg, vehicle, driverId, SHIFT_START);
  return {
    exposureMinutes: exposure,
    connected: { revoked: attempt(connected, 'revoked'), legit: attempt(connected, 'legit') },
    garaged: { revoked: attempt(garaged, 'revoked'), legit: attempt(garaged, 'legit') },
  };
}
