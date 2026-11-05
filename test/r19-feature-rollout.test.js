import { describe, expect, it } from 'vitest';
import { halt, ineligible, isOnShift, outstanding, resume, rollbackRemaining, stageStats, startRollback, versionInventory } from '../src/core/ota.js';
import { CATALOG } from '../src/sdv/catalog.js';
import { canHost, resolveCapabilities } from '../src/sdv/resolver.js';
import { drift, reconcile, setDesired } from '../src/sdv/twin.js';
import { assess } from '../src/sdv/scorecard.js';
import { advanceFleet, canStart, createFleetWorld, entitleInstalled, FACTORY_FEATURES, featureCounts, OWNER, resetFleet, ROLLOUTS, rolloutActive, startRollout } from '../src/scenarios/fleet.js';

const FEATURE = 'load-aware-range';
const feature = (id) => CATALOG.find((f) => f.id === id);
const count = (world, rev) => world.fleet.filter((v) => v.hardwareRev === rev).length;

describe('the shared fleet', () => {
  it('mixes hardware and suppliers, so all four combinations exist', () => {
    const combos = new Set(createFleetWorld().fleet.map((v) => `${v.hardwareRev}/${v.supplier}`));
    expect(combos.size).toBe(4);
  });

  it('starts on a factory image at generation 0', () => {
    const [twin] = createFleetWorld().fleet;
    expect(twin.reported.generation).toBe(0);
    expect(resolveCapabilities(twin).active).toEqual(FACTORY_FEATURES);
    expect(drift(twin)).toEqual([]);
  });
});

describe('R19 features reach the installed base only through a rollout', () => {
  it('stages a feature across the fleet and excludes what cannot host it, by reason', () => {
    const world = createFleetWorld();
    startRollout(world, 'load');
    expect(world.excluded).toHaveLength(count(world, 'lean'));
    expect(world.excluded.every((e) => e.reason === 'hardware-missing')).toBe(true);
    expect(ineligible(world.campaign, world.fleet)).toHaveLength(count(world, 'lean'));

    advanceFleet(world, 24);
    expect(world.campaign.stageIndex).toBeLessThanOrEqual(1);
    expect(featureCounts(world, FEATURE).installed).toBeLessThan(count(world, 'headroom'));

    advanceFleet(world, 24 * 12);
    expect(world.campaign.status).toBe('complete');
    expect(featureCounts(world, FEATURE).installed).toBe(count(world, 'headroom'));
  });

  it('excludes lean vehicles for budget when the sensor exists but compute does not', () => {
    const world = createFleetWorld();
    startRollout(world, 'coach');
    const lean = world.excluded.filter((e) => e.reason === 'over-budget');
    expect(lean).toHaveLength(count(world, 'lean'));
  });

  it('never installs a feature during a shift', () => {
    const world = createFleetWorld();
    startRollout(world, 'load');
    advanceFleet(world, 24 * 12);
    for (const result of world.campaign.results.values()) expect(isOnShift(result.at)).toBe(false);
  });

  it('keeps deployed separate from released', () => {
    const world = createFleetWorld();
    startRollout(world, 'load');
    advanceFleet(world, 24 * 12);
    expect(featureCounts(world, FEATURE)).toEqual({ installed: 45, active: 0 });

    expect(entitleInstalled(world, FEATURE)).toBe(45);
    advanceFleet(world, 24);
    const waiting = world.fleet.filter((v) => v.reported.installed.includes(FEATURE) && !resolveCapabilities(v).active.includes(FEATURE));
    expect(featureCounts(world, FEATURE).active + waiting.length).toBe(45);
    for (const twin of waiting) {
      expect(twin.online).toBe(false);
      expect(drift(twin)).toEqual(['entitled']);
    }

    advanceFleet(world, 24 * 7);
    expect(featureCounts(world, FEATURE)).toEqual({ installed: 45, active: 45 });
  });

  it('halts a bad feature at the canary and leaves the rest of the fleet alone', () => {
    const world = createFleetWorld();
    startRollout(world, 'load-bad');
    advanceFleet(world, 24 * 6);
    expect(world.campaign).toMatchObject({ status: 'halted', haltedBy: 'gate', stageIndex: 0 });
    expect(stageStats(world.campaign).faults).toBeGreaterThan(0);
    expect(featureCounts(world, FEATURE).installed).toBeLessThanOrEqual(5);
  });

  it('rolls a bad feature back through the twin without touching entitlement', () => {
    const world = createFleetWorld();
    startRollout(world, 'load-bad');
    advanceFleet(world, 24 * 6);
    const touched = world.fleet.filter((v) => world.campaign.results.has(v.vin));
    const generations = touched.map((v) => v.reported.generation);

    startRollback(world.campaign, { by: OWNER, at: world.now });
    advanceFleet(world, 24 * 6);

    expect(world.campaign.status).toBe('rolled_back');
    expect(featureCounts(world, FEATURE).installed).toBe(0);
    expect(world.fleet.some((v) => v.faulted)).toBe(false);
    touched.forEach((v, i) => {
      expect(v.reported.generation).toBeGreaterThan(generations[i]);
      expect(v.reported.entitled).toEqual(FACTORY_FEATURES);
      expect(drift(v)).toEqual([]);
    });
  });

  it('holds rollback open for a vehicle pinned offline, then finishes when it returns', () => {
    const world = createFleetWorld();
    startRollout(world, 'load-bad');
    advanceFleet(world, 24 * 6);
    const straggler = world.fleet.find((v) => world.campaign.results.has(v.vin));
    straggler.pinnedOffline = true;
    startRollback(world.campaign, { by: OWNER, at: world.now });
    advanceFleet(world, 24 * 6);

    expect(world.campaign.status).toBe('rolling_back');
    expect(rollbackRemaining(world.campaign, world.fleet)).toEqual([straggler]);

    straggler.pinnedOffline = false;
    advanceFleet(world, 24 * 4);
    expect(world.campaign.status).toBe('rolled_back');
  });

  it('holds a feature rollout open for an unreachable vehicle', () => {
    const world = createFleetWorld();
    startRollout(world, 'load');
    const headroom = world.fleet.find((v) => v.hardwareRev === 'headroom');
    headroom.pinnedOffline = true;
    advanceFleet(world, 24 * 14);
    expect(world.campaign.status).toBe('running');
    expect(outstanding(world.campaign, world.fleet)).toEqual([headroom]);
  });

  it('lets an entitlement queued offline land on a later sync', () => {
    const world = createFleetWorld();
    const [twin] = world.fleet;
    twin.pinnedOffline = true;
    advanceFleet(world, 1);
    setDesired(twin, { entitled: [] });
    expect(reconcile(twin, world.now).reason).toBe('offline');
    twin.pinnedOffline = false;
    advanceFleet(world, 24 * 3);
    expect(twin.reported.entitled).toEqual([]);
  });
});

describe('campaign rules on the shared fleet', () => {
  it('runs one campaign at a time, and needs a decision after a halt', () => {
    const world = createFleetWorld();
    startRollout(world, 'load-bad');
    expect(() => startRollout(world, 'coach')).toThrow(/current campaign/);
    expect(canStart(world, ROLLOUTS.find((r) => r.id === 'coach'))).toBe(false);

    advanceFleet(world, 24 * 6);
    expect(rolloutActive(world)).toBe(true);
    startRollback(world.campaign, { by: OWNER, at: world.now });
    advanceFleet(world, 24 * 6);
    expect(rolloutActive(world)).toBe(false);
    expect(() => startRollout(world, 'coach')).not.toThrow();
  });

  it('allows a human halt and resume on a feature rollout', () => {
    const world = createFleetWorld();
    startRollout(world, 'load');
    halt(world.campaign, { by: OWNER, at: world.now });
    advanceFleet(world, 24);
    expect(world.campaign.results.size).toBe(0);
    resume(world.campaign, { by: OWNER, at: world.now });
    advanceFleet(world, 24 * 12);
    expect(world.campaign.status).toBe('complete');
  });

  it('does not offer a feature to vehicles that already have it', () => {
    const world = createFleetWorld();
    startRollout(world, 'load');
    advanceFleet(world, 24 * 12);
    const load = ROLLOUTS.find((r) => r.id === 'load');
    expect(canStart(world, load)).toBe(false);
    expect(() => startRollout(world, 'load')).toThrow(/No vehicle/);
    expect(canHost(world.fleet[1], feature(FEATURE)).reason).toBe('already-installed');
  });

  it('rolls firmware back to the version the fleet was actually on', () => {
    const world = createFleetWorld();
    startRollout(world, 'fw-good');
    advanceFleet(world, 24 * 12);
    expect(versionInventory(world.fleet)).toEqual({ '1.5.0': 60 });

    startRollout(world, 'fw-bad');
    expect(world.campaign.fromVersion).toBe('1.5.0');
    advanceFleet(world, 24 * 6);
    startRollback(world.campaign, { by: OWNER, at: world.now });
    advanceFleet(world, 24 * 6);
    expect(versionInventory(world.fleet)).toEqual({ '1.5.0': 60 });
  });

  it('counts a post-delivery rollout on the scorecard', () => {
    const world = createFleetWorld();
    const twin = world.fleet[1];
    const score = (id) => assess(twin, world.now).find((c) => c.id === id).passed;
    expect(score('installed-base')).toBe(false);
    startRollout(world, 'load');
    advanceFleet(world, 24 * 12);
    expect(score('installed-base')).toBe(true);
  });

  it('resets the whole world', () => {
    const world = createFleetWorld();
    startRollout(world, 'load');
    advanceFleet(world, 48);
    resetFleet(world);
    expect(world.campaign).toBeNull();
    expect(world.fleet.every((v) => v.reported.generation === 0)).toBe(true);
  });
});
