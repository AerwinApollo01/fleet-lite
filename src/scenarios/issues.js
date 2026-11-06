// From a finding to a measured fix. A finding opens an issue, money compares the options, and the
// chosen fix changes real failure rates. Only measurement says whether it worked, and a forecast
// isn't a result. All figures are assumptions.
import { HOUR, DAY } from '../core/time.js';
import { authorize } from '../core/roles.js';
import { SHIFT } from '../core/ota.js';
import { componentReliability, failuresOf, hasPart } from './components.js';
import { applyPatch, PATCHES, revertPatch } from './firmware.js';
import { startFixRollout } from './fleet.js';
import { DAILY_KM } from './maintenance.js';

export const COSTS = { truckRollUsd: 180, repairLaborUsd: 140, downtimeUsd: 320, otaEngineeringUsd: 25000, otaPerVehicleUsd: 0.5, claimAdminUsd: 3000, claimShare: 0.6, workDaysPerYear: 260 };

// The forecast is what the team believes. The true effect is only found by measuring.
const PLANS = {
  bms: { patch: 'patch-bms', partUsd: 260, fitUsd: 90, forecastKeep: 0.5, otaKeep: 0.6, replaceKeep: 0.33 },
  vcu: { patch: 'patch-vcu', partUsd: 420, fitUsd: 120, forecastKeep: 0.5, otaKeep: 0.55, replaceKeep: 0.4 },
};
const SHOP_PER_DAY = 40;
const MIN_EXPECTED = 8;
const MIN_Z = 2;
const WEEKS = 12;

const groupMatches = (key, vehicle) => (key.startsWith('s:') ? vehicle.supplier === key.slice(2) : vehicle.hardwareRev === key.slice(2));
const groupOf = (world, issue) => world.fleet.filter((vehicle) => groupMatches(issue.groupKey, vehicle) && hasPart(vehicle, issue.partId));
const failureUsd = (issue) => COSTS.truckRollUsd + COSTS.repairLaborUsd + COSTS.downtimeUsd + (PLANS[issue.partId]?.partUsd ?? 0);

function note(world, issue, text) {
  issue.log.push(Object.freeze({ at: world.now, text }));
}

function setStatus(world, issue, status, text) {
  issue.status = status;
  note(world, issue, text);
  world.onChange?.();
}

export function findings(world) {
  return componentReliability(world).filter((part) => part.finding).map((part) => ({
    partId: part.id, partLabel: part.label, groupKey: part.finding.key, groupLabel: part.finding.label, kind: part.finding.kind, timesRest: part.finding.timesRest,
    issue: world.issues.find((issue) => issue.partId === part.id && issue.groupKey === part.finding.key && issue.status !== 'closed') ?? null,
    closed: world.issues.findLast((issue) => issue.partId === part.id && issue.groupKey === part.finding.key && issue.status === 'closed') ?? null,
  }));
}

export function openIssue(world, partId, groupKey) {
  authorize(world, 'issue.manage');
  const found = findings(world).find((item) => item.partId === partId && item.groupKey === groupKey);
  if (!found) throw new Error('An issue needs a finding the data supports');
  if (found.issue) throw new Error(`That’s already issue #${found.issue.id}`);
  if (found.closed) throw new Error(`Issue #${found.closed.id} already dealt with this. The lifetime rate still includes old failures`);
  const part = componentReliability(world).find((item) => item.id === partId);
  const group = part.breakdown.find((item) => item.key === groupKey);
  const rest = { failures: part.failures - group.failures, km: part.km - group.km };
  const issue = {
    id: world.issues.length + 1, partId, partLabel: found.partLabel, groupKey, groupLabel: found.groupLabel, kind: found.kind,
    status: 'open', openedAt: world.now, fix: null, spentUsd: 0, recoveredUsd: 0, claimed: false, queue: [], log: [],
    baseline: Object.freeze({ failures: group.failures, km: group.km, ratePerKm: group.failures / group.km, restRatePerKm: rest.failures / rest.km, timesRest: found.timesRest }),
  };
  world.issues.push(issue);
  note(world, issue, `Opened from a finding: ${found.groupLabel} fails ${found.timesRest}× as often as the rest`);
  world.onChange?.();
  return issue;
}

// What each choice is expected to cost and return. These are estimates until measured.
export function fixOptions(world, issue) {
  const vehicles = groupOf(world, issue).length;
  const { baseline } = issue;
  const failuresPerYear = baseline.ratePerKm * vehicles * DAILY_KM * COSTS.workDaysPerYear;
  const each = failureUsd(issue);
  const plan = PLANS[issue.partId];
  const option = (id, label, detail, upfrontUsd, keep, effect) => {
    const avoided = failuresPerYear * (1 - keep);
    const savingUsd = avoided * each;
    return { id, label, detail, effect, upfrontUsd: Math.round(upfrontUsd), avoidedPerYear: Math.round(avoided), savingPerYearUsd: Math.round(savingUsd), paybackMonths: savingUsd > 0 ? Math.round((upfrontUsd / savingUsd) * 120) / 10 : null, threeYearNetUsd: Math.round(savingUsd * 3 - upfrontUsd) };
  };
  const excessUsd = Math.max(0, (baseline.ratePerKm - baseline.restRatePerKm) * baseline.km) * each;
  const list = [];
  if (plan) {
    list.push(option('ota', `Patch over the air (${vehicles.toLocaleString('en-US')} vehicles)`, 'Staged rollout with gates. Cheap per vehicle, and it can’t change the hardware.', COSTS.otaEngineeringUsd + vehicles * COSTS.otaPerVehicleUsd, plan.forecastKeep, 'Forecast'));
    list.push(option('replace', `Replace the part (${vehicles.toLocaleString('en-US')} vehicles)`, `Shop work, about ${SHOP_PER_DAY} vehicles a day. The most thorough fix, and the slowest.`, vehicles * (plan.partUsd + plan.fitUsd), plan.replaceKeep, 'Forecast'));
  }
  if (issue.kind === 'Battery supplier' && !issue.claimed) {
    list.push({ ...option('claim', 'Claim from the supplier', 'Recovers past cost, and does nothing about future failures. It can sit alongside a fix.', COSTS.claimAdminUsd, 1, 'Money only'), recoverUsd: Math.round(excessUsd * COSTS.claimShare) });
  }
  list.push(option('monitor', 'Accept and keep monitoring', 'Spends nothing, and the failures continue.', 0, 1, 'No change'));
  return { failuresPerYear: Math.round(failuresPerYear), failureUsd: each, options: list };
}

const patchApplier = (issue, patchId, keep, label) => ({
  install(campaign, vehicle, now) {
    applyPatch(vehicle, patchId);
    vehicle.fixes.push({ issueId: issue.id, part: issue.partId, at: now, keep, label });
    return true;
  },
  revert(campaign, vehicle, now) {
    revertPatch(vehicle, patchId);
    for (const fix of vehicle.fixes.filter((item) => item.issueId === issue.id && item.until === undefined)) fix.until = now;
    return true;
  },
  needsRevert: (campaign, vehicle) => vehicle.fixes.some((fix) => fix.issueId === issue.id && fix.until === undefined),
});

export function chooseFix(world, issueId, fixId) {
  authorize(world, 'issue.manage');
  const issue = world.issues.find((item) => item.id === issueId);
  if (!issue || issue.status !== 'open') throw new Error('Only an open issue can take a fix');
  const estimate = fixOptions(world, issue);
  const option = estimate.options.find((item) => item.id === fixId);
  if (!option) throw new Error(`That option isn’t available for issue #${issue.id}`);
  const plan = PLANS[issue.partId];
  const vehicles = groupOf(world, issue);

  if (fixId === 'claim') {
    Object.assign(issue, { claimed: true, spentUsd: issue.spentUsd + option.upfrontUsd, recoveredUsd: option.recoverUsd });
    note(world, issue, `Claim filed with ${issue.groupLabel}. Expected recovery $${option.recoverUsd.toLocaleString('en-US')}. Failures are unchanged`);
  } else if (fixId === 'monitor') {
    issue.fix = { id: 'monitor', label: option.label };
    setStatus(world, issue, 'monitoring', 'Decision: accept the failures and keep monitoring');
  } else if (fixId === 'ota') {
    const patch = PATCHES.find((item) => item.id === plan.patch);
    const label = `${patch.label} for issue #${issue.id}`;
    startFixRollout(world, { id: `fix-${issue.id}`, label, build: patch.label, vins: vehicles.map((v) => v.vin), applier: patchApplier(issue, plan.patch, plan.otaKeep, patch.label) });
    issue.fix = { id: 'ota', label: option.label, startedAt: world.now, forecastKeep: plan.forecastKeep, campaignId: world.campaign.id };
    issue.spentUsd += option.upfrontUsd;
    setStatus(world, issue, 'fixing', `Fix chosen: ${option.label}. Rollout started`);
  } else {
    issue.fix = { id: 'replace', label: option.label, startedAt: world.now, forecastKeep: plan.replaceKeep };
    issue.queue = vehicles.map((v) => v.vin);
    setStatus(world, issue, 'fixing', `Fix chosen: ${option.label}. ${vehicles.length.toLocaleString('en-US')} vehicles queued for the shop`);
  }
  world.onChange?.();
  return issue;
}

// Runs each simulated hour: the shop works through its queue, and rollouts report back.
export function stepIssues(world) {
  for (const issue of world.issues) {
    if (issue.status !== 'fixing') continue;
    if (issue.fix.id === 'replace') {
      if ((world.now % DAY) / HOUR !== SHIFT.endHour) continue;
      const plan = PLANS[issue.partId];
      for (const vin of issue.queue.splice(0, SHOP_PER_DAY)) {
        world.fleet.find((v) => v.vin === vin).fixes.push({ issueId: issue.id, part: issue.partId, at: world.now, keep: plan.replaceKeep, label: 'Part replaced' });
        issue.spentUsd += plan.partUsd + plan.fitUsd;
      }
      if (issue.queue.length === 0) setStatus(world, issue, 'measuring', 'All vehicles fixed. Measuring the result');
    } else if (world.campaign?.id === issue.fix.campaignId) {
      if (world.campaign.status === 'complete') setStatus(world, issue, 'measuring', 'Rollout complete. Measuring the result');
      if (world.campaign.status === 'rolled_back') {
        issue.fix = null;
        setStatus(world, issue, 'open', 'The rollout was rolled back. The issue is open again');
      }
    }
  }
}

// Compares fixed vehicles with what their old rate predicts for the same distance.
export function measureIssue(world, issue) {
  const fixed = groupOf(world, issue).flatMap((vehicle) => {
    const fix = vehicle.fixes.find((item) => item.issueId === issue.id && item.until === undefined);
    return fix ? [{ vehicle, fix }] : [];
  });
  let km = 0;
  let actual = 0;
  for (const { vehicle, fix } of fixed) {
    km += Math.max(0, (world.now - fix.at) / DAY) * DAILY_KM;
    actual += failuresOf(world, vehicle, issue.partId).filter((event) => event.at > fix.at).length;
  }
  const expected = km * issue.baseline.ratePerKm;
  const changePct = expected > 0 ? Math.round(((actual - expected) / expected) * 100) : null;
  const z = expected > 0 ? (expected - actual) / Math.sqrt(expected) : 0;
  const verdict = expected < MIN_EXPECTED ? 'early' : z >= MIN_Z ? 'working' : 'not-proven';
  const avoided = Math.max(0, expected - actual);
  return {
    vehicles: fixed.length, group: groupOf(world, issue).length, km: Math.round(km), actual, expected: Math.round(expected * 10) / 10, changePct, verdict,
    forecastPct: issue.fix?.forecastKeep === undefined ? null : Math.round((issue.fix.forecastKeep - 1) * 100),
    avoided: Math.round(avoided * 10) / 10, avoidedUsd: Math.round(avoided * failureUsd(issue)),
  };
}

export function closeIssue(world, issueId) {
  authorize(world, 'issue.manage');
  const issue = world.issues.find((item) => item.id === issueId);
  if (!issue || !['measuring', 'monitoring'].includes(issue.status)) throw new Error('This issue isn’t ready to close');
  const result = measureIssue(world, issue);
  if (issue.status === 'measuring' && result.verdict === 'early') throw new Error('There isn’t enough data yet to judge the fix');
  const summary = issue.status === 'monitoring' ? 'Closed with no fix' : `Closed. Failures ${result.changePct}% against what the old rate predicted (forecast ${result.forecastPct}%)`;
  setStatus(world, issue, 'closed', summary);
}

// Failures per week across the affected group.
export function issueWeekly(world, issue) {
  const weeks = Array(WEEKS).fill(0);
  for (const vehicle of groupOf(world, issue)) {
    for (const event of failuresOf(world, vehicle, issue.partId)) {
      const ago = Math.floor((world.now - event.at) / (7 * DAY));
      if (ago < WEEKS) weeks[WEEKS - 1 - ago] += 1;
    }
  }
  return weeks;
}

export const groupSize = (world, issue) => groupOf(world, issue).length;
export const fixedCount = (world, issue) => groupOf(world, issue).filter((v) => v.fixes.some((fix) => fix.issueId === issue.id && fix.until === undefined)).length;
