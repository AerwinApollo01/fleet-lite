// Layer 3. Provisioning gives a device an identity. Commissioning gives a vehicle an owner.
// They happen months apart, so the registry has to represent the gap between them.

export function createRegistry() {
  return { devices: new Map(), vehicles: new Map(), assignments: [], entitlements: [], audit: [] };
}

function note(reg, at, action, detail) {
  reg.audit.push({ at, action, detail });
}

export function provision(reg, { deviceId, vin, certificate, at }) {
  if (reg.devices.has(deviceId)) throw new Error(`Device ${deviceId} is already provisioned`);
  if (reg.vehicles.has(vin)) throw new Error(`Vehicle ${vin} already has a device`);
  for (const device of reg.devices.values()) {
    if (device.certificate === certificate) throw new Error('Certificates cannot be shared between devices');
  }
  reg.devices.set(deviceId, { deviceId, vin, certificate, provisionedAt: at });
  reg.vehicles.set(vin, { vin, deviceId });
  note(reg, at, 'provisioned', `${vin} received its own certificate`);
}

export function ownerAt(reg, vin, t) {
  const hit = reg.assignments.find((a) => a.vin === vin && a.from <= t && (a.to === null || t < a.to));
  return hit ? hit.fleetId : null;
}

function currentAssignment(reg, vin) {
  return reg.assignments.find((a) => a.vin === vin && a.to === null) ?? null;
}

export function commission(reg, { vin, fleetId, at, by, selfTestPassed = true }) {
  if (!reg.vehicles.has(vin)) throw new Error(`Vehicle ${vin} has not been provisioned`);
  if (currentAssignment(reg, vin)) throw new Error(`Vehicle ${vin} already has an owner`);
  if (!selfTestPassed) throw new Error(`Vehicle ${vin} failed its first-use check`);
  reg.assignments.push({ vin, fleetId, from: at, to: null });
  note(reg, at, 'commissioned', `${vin} put into service for ${fleetId} by ${by}`);
}

export function grantEntitlement(reg, { vin, feature, scope, fleetId = null, at }) {
  if (scope !== 'vehicle' && scope !== 'contract') throw new Error(`Unknown entitlement scope: ${scope}`);
  if (scope === 'contract' && !fleetId) throw new Error('A contract entitlement needs a fleet');
  reg.entitlements.push({ vin, feature, scope, fleetId, from: at, to: null });
}

// The customer-visible read. A fleet can only see entitlements on vehicles it owns right now.
export function entitlementsFor(reg, { vin, fleetId, at }) {
  if (ownerAt(reg, vin, at) !== fleetId) return [];
  return reg.entitlements.filter(
    (e) =>
      e.vin === vin &&
      e.from <= at &&
      (e.to === null || at < e.to) &&
      (e.scope === 'vehicle' || e.fleetId === fleetId),
  );
}

export function transfer(reg, { vin, toFleetId, at, by }) {
  const current = currentAssignment(reg, vin);
  if (!current) throw new Error(`Vehicle ${vin} has no owner to transfer from`);
  if (current.fleetId === toFleetId) throw new Error(`Vehicle ${vin} already belongs to ${toFleetId}`);
  if (at <= current.from) throw new Error('A transfer must happen after the current assignment began');

  current.to = at;
  reg.assignments.push({ vin, fleetId: toFleetId, from: at, to: null });

  const ended = reg.entitlements.filter((e) => e.vin === vin && e.scope === 'contract' && e.to === null);
  for (const entitlement of ended) entitlement.to = at;

  note(reg, at, 'transferred', `${vin} moved from ${current.fleetId} to ${toFleetId} by ${by}`);
  return { from: current.fleetId, to: toFleetId, endedEntitlements: ended.map((e) => e.feature) };
}
