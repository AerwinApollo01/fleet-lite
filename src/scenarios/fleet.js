// One fleet shared by the Vehicle and OTA tabs. Mixed hardware and suppliers, on purpose.
import { applyConnectivity, createCampaign, faultModel, step, versionInventory } from '../core/ota.js';
import { at, HOUR } from '../core/time.js';
import { CATALOG } from '../sdv/catalog.js';
import { featureApplier } from '../sdv/deploy.js';
import { canHost, resolveCapabilities } from '../sdv/resolver.js';
import { createTwin, reconcile, setDesired } from '../sdv/twin.js';

export const OWNER = 'Release owner';
export const FACTORY_FEATURES = ['range-forecast', 'battery-health'];
const FACTORY_VERSION = '1.4.2';
const HEALTHY = 0.005;
const BAD = 0.4;

export const ROLLOUTS = [
  { id: 'fw-good', kind: 'firmware', label: 'Firmware 1.5.0', build: '1.5.0', faultRate: HEALTHY },
  { id: 'fw-bad', kind: 'firmware', label: 'Firmware 1.5.1 (bad)', build: '1.5.1', faultRate: BAD },
  { id: 'load', kind: 'feature', featureId: 'load-aware-range', label: 'Load-aware range', build: '1.0', faultRate: HEALTHY },
  { id: 'load-bad', kind: 'feature', featureId: 'load-aware-range', label: 'Load-aware range (bad)', build: '1.0-rc2', faultRate: BAD },
  { id: 'coach', kind: 'feature', featureId: 'driver-coaching', label: 'Driver coaching', build: '1.0', faultRate: HEALTHY },
  { id: 'prox', kind: 'feature', featureId: 'proximity-alert', label: 'Proximity alerts', build: '1.0', faultRate: HEALTHY },
];

export function createFleetWorld(count = 60) {
  const fleet = Array.from({ length: count }, (_, i) => ({
    ...createTwin({
      vin: `V-${String(i + 1).padStart(3, '0')}`,
      hardwareRev: i % 4 === 0 ? 'lean' : 'headroom',
      supplier: (i >> 2) % 2 === 0 ? 'alpha' : 'bravo',
      factory: { installed: FACTORY_FEATURES, entitled: FACTORY_FEATURES },
    }),
    version: FACTORY_VERSION,
    faulted: false,
    pinnedOffline: false,
  }));
  const now = at(1, 10);
  applyConnectivity(fleet, now);
  return { now, fleet, campaign: null, rollout: null, excluded: [], swaps: {} };
}

export function resetFleet(world) {
  Object.assign(world, createFleetWorld(world.fleet.length));
}

export const rolloutActive = (world) =>
  world.campaign !== null && !['complete', 'rolled_back'].includes(world.campaign.status);

function currentVersion(world) {
  return Object.entries(versionInventory(world.fleet)).sort((a, b) => b[1] - a[1])[0][0];
}

function audience(world, rollout) {
  if (rollout.kind === 'firmware') {
    return { hosts: world.fleet.filter((v) => v.version !== rollout.build), excluded: [] };
  }
  const feature = CATALOG.find((f) => f.id === rollout.featureId);
  const hosts = [];
  const excluded = [];
  for (const twin of world.fleet) {
    const check = canHost(twin, feature);
    if (check.ok) hosts.push(twin);
    else excluded.push({ vin: twin.vin, reason: check.reason });
  }
  return { hosts, excluded };
}

export function canStart(world, rollout) {
  return !rolloutActive(world) && audience(world, rollout).hosts.length > 0;
}

export function startRollout(world, rolloutId) {
  const rollout = ROLLOUTS.find((r) => r.id === rolloutId);
  if (!rollout) throw new Error(`Unknown rollout ${rolloutId}`);
  if (rolloutActive(world)) throw new Error('Finish or roll back the current campaign first');

  const { hosts, excluded } = audience(world, rollout);
  if (hosts.length === 0) throw new Error('No vehicle can host this build');

  const isFeature = rollout.kind === 'feature';
  const toVersion = isFeature ? `${rollout.featureId}@${rollout.build}` : rollout.build;
  const targets = new Set(hosts.map((v) => v.vin));

  world.rollout = rollout;
  world.excluded = excluded;
  world.campaign = createCampaign({
    id: `${rollout.id}-${world.now}`,
    fromVersion: isFeature ? 'not installed' : currentVersion(world),
    toVersion,
    owner: OWNER,
    startAt: world.now,
    stages: [
      { name: 'Canary', share: 0.1 },
      { name: 'Early', share: 0.3 },
      { name: 'Full fleet', share: 1 },
    ],
    gate: { metric: 'post-install faults', maxRate: 0.1, soakMinutes: 24 * HOUR, minSample: 5 },
    eligible: (v) => targets.has(v.vin),
    ...(isFeature ? { applier: featureApplier(rollout.featureId) } : {}),
  });
}

export function advanceFleet(world, hours) {
  for (let i = 0; i < hours; i++) {
    world.now += HOUR;
    applyConnectivity(world.fleet, world.now);
    for (const twin of world.fleet) {
      if (twin.pinnedOffline) twin.online = false;
      reconcile(twin, world.now);
    }
    if (world.campaign) {
      step(world.campaign, world.fleet, world.now, faultModel(world.rollout.faultRate));
    }
  }
}

// Release is a separate decision from deployment, and it can happen after hours or on shift.
export function entitleInstalled(world, featureId) {
  let changed = 0;
  for (const twin of world.fleet) {
    if (!twin.reported.installed.includes(featureId) || twin.desired.entitled.includes(featureId)) continue;
    setDesired(twin, { entitled: [...twin.desired.entitled, featureId] });
    reconcile(twin, world.now);
    changed += 1;
  }
  return changed;
}

export function featureCounts(world, featureId) {
  const installed = world.fleet.filter((v) => v.reported.installed.includes(featureId)).length;
  const active = world.fleet.filter((v) => resolveCapabilities(v).active.includes(featureId)).length;
  return { installed, active };
}
