// AD-2. Runs on reported state, because what matters is what the vehicle really has.
import { HARDWARE, PLATFORM_RESERVED } from './hardware.js';
import { CATALOG, ROADMAP_FEATURE } from './catalog.js';

export const REASONS = {
  active: 'Active',
  'hardware-missing': 'Hardware can’t host it',
  'not-installed': 'Not installed',
  'not-entitled': 'Not entitled',
  'over-budget': 'Over compute budget',
};

export function appBudget(hardware) {
  return {
    cpu: hardware.capacity.cpu - PLATFORM_RESERVED.cpu,
    memoryMb: hardware.capacity.memoryMb - PLATFORM_RESERVED.memoryMb,
  };
}

export function resolveCapabilities(twin, catalog = CATALOG) {
  const hardware = HARDWARE[twin.hardwareRev];
  const budget = appBudget(hardware);
  const used = { cpu: 0, memoryMb: 0 };

  const features = catalog.map((feature) => {
    const missing = feature.requires.filter((c) => !hardware.capabilities.includes(c));
    let state = 'active';
    if (missing.length) state = 'hardware-missing';
    else if (!twin.reported.installed.includes(feature.id)) state = 'not-installed';
    else if (!twin.reported.entitled.includes(feature.id)) state = 'not-entitled';
    else if (used.cpu + feature.cpu > budget.cpu || used.memoryMb + feature.memoryMb > budget.memoryMb) state = 'over-budget';

    if (state === 'active') {
      used.cpu += feature.cpu;
      used.memoryMb += feature.memoryMb;
    }
    return { ...feature, state, missing };
  });

  return { features, used, budget, active: features.filter((f) => f.state === 'active').map((f) => f.id) };
}

// Can this vehicle take this feature on top of everything it's already been sent?
export function canHost(twin, feature, catalog = CATALOG) {
  const hardware = HARDWARE[twin.hardwareRev];
  if (twin.desired.installed.includes(feature.id)) return { ok: false, reason: 'already-installed' };
  if (!feature.requires.every((c) => hardware.capabilities.includes(c))) return { ok: false, reason: 'hardware-missing' };

  const budget = appBudget(hardware);
  const present = catalog.filter((f) => twin.desired.installed.includes(f.id));
  const total = (key) => present.reduce((sum, f) => sum + f[key], feature[key]);
  if (total('cpu') > budget.cpu || total('memoryMb') > budget.memoryMb) return { ok: false, reason: 'over-budget' };
  return { ok: true, reason: 'eligible' };
}

// AD-3. The bet pays off only if the roadmap feature fits alongside everything shipping today.
export function roadmapFits(hardware, catalog = CATALOG) {
  const budget = appBudget(hardware);
  const hostable = catalog.filter((f) => f.requires.every((c) => hardware.capabilities.includes(c)));
  if (!hostable.includes(ROADMAP_FEATURE)) return false;
  const total = (key) => hostable.reduce((sum, f) => sum + f[key], 0);
  return total('cpu') <= budget.cpu && total('memoryMb') <= budget.memoryMb;
}
