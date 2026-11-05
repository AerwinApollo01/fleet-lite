// Layer 6. Cohorts and gates are a hardware team's validation phases, compressed. Rollback is
// the undo they never had. The named owner is their change-control authority, preserved.
import { DAY, HOUR } from './time.js';
import { hash01 } from './rng.js';

export const SHIFT = { startHour: 6, endHour: 18 };

export function isOnShift(now) {
  const hour = (now % DAY) / HOUR;
  return hour >= SHIFT.startHour && hour < SHIFT.endHour;
}

// How a build reaches a vehicle. Firmware swaps a version. Features go through the twin.
export const versionApplier = {
  install(campaign, vehicle) {
    vehicle.version = campaign.toVersion;
    return true;
  },
  revert(campaign, vehicle) {
    vehicle.version = campaign.fromVersion;
    return true;
  },
  needsRevert: (campaign, vehicle) => vehicle.version === campaign.toVersion,
};

export function createCampaign(spec) {
  const { id, fromVersion, toVersion, owner, delegates = [], stages, gate, startAt, eligible = () => true, applier = versionApplier } = spec;
  if (!owner) throw new Error('A campaign needs a named owner');
  if (!gate?.metric) throw new Error('A campaign needs a named gate metric');
  if (!(gate.maxRate >= 0)) throw new Error('A campaign needs a gate threshold');
  if (!(gate.soakMinutes > 0)) throw new Error('A campaign needs a soak time');
  if (!(gate.minSample > 0)) throw new Error('A campaign needs a minimum sample');
  if (!stages?.length) throw new Error('A campaign needs at least one stage');
  return {
    id, fromVersion, toVersion, owner, delegates, stages, gate, eligible, applier,
    status: 'running',
    stageIndex: 0,
    soakStartedAt: null,
    results: new Map(),
    haltedBy: null,
    log: [{ at: startAt, text: `Campaign started by ${owner}` }],
  };
}

// AD-6. Vehicles that can't host the build are excluded by name, never counted as failures.
export function ineligible(campaign, fleet) {
  return fleet.filter((v) => !campaign.eligible(v));
}

function ordered(campaign, fleet) {
  return fleet.filter(campaign.eligible).sort((a, b) => hash01(campaign.id + a.vin) - hash01(campaign.id + b.vin));
}

export function stageTargets(campaign, fleet) {
  const share = campaign.stages[campaign.stageIndex].share;
  const targets = ordered(campaign, fleet);
  return targets.slice(0, Math.ceil(share * targets.length));
}

export function stageStats(campaign) {
  const results = [...campaign.results.values()].filter((r) => r.stageIndex === campaign.stageIndex);
  const faults = results.filter((r) => r.outcome === 'fault').length;
  return { sample: results.length, faults, rate: results.length ? faults / results.length : 0 };
}

const canTouch = (vehicle, now) => vehicle.online && !isOnShift(now);

export function outstanding(campaign, fleet) {
  return stageTargets(campaign, fleet).filter((v) => !campaign.results.has(v.vin));
}

function evaluateGate(campaign, fleet, now) {
  const { sample, faults, rate } = stageStats(campaign);
  const { gate } = campaign;
  if (sample < gate.minSample) return;

  if (rate > gate.maxRate) {
    campaign.status = 'halted';
    campaign.haltedBy = 'gate';
    campaign.log.push({
      at: now,
      text: `Gate halted the rollout: ${gate.metric} ${faults}/${sample} is over ${Math.round(gate.maxRate * 100)}%`,
    });
    return;
  }
  if (campaign.soakStartedAt === null) campaign.soakStartedAt = now;
  if (now - campaign.soakStartedAt < gate.soakMinutes) return;

  const passed = campaign.stages[campaign.stageIndex].name;
  if (campaign.stageIndex === campaign.stages.length - 1) {
    // Done means every vehicle is accounted for, not that the clock ran out.
    if (outstanding(campaign, fleet).length > 0) return;
    campaign.status = 'complete';
    campaign.log.push({ at: now, text: `${passed} passed. Rollout complete` });
    return;
  }
  campaign.stageIndex += 1;
  campaign.soakStartedAt = null;
  campaign.log.push({ at: now, text: `${passed} passed. Moved to ${campaign.stages[campaign.stageIndex].name}` });
}

export function rollbackRemaining(campaign, fleet) {
  return fleet.filter((v) => campaign.applier.needsRevert(campaign, v));
}

export function step(campaign, fleet, now, outcomeOf) {
  if (campaign.status === 'running') {
    for (const vehicle of stageTargets(campaign, fleet)) {
      if (campaign.results.has(vehicle.vin) || !canTouch(vehicle, now)) continue;
      if (!campaign.applier.install(campaign, vehicle, now)) continue;
      const outcome = outcomeOf(vehicle.vin, campaign.toVersion);
      vehicle.faulted = outcome === 'fault';
      campaign.results.set(vehicle.vin, { outcome, at: now, stageIndex: campaign.stageIndex });
    }
    evaluateGate(campaign, fleet, now);
  } else if (campaign.status === 'rolling_back') {
    for (const vehicle of rollbackRemaining(campaign, fleet)) {
      if (!canTouch(vehicle, now)) continue;
      if (campaign.applier.revert(campaign, vehicle, now)) vehicle.faulted = false;
    }
    if (rollbackRemaining(campaign, fleet).length === 0) {
      campaign.status = 'rolled_back';
      campaign.log.push({ at: now, text: `Rollback complete. No vehicle is left on ${campaign.toVersion}` });
    }
  }
}

function assertAuthority(campaign, by) {
  if (by !== campaign.owner && !campaign.delegates.includes(by)) {
    throw new Error(`${by} is not authorized to control this campaign`);
  }
}

export function halt(campaign, { by, at }) {
  assertAuthority(campaign, by);
  if (campaign.status !== 'running') throw new Error('Only a running campaign can be halted');
  campaign.status = 'halted';
  campaign.haltedBy = by;
  campaign.log.push({ at, text: `Halted by ${by}` });
}

export function resume(campaign, { by, at }) {
  assertAuthority(campaign, by);
  if (campaign.status !== 'halted') throw new Error('Only a halted campaign can be resumed');
  if (campaign.haltedBy === 'gate') throw new Error('A gate halt needs a new build, not a resume');
  campaign.status = 'running';
  campaign.haltedBy = null;
  campaign.soakStartedAt = null;
  campaign.log.push({ at, text: `Resumed by ${by}` });
}

export function startRollback(campaign, { by, at }) {
  assertAuthority(campaign, by);
  if (campaign.status !== 'halted') throw new Error('Halt the campaign before rolling back');
  campaign.status = 'rolling_back';
  campaign.log.push({ at, text: `Rollback started by ${by}` });
}

export function versionInventory(fleet) {
  const counts = {};
  for (const vehicle of fleet) counts[vehicle.version] = (counts[vehicle.version] ?? 0) + 1;
  return counts;
}

export function createOtaFleet(count, version) {
  return Array.from({ length: count }, (_, i) => ({
    vin: `V-${String(i + 1).padStart(3, '0')}`,
    version,
    faulted: false,
    online: true,
  }));
}

// Parked with no signal on about 15% of vehicle-nights, and a different set each night.
export function applyConnectivity(fleet, now, offlineShare = 0.15) {
  const day = Math.floor(now / DAY);
  for (const vehicle of fleet) vehicle.online = hash01(`${vehicle.vin}:${day}`) >= offlineShare;
}

export const faultModel = (faultRate) => (vin, version) =>
  hash01(`${vin}:${version}`) < faultRate ? 'fault' : 'ok';
