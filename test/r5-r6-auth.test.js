import { describe, expect, it } from 'vitest';
import { commission, createRegistry, provision } from '../src/core/identity.js';
import { addDriver, attemptStart, createAuthority, createVehicleAuth, decideLocally, exposureMinutes, revokeDriver, sampleOvernightParks, sync, ttlTradeoff } from '../src/core/auth.js';
import { revocationNight } from '../src/scenarios/revocation.js';
import { HOUR } from '../src/core/time.js';

const TTL = 12 * HOUR;

function world() {
  const reg = createRegistry();
  provision(reg, { deviceId: 'd', vin: 'V', certificate: 'c', at: 0 });
  commission(reg, { vin: 'V', fleetId: 'A', at: 1, by: 'o' });
  const auth = createAuthority({ ttlMinutes: TTL });
  addDriver(auth, { driverId: 'x', fleetId: 'A' });
  addDriver(auth, { driverId: 'other-fleet', fleetId: 'B' });
  const vehicle = createVehicleAuth('V');
  sync(auth, reg, vehicle, 100);
  return { reg, auth, vehicle };
}

describe('R5 revocation has a stated worst case', () => {
  it('denies on the next start when connected', () => {
    const { reg, auth, vehicle } = world();
    revokeDriver(auth, { driverId: 'x', at: 200 });
    expect(attemptStart(auth, reg, vehicle, 'x', 201).allowed).toBe(false);
  });

  it('allows an offline start inside the lease and denies at expiry', () => {
    const { reg, auth, vehicle } = world();
    vehicle.online = false;
    revokeDriver(auth, { driverId: 'x', at: 200 });
    expect(attemptStart(auth, reg, vehicle, 'x', 100 + TTL - 1).allowed).toBe(true);
    const denied = attemptStart(auth, reg, vehicle, 'x', 100 + TTL);
    expect(denied).toMatchObject({ allowed: false, reason: 'lease-expired', decidedFrom: 'vehicle-cache' });
  });

  it('never lets exposure exceed the TTL', () => {
    const { auth, vehicle } = world();
    revokeDriver(auth, { driverId: 'x', at: 100 });
    expect(exposureMinutes(vehicle, 'x', 100)).toBe(TTL);
    expect(exposureMinutes(vehicle, 'x', 100 + TTL + 50)).toBe(0);
  });

  it('never leases a driver from another fleet', () => {
    const { vehicle } = world();
    expect(decideLocally(vehicle, 'other-fleet', 101).allowed).toBe(false);
  });
});

describe('R6 a legitimate driver can start with no signal', () => {
  it('decides from vehicle state alone', () => {
    const { reg, auth, vehicle } = world();
    vehicle.online = false;
    expect(attemptStart(auth, reg, vehicle, 'x', 200)).toMatchObject({ allowed: true, decidedFrom: 'vehicle-cache' });
  });

  it('shows the real tradeoff: a short lease locks out the legit driver too', () => {
    expect(revocationNight(8).garaged).toMatchObject({ revoked: { allowed: false }, legit: { allowed: false } });
    expect(revocationNight(12).garaged).toMatchObject({ revoked: { allowed: true }, legit: { allowed: true } });
  });

  it('always denies the revoked driver on a connected vehicle', () => {
    for (const hours of [2, 8, 12, 72]) {
      expect(revocationNight(hours).connected).toMatchObject({ revoked: { allowed: false }, legit: { allowed: true } });
    }
  });

  it('moves exposure and lockouts in opposite directions', () => {
    const parks = sampleOvernightParks();
    const rows = [4, 8, 10, 12, 24].map((h) => ttlTradeoff(h, parks));
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i].worstCaseExposureHours).toBeGreaterThan(rows[i - 1].worstCaseExposureHours);
      expect(rows[i].lockoutRate).toBeLessThanOrEqual(rows[i - 1].lockoutRate);
    }
    expect(rows[0].lockoutRate).toBeGreaterThan(0);
    expect(rows.at(-1).lockoutRate).toBe(0);
  });
});
