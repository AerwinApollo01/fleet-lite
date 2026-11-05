import { describe, expect, it } from 'vitest';
import { applyConnectivity, createCampaign, createOtaFleet, faultModel, halt, isOnShift, outstanding, resume, rollbackRemaining, stageStats, startRollback, step, versionInventory } from '../src/core/ota.js';
import { at, DAY, HOUR } from '../src/core/time.js';

const START = at(1, 18);
const spec = (overrides = {}) => ({
  id: 'c1',
  fromVersion: '1.4',
  toVersion: '1.5',
  owner: 'R. Okafor',
  delegates: ['On-call lead'],
  startAt: START,
  stages: [
    { name: 'Canary', share: 0.1 },
    { name: 'Early', share: 0.3 },
    { name: 'Full', share: 1 },
  ],
  gate: { metric: 'post-install faults', maxRate: 0.1, soakMinutes: 24 * HOUR, minSample: 5 },
  ...overrides,
});

function run(campaign, fleet, outcome, hours, { connectivity = true, from = START } = {}) {
  let now = from;
  for (let i = 0; i < hours; i++) {
    if (connectivity) applyConnectivity(fleet, now);
    step(campaign, fleet, now, outcome);
    now += HOUR;
  }
  return now;
}

describe('R7 a rollout needs an owner and a gate', () => {
  it.each([
    ['owner', { owner: '' }],
    ['metric', { gate: { maxRate: 0.1, soakMinutes: 60, minSample: 5 } }],
    ['threshold', { gate: { metric: 'm', soakMinutes: 60, minSample: 5 } }],
    ['soak', { gate: { metric: 'm', maxRate: 0.1, minSample: 5 } }],
    ['sample', { gate: { metric: 'm', maxRate: 0.1, soakMinutes: 60 } }],
  ])('rejects a campaign with no %s', (_, overrides) => {
    expect(() => createCampaign(spec(overrides))).toThrow();
  });
});

describe('R8 silence never passes a gate', () => {
  it('does not advance when the fleet is unreachable, however long it waits', () => {
    const fleet = createOtaFleet(60, '1.4');
    fleet.forEach((v) => { v.online = false; });
    const campaign = createCampaign(spec());
    run(campaign, fleet, faultModel(0), 24 * 30, { connectivity: false });
    expect(campaign.stageIndex).toBe(0);
    expect(campaign.status).toBe('running');
    expect(stageStats(campaign).sample).toBe(0);
  });

  it('completes a healthy rollout across every stage', () => {
    const fleet = createOtaFleet(60, '1.4');
    const campaign = createCampaign(spec());
    run(campaign, fleet, faultModel(0), 24 * 10);
    expect(campaign.status).toBe('complete');
    expect(versionInventory(fleet)).toEqual({ 1.5: 60 });
  });

  it('does not call a rollout complete while a vehicle is unreachable', () => {
    const fleet = createOtaFleet(20, '1.4');
    const campaign = createCampaign(spec({ stages: [{ name: 'Full', share: 1 }] }));
    fleet[0].online = false;
    run(campaign, fleet, faultModel(0), 24 * 5, { connectivity: false });
    expect(campaign.status).toBe('running');
    expect(outstanding(campaign, fleet)).toEqual([fleet[0]]);

    fleet[0].online = true;
    run(campaign, fleet, faultModel(0), 24, { connectivity: false, from: at(10, 18) });
    expect(campaign.status).toBe('complete');
  });

  it('halts a bad build at the canary, with most of the fleet untouched', () => {
    const fleet = createOtaFleet(60, '1.4');
    const campaign = createCampaign(spec());
    run(campaign, fleet, faultModel(0.4), 24 * 5);
    expect(campaign.status).toBe('halted');
    expect(campaign.haltedBy).toBe('gate');
    expect(campaign.stageIndex).toBe(0);
    expect(campaign.results.size).toBeLessThanOrEqual(6);
    expect(versionInventory(fleet)['1.4']).toBeGreaterThanOrEqual(54);
  });

  it('only lets the owner or a delegate halt a rollout', () => {
    const campaign = createCampaign(spec());
    expect(() => halt(campaign, { by: 'Someone else', at: START })).toThrow(/not authorized/);
    halt(campaign, { by: 'On-call lead', at: START });
    expect(campaign.status).toBe('halted');
  });

  it('allows a resume after a human halt, but not after a gate halt', () => {
    const human = createCampaign(spec());
    halt(human, { by: 'R. Okafor', at: START });
    resume(human, { by: 'R. Okafor', at: START + 1 });
    expect(human.status).toBe('running');

    const fleet = createOtaFleet(60, '1.4');
    const gated = createCampaign(spec());
    run(gated, fleet, faultModel(0.4), 24 * 5);
    expect(() => resume(gated, { by: 'R. Okafor', at: START })).toThrow(/new build/);
  });
});

describe('R9 never mid-shift, and rollback reaches stragglers', () => {
  it('defines shift hours', () => {
    expect(isOnShift(at(2, 6))).toBe(true);
    expect(isOnShift(at(2, 17))).toBe(true);
    expect(isOnShift(at(2, 18))).toBe(false);
    expect(isOnShift(at(2, 5))).toBe(false);
  });

  it('never installs during a shift', () => {
    const fleet = createOtaFleet(60, '1.4');
    const campaign = createCampaign(spec());
    run(campaign, fleet, faultModel(0), 24 * 10);
    for (const result of campaign.results.values()) expect(isOnShift(result.at)).toBe(false);
  });

  it('does nothing when a campaign starts mid-shift until the shift ends', () => {
    const fleet = createOtaFleet(10, '1.4');
    const campaign = createCampaign(spec({ startAt: at(1, 9) }));
    step(campaign, fleet, at(1, 9), faultModel(0));
    expect(campaign.results.size).toBe(0);
  });

  it('tracks an offline straggler and reverts it when it returns', () => {
    const fleet = createOtaFleet(60, '1.4');
    const campaign = createCampaign(spec());
    let now = run(campaign, fleet, faultModel(0.4), 24 * 5);
    startRollback(campaign, { by: 'R. Okafor', at: now });

    const straggler = fleet.find((v) => v.version === '1.5');
    fleet.forEach((v) => { v.online = v !== straggler; });
    now = at(10, 22);
    step(campaign, fleet, now, faultModel(0.4));
    expect(campaign.status).toBe('rolling_back');
    expect(rollbackRemaining(campaign, fleet)).toEqual([straggler]);

    step(campaign, fleet, now + DAY / 2, faultModel(0.4));
    expect(straggler.version).toBe('1.5');

    straggler.online = true;
    step(campaign, fleet, now + DAY, faultModel(0.4));
    expect(campaign.status).toBe('rolled_back');
    expect(versionInventory(fleet)).toEqual({ 1.4: 60 });
    expect(fleet.some((v) => v.faulted)).toBe(false);
  });

  it('requires a halt before a rollback', () => {
    expect(() => startRollback(createCampaign(spec()), { by: 'R. Okafor', at: START })).toThrow(/Halt/);
  });
});
