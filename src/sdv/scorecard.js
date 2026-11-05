// The five "becomes software-defined" criteria, computed from state rather than asserted.
import { HARDWARE } from './hardware.js';
import { CATALOG } from './catalog.js';
import { BATTERY_SUPPLIERS } from './hal.js';
import { reconcile, setDesired } from './twin.js';
import { resolveCapabilities, roadmapFits } from './resolver.js';

function withEntitlements(twin, entitled) {
  const copy = structuredClone(twin);
  copy.reported.entitled = entitled;
  return resolveCapabilities(copy).active;
}

function cloudGoneTest(twin, now) {
  const copy = structuredClone(twin);
  const before = resolveCapabilities(copy).active;
  copy.online = false;
  setDesired(copy, { entitled: [], installed: [] });
  const result = reconcile(copy, now);
  const after = resolveCapabilities(copy).active;
  return { keepsRunning: before.join() === after.join(), frozen: result.applied === false, activeCount: after.length };
}

export function assess(twin, now) {
  const hardware = HARDWARE[twin.hardwareRev];
  const installed = twin.reported.installed;
  const adapters = Object.keys(BATTERY_SUPPLIERS).length;
  const bound = CATALOG.every((f) => !('supplier' in f));

  const all = withEntitlements(twin, CATALOG.map((f) => f.id)).length;
  const none = withEntitlements(twin, []).length;
  const fits = roadmapFits(hardware);
  const cloud = cloudGoneTest(twin, now);

  return [
    {
      id: 'abstraction',
      label: 'Abstraction layer',
      passed: bound && adapters >= 2,
      evidence: `No feature names a supplier, and ${adapters} battery suppliers meet one contract.`,
    },
    {
      id: 'headroom',
      label: 'Over-provisioned for the roadmap',
      passed: fits,
      evidence: fits ? 'The roadmap feature fits alongside everything else.' : 'The roadmap feature can’t fit on this hardware.',
    },
    {
      id: 'installed-base',
      label: 'Changed after delivery',
      passed: twin.reported.generation > 0,
      evidence: twin.reported.generation > 0
        ? `This vehicle is on generation ${twin.reported.generation}.`
        : 'This vehicle is still on its factory state.',
    },
    {
      id: 'runtime-entitlement',
      label: 'Entitled at runtime',
      passed: installed.length > 0 && all !== none,
      evidence: all !== none
        ? `The same hardware runs ${none} or ${all} features depending on entitlement.`
        : 'Nothing is installed, so entitlement changes nothing yet.',
    },
    {
      id: 'cloud-freezes',
      label: 'Losing the cloud freezes it, not stops it',
      // With nothing running, there is nothing to prove.
      passed: cloud.activeCount > 0 && cloud.keepsRunning && cloud.frozen,
      evidence: cloud.activeCount > 0
        ? `With no cloud, ${cloud.activeCount} active feature${cloud.activeCount === 1 ? ' keeps' : 's keep'} running and no change can land.`
        : 'Nothing is running yet, so this can’t be shown.',
    },
  ];
}
