// Firmware per part, and how one vehicle moves between versions. A release set pins a tested version
// for every part. Small patches can change one part if the result is still a tested combination.
// Versions, sizes, and times are assumptions. Signatures and flashing are modeled, not real.
import { powerCutOutcome } from '../core/flash.js';
import { isOnShift, SHIFT } from '../core/ota.js';
import { authorize } from '../core/roles.js';
import { DAY, HOUR } from '../core/time.js';
import { HARDWARE } from '../sdv/hardware.js';

export const TIERS = {
  system: { label: 'System firmware', summary: 'The vehicle’s main software. It runs on larger computers with room for two copies.' },
  domain: { label: 'Subsystem firmware', summary: 'One job each, on a microcontroller inside the module. Often written by the supplier.' },
  component: { label: 'Component firmware', summary: 'Small programs inside smart sensors. Rarely changed, and the hardest to recover.' },
};

// In install order. Two-slot parts go first because they're safe to stage.
export const TARGETS = [
  { id: 'gateway', label: 'Telematics gateway', tier: 'system', slots: 2, recovery: true, sizeMb: 180, minutes: 6, lives: 'Gateway processor, on flash storage', path: 'Direct from the cloud' },
  { id: 'vcu', label: 'Vehicle computer', tier: 'system', slots: 2, recovery: true, sizeMb: 320, minutes: 9, lives: 'Main processor, on flash storage', path: 'Gateway, then vehicle network' },
  { id: 'inverter', label: 'Motor controller', tier: 'domain', slots: 2, recovery: true, sizeMb: 4, minutes: 5, lives: 'Controller’s microcontroller', path: 'Vehicle computer, then CAN' },
  { id: 'position', label: 'Position sensor', tier: 'component', slots: 1, recovery: true, sizeMb: 1, minutes: 3, lives: 'Module inside the gateway', path: 'Gateway, then an internal link', capability: 'position' },
  { id: 'motion', label: 'Motion sensor', tier: 'component', slots: 1, recovery: false, sizeMb: 0.2, minutes: 2, lives: 'Chip on the computer’s board', path: 'Vehicle computer, then an internal link', capability: 'motion' },
  { id: 'cargo', label: 'Cargo load sensor', tier: 'component', slots: 1, recovery: true, sizeMb: 0.5, minutes: 3, lives: 'Sensor’s own microcontroller', path: 'Vehicle computer, then CAN', capability: 'cargo-load' },
  { id: 'proximity', label: 'Proximity sensor', tier: 'component', slots: 1, recovery: false, sizeMb: 0.5, minutes: 3, lives: 'Sensor’s own microcontroller', path: 'Vehicle computer, then CAN', capability: 'proximity' },
  { id: 'charger', label: 'On-board charger', tier: 'domain', slots: 1, recovery: true, sizeMb: 2, minutes: 6, lives: 'Charger’s microcontroller', path: 'Vehicle computer, then CAN' },
  { id: 'bms', label: 'Battery management', tier: 'domain', slots: 1, recovery: true, sizeMb: 3, minutes: 8, lives: 'BMS microcontroller', path: 'Vehicle computer, then CAN' },
];

export const NOT_UPDATABLE = [
  { id: 'brakes', label: 'Brakes', note: 'Fixed at manufacture. Safety-critical, so it never takes an over-the-air update.' },
  { id: 'pack', label: 'Battery pack', note: 'No firmware of its own. Battery management holds the software.' },
  { id: 'motor', label: 'Drive motor', note: 'No firmware of its own. The motor controller holds the software.' },
  { id: 'tires', label: 'Tires', note: 'No firmware.' },
];

const BASE = { gateway: '2.3.0', vcu: '1.4.2', inverter: '4.0.2', position: '1.2.0', motion: '1.1.0', cargo: '1.0.4', proximity: '1.0.1', charger: '1.8.0', bms: { alpha: '3.1.0', bravo: '5.2.1' } };
const NEXT = { ...BASE, gateway: '2.4.0', vcu: '1.5.0', inverter: '4.1.0', charger: '1.8.2', cargo: '1.1.0', bms: { alpha: '3.2.0', bravo: '5.3.0' } };

export const RELEASES = {
  '1.4.2': { label: 'Release 1.4.2', parts: BASE },
  '1.5.0': { label: 'Release 1.5.0', parts: NEXT, latest: true },
  '1.5.1': { label: 'Release 1.5.1', parts: { ...NEXT, vcu: '1.5.1' }, withdrawn: true },
};

export const PATCHES = [
  { id: 'patch-proximity', label: 'Proximity sensor 1.0.2', part: 'proximity', version: '1.0.2', note: 'Fewer false blocked readings' },
  { id: 'patch-bms', label: 'Battery management patch', part: 'bms', version: { alpha: '3.1.1', bravo: '5.2.2' }, note: 'Better cell sensor filtering' },
  { id: 'patch-inverter', label: 'Motor controller 4.1.0', part: 'inverter', version: '4.1.0', note: 'New torque message' },
];

// A tested pair. Each side needs the other from these versions on, so they must switch together.
const REQUIRES = [
  { part: 'vcu', from: '1.5.0', needs: 'inverter', min: '4.1.0' },
  { part: 'inverter', from: '4.1.0', needs: 'vcu', min: '1.5.0' },
];

const FACTORY_RELEASE = '1.4.2';
const targetById = (id) => TARGETS.find((target) => target.id === id);
const fitted = (vehicle, target) => !target.capability || HARDWARE[vehicle.hardwareRev].capabilities.includes(target.capability);
const pickVersion = (value, vehicle) => (typeof value === 'string' ? value : value[vehicle.supplier]);
const releaseVersion = (releaseId, part, vehicle) => pickVersion(RELEASES[releaseId].parts[part], vehicle);

function compareVersions(a, b) {
  const [x, y] = [a, b].map((version) => version.split('.').map(Number));
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

export const fittedTargets = (vehicle) => TARGETS.filter((target) => fitted(vehicle, target));

export function createFirmware(vehicle, releaseId) {
  return Object.fromEntries(fittedTargets(vehicle).map((target) => {
    const version = releaseVersion(releaseId, target.id, vehicle);
    return [target.id, { version, spare: target.slots === 2 ? version : null, slot: target.slots === 2 ? 'A' : null, state: 'ok' }];
  }));
}

// What a fleet campaign does when it reaches a vehicle.
export function applyRelease(vehicle, releaseId, now = 0) {
  for (const target of fittedTargets(vehicle)) {
    const record = vehicle.firmware[target.id];
    const version = releaseVersion(releaseId, target.id, vehicle);
    if (record.version === version) continue;
    if (target.slots === 2) Object.assign(record, { spare: record.version, slot: record.slot === 'A' ? 'B' : 'A' });
    Object.assign(record, { version, state: 'ok' });
  }
  vehicle.version = releaseId;
  vehicle.firmwareHistory.push({ at: now, label: releaseId });
}

const matchesRelease = (vehicle) => fittedTargets(vehicle)
  .every((target) => vehicle.firmware[target.id].version === releaseVersion(vehicle.version, target.id, vehicle));

// What the vehicle was running at a moment in the past, for the event log.
export const firmwareAt = (vehicle, t) => vehicle.firmwareHistory.filter((entry) => entry.at <= t).at(-1)?.label ?? FACTORY_RELEASE;

export const releaseLabel = (vehicle) => (matchesRelease(vehicle) ? vehicle.version : `${vehicle.version} (mixed)`);

// Returns plain-language problems with a set of versions. Empty means it's a tested combination.
export function compatibilityIssues(versions) {
  return REQUIRES.filter((rule) => compareVersions(versions[rule.part], rule.from) >= 0 && compareVersions(versions[rule.needs], rule.min) < 0)
    .map((rule) => `${targetById(rule.part).label} ${versions[rule.part]} needs ${targetById(rule.needs).label} ${rule.min} or later`);
}

const currentVersions = (vehicle) => Object.fromEntries(fittedTargets(vehicle).map((target) => [target.id, vehicle.firmware[target.id].version]));

function wantedVersions(vehicle, targetId) {
  const current = currentVersions(vehicle);
  if (RELEASES[targetId]) return Object.fromEntries(fittedTargets(vehicle).map((target) => [target.id, releaseVersion(targetId, target.id, vehicle)]));
  const patch = PATCHES.find((item) => item.id === targetId);
  if (!patch) throw new Error(`Unknown update ${targetId}`);
  return patch.part in current ? { ...current, [patch.part]: pickVersion(patch.version, vehicle) } : current;
}

const running = (job) => job?.status === 'running';
const campaignActive = (world) => world.campaign !== null && !['complete', 'rolled_back'].includes(world.campaign.status);
export const anyUpdateRunning = (world) => Object.values(world.updates).some(running);

export const hoursToOffShift = (now) => (isOnShift(now) ? Math.ceil((SHIFT.endHour * HOUR - (now % DAY)) / HOUR) : 0);

const buildSteps = (changes) => {
  const stage = changes.filter((change) => change.slots === 2);
  const flash = changes.filter((change) => change.slots === 1);
  return [
    { kind: 'download', label: 'Download to the gateway' },
    { kind: 'verify', label: 'Verify signatures and conditions' },
    ...stage.map((change) => ({ kind: 'stage', part: change.part, label: `Write ${change.label} to its spare slot` })),
    ...flash.map((change) => ({ kind: 'flash', part: change.part, label: `Flash ${change.label}` })),
    ...(stage.length ? [{ kind: 'activate', label: 'Switch to the new slots together' }, { kind: 'health', label: 'Health check' }] : []),
    { kind: 'report', label: 'Report what’s running' },
  ];
};

export function planUpdate(world, vin, targetId) {
  const vehicle = world.fleet.find((v) => v.vin === vin);
  const wanted = wantedVersions(vehicle, targetId);
  const changes = fittedTargets(vehicle).filter((target) => wanted[target.id] !== vehicle.firmware[target.id].version).map((target) => ({
    part: target.id, label: target.label, tier: target.tier, slots: target.slots, recovery: target.recovery,
    from: vehicle.firmware[target.id].version, to: wanted[target.id], sizeMb: target.sizeMb, minutes: target.minutes,
  }));
  const blocked = [
    ...compatibilityIssues(wanted),
    ...(changes.length ? [] : ['Already on these versions']),
    ...(vehicle.online ? [] : ['No signal, so the vehicle can’t receive it']),
    ...(isOnShift(world.now) ? ['On shift. Installs wait until the vehicle is parked'] : []),
    ...(campaignActive(world) ? ['A fleet rollout is running'] : []),
    ...(fittedTargets(vehicle).filter((target) => vehicle.firmware[target.id].state === 'bricked').map((target) => `${target.label} needs a repair first`)),
  ];
  const single = changes.filter((change) => change.slots === 1);
  const problems = changes.length ? [
    { id: 'signal', label: 'Signal drops during the download' },
    ...changes.map((change) => ({ id: `cut:${change.part}`, label: `Power cut while writing ${change.label}` })),
    ...changes.map((change) => ({ id: `health:${change.part}`, label: `${change.label} fails its health check` })),
  ] : [];
  return {
    targetId, changes, blocked, problems, steps: buildSteps(changes),
    downloadMb: Math.round(changes.reduce((sum, change) => sum + change.sizeMb, 0) * 10) / 10,
    minutes: changes.reduce((sum, change) => sum + change.minutes, 0),
    noReturn: single.map((change) => change.label),
  };
}

function record(world, job, text) {
  job.log.push({ at: world.now, text });
  world.firmwareLog.push({ vin: job.vin, at: world.now, text });
}

export function startUpdate(world, vin, targetId, problem = null) {
  authorize(world, 'firmware.update');
  if (running(world.updates[vin])) throw new Error(`${vin} is already updating`);
  const plan = planUpdate(world, vin, targetId);
  if (plan.blocked.length) throw new Error(plan.blocked[0]);
  const label = RELEASES[targetId]?.label ?? PATCHES.find((patch) => patch.id === targetId).label;
  const job = { vin, targetId, label, status: 'running', index: 0, steps: plan.steps, changes: plan.changes, problem, log: [], result: null };
  world.updates[vin] = job;
  record(world, job, `Update started: ${label}`);
  world.onChange?.();
  return job;
}

function finish(world, job, status, result) {
  Object.assign(job, { status, result });
  const vehicle = world.fleet.find((v) => v.vin === job.vin);
  vehicle.firmwareHistory.push({ at: world.now, label: releaseLabel(vehicle) });
  record(world, job, result);
}

const useProblem = (job, id) => {
  if (job.problem !== id) return false;
  job.problem = null;
  return true;
};

function writeOnePart(world, job, vehicle, change, target) {
  const entry = vehicle.firmware[change.part];
  if (useProblem(job, `cut:${change.part}`)) {
    const outcome = powerCutOutcome({ slots: 1, stage: 'writing', recoveryPath: target.recovery });
    record(world, job, `Power cut while flashing ${change.label}. ${outcome.detail}`);
    if (!target.recovery) {
      entry.state = 'bricked';
      finish(world, job, 'needs-service', `${change.label} won’t start. A technician has to replace or reflash it.`);
      return false;
    }
    entry.state = 'recovery';
    return false;
  }
  if (useProblem(job, `health:${change.part}`)) {
    if (!target.recovery) {
      entry.state = 'bricked';
      finish(world, job, 'needs-service', `${change.label} failed its check, and there’s no old copy or recovery path. A technician has to replace or reflash it.`);
    } else {
      entry.state = 'ok';
      finish(world, job, 'stopped', `${change.label} failed its check, so the gateway reflashed ${change.from} from its cached copy. Update stopped.`);
    }
    return false;
  }
  Object.assign(entry, { version: change.to, state: 'ok' });
  record(world, job, `${change.label} flashed to ${change.to} and passed its check`);
  return true;
}

function revertSlots(world, job, vehicle, stage, reason) {
  for (const change of stage) {
    const entry = vehicle.firmware[change.part];
    Object.assign(entry, { version: change.from, spare: change.to, slot: entry.slot === 'A' ? 'B' : 'A' });
  }
  const flashed = job.changes.filter((change) => change.slots === 1).map((change) => change.label);
  const left = flashed.length ? ` ${flashed.join(', ')} stayed on the new version, which is tested with the old set.` : '';
  finish(world, job, 'reverted', `${reason} The bootloaders went back to the old slots.${left}`);
}

// Runs one step. A problem happens once, so a retry gets through.
export function stepUpdate(world, vin) {
  authorize(world, 'firmware.update');
  const job = world.updates[vin];
  if (!running(job)) throw new Error(`${vin} has no update running`);
  const vehicle = world.fleet.find((v) => v.vin === vin);
  const step = job.steps[job.index];
  const change = job.changes.find((item) => item.part === step.part);
  const stage = job.changes.filter((item) => item.slots === 2);
  let advance = true;

  if (step.kind === 'download') {
    if (useProblem(job, 'signal')) {
      record(world, job, 'Signal dropped. Nothing was installed, and the download will resume where it stopped.');
      advance = false;
    } else record(world, job, 'Download complete');
  } else if (step.kind === 'verify') {
    record(world, job, 'Signatures checked. Vehicle is parked and off shift');
  } else if (step.kind === 'stage') {
    if (useProblem(job, `cut:${change.part}`)) {
      record(world, job, `Power cut while writing ${change.label}. ${powerCutOutcome({ slots: 2, stage: 'writing' }).detail}`);
      advance = false;
    } else {
      vehicle.firmware[change.part].spare = change.to;
      record(world, job, `${change.label} ${change.to} written to the spare slot. The running copy wasn’t touched`);
    }
  } else if (step.kind === 'flash') {
    advance = writeOnePart(world, job, vehicle, change, targetById(change.part));
  } else if (step.kind === 'activate') {
    for (const item of stage) {
      const entry = vehicle.firmware[item.part];
      Object.assign(entry, { version: item.to, spare: item.from, slot: entry.slot === 'A' ? 'B' : 'A' });
    }
    record(world, job, `Switched ${stage.map((item) => item.label).join(', ')} together`);
  } else if (step.kind === 'health') {
    const failed = stage.find((item) => useProblem(job, `health:${item.part}`));
    if (failed) {
      revertSlots(world, job, vehicle, stage, `${failed.label} failed its health check.`);
      advance = false;
    } else record(world, job, 'New firmware passed its health check and marked itself good');
  } else if (step.kind === 'report') {
    if (RELEASES[job.targetId]) vehicle.version = job.targetId;
    finish(world, job, 'done', `${job.label} installed. Running ${releaseLabel(vehicle)}`);
    advance = false;
  }
  if (advance) job.index += 1;
  world.onChange?.();
  return job;
}

export function runUpdate(world, vin) {
  while (running(world.updates[vin])) stepUpdate(world, vin);
  return world.updates[vin];
}

// A repair replaces or reflashes a part that wouldn't start.
export function restoreFirmware(world, vin, partId) {
  const vehicle = world.fleet.find((v) => v.vin === vin);
  const entry = vehicle?.firmware?.[partId];
  if (entry?.state !== 'bricked') return;
  entry.state = 'ok';
  world.firmwareLog.push({ vin, at: world.now, text: `${targetById(partId).label} restored on ${entry.version} by a technician` });
}

// What the whole fleet runs, by release set and by part.
export function fleetFirmware(world) {
  const latest = Object.keys(RELEASES).find((id) => RELEASES[id].latest);
  const count = (values) => [...values.reduce((map, value) => map.set(value, (map.get(value) ?? 0) + 1), new Map())]
    .map(([version, vehicles]) => ({ version, vehicles })).sort((a, b) => b.vehicles - a.vehicles);
  const behind = world.fleet.filter((vehicle) => releaseLabel(vehicle) !== latest);
  return {
    latest,
    releases: count(world.fleet.map(releaseLabel)),
    behind: behind.length,
    firstBehind: behind.find((vehicle) => vehicle.online)?.vin ?? behind[0]?.vin ?? world.fleet[0].vin,
    parts: TARGETS.map((target) => {
      const vehicles = world.fleet.filter((vehicle) => fitted(vehicle, target));
      return {
        id: target.id, label: target.label, level: TIERS[target.tier].label, slots: target.slots, recovery: target.recovery,
        versions: count(vehicles.map((vehicle) => vehicle.firmware[target.id].version)),
        behind: vehicles.filter((vehicle) => vehicle.firmware[target.id].version !== releaseVersion(latest, target.id, vehicle)).length,
        wontStart: vehicles.filter((vehicle) => vehicle.firmware[target.id].state === 'bricked').length,
      };
    }),
  };
}

export function firmwareView(world, vin) {
  const vehicle = world.fleet.find((v) => v.vin === vin);
  const options = [
    ...Object.entries(RELEASES).filter(([, release]) => !release.withdrawn).map(([id, release]) => ({ id, label: release.label, kind: 'Release set', note: release.latest ? 'Latest tested set' : 'Earlier tested set' })),
    ...PATCHES.filter((patch) => patch.part in vehicle.firmware).map((patch) => ({ id: patch.id, label: patch.label, kind: 'Single part', note: patch.note })),
  ].map((option) => ({ ...option, plan: planUpdate(world, vin, option.id) }));
  return {
    vin, release: vehicle.version, label: releaseLabel(vehicle), matches: matchesRelease(vehicle),
    rows: fittedTargets(vehicle).map((target) => ({ ...target, ...vehicle.firmware[target.id], inRelease: releaseVersion(vehicle.version, target.id, vehicle) })),
    issues: compatibilityIssues(currentVersions(vehicle)),
    options, job: world.updates[vin] ?? null,
    log: world.firmwareLog.filter((entry) => entry.vin === vin).reverse(),
  };
}
