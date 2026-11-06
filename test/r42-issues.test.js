import { describe, expect, it } from 'vitest';
import { componentReliability, vehicleTwin } from '../src/scenarios/components.js';
import { syncEventLog } from '../src/scenarios/eventlog.js';
import { evaluateAlerts } from '../src/scenarios/alerts.js';
import { advanceFleet, createFleetWorld } from '../src/scenarios/fleet.js';
import { halt, startRollback } from '../src/core/ota.js';
import { chooseFix, closeIssue, findings, fixedCount, fixOptions, groupSize, issueWeekly, measureIssue, openIssue } from '../src/scenarios/issues.js';
import { explain, operationsView, routeRows } from '../src/scenarios/operations.js';
import { criticalFault } from '../src/scenarios/components.js';

function bigWorld(role = 'owner') {
  const world = createFleetWorld(5000);
  world.role = role;
  return world;
}
const bravoIssue = (world) => openIssue(world, 'bms', 's:bravo');
const until = (world, issue, status, maxDays = 40) => {
  for (let day = 0; day < maxDays && issue.status !== status; day++) advanceFleet(world, 24);
  expect(issue.status).toBe(status);
};

describe('R42 a finding can become a measured fix', () => {
  it('needs a finding the data supports', () => {
    const world = bigWorld();
    expect(() => openIssue(world, 'motor', 's:bravo')).toThrow();
    expect(findings(createFleetWorld())).toEqual([]);
  });

  it('only an owner or engineer can open or decide', () => {
    const world = bigWorld('technician');
    expect(() => bravoIssue(world)).toThrow();
    world.role = 'owner';
    const issue = bravoIssue(world);
    world.role = 'technician';
    expect(() => chooseFix(world, issue.id, 'ota')).toThrow();
  });

  it('won’t open the same issue twice', () => {
    const world = bigWorld();
    bravoIssue(world);
    expect(() => bravoIssue(world)).toThrow();
    expect(findings(world).find((f) => f.partId === 'bms').issue.id).toBe(1);
  });

  it('prices the options, with the patch cheap and replacement thorough', () => {
    const world = bigWorld();
    const { options, failureUsd } = fixOptions(world, bravoIssue(world));
    const [ota, replace] = options;
    expect(failureUsd).toBeGreaterThan(0);
    expect(ota.upfrontUsd).toBeLessThan(replace.upfrontUsd);
    expect(replace.avoidedPerYear).toBeGreaterThan(ota.avoidedPerYear);
    expect(ota.paybackMonths).toBeCloseTo((ota.upfrontUsd / ota.savingPerYearUsd) * 12, 0);
    expect(Math.abs(ota.threeYearNetUsd - (ota.savingPerYearUsd * 3 - ota.upfrontUsd))).toBeLessThanOrEqual(2);
  });

  it('only supplier problems can be claimed', () => {
    const world = bigWorld();
    expect(fixOptions(world, bravoIssue(world)).options.map((o) => o.id)).toContain('claim');
    expect(fixOptions(world, openIssue(world, 'vcu', 'h:lean')).options.map((o) => o.id)).not.toContain('claim');
  });

  it('a claim recovers money, changes no failures, and leaves the fix decision open', () => {
    const world = bigWorld();
    const issue = bravoIssue(world);
    const before = JSON.stringify(world.fleet.map((v) => v.fixes));
    chooseFix(world, issue.id, 'claim');
    expect(issue.recoveredUsd).toBeGreaterThan(0);
    expect(issue.status).toBe('open');
    expect(JSON.stringify(world.fleet.map((v) => v.fixes))).toBe(before);
    expect(() => chooseFix(world, issue.id, 'claim')).toThrow();
  });

  it('a patch goes through the gated rollout, only to the affected group', () => {
    const world = bigWorld();
    const issue = bravoIssue(world);
    chooseFix(world, issue.id, 'ota');
    expect(world.campaign.stages[0].name).toBe('Canary');
    expect(fixedCount(world, issue)).toBe(0);
    until(world, issue, 'measuring');
    expect(fixedCount(world, issue)).toBe(groupSize(world, issue));
    expect(world.fleet.filter((v) => v.supplier === 'alpha').every((v) => v.fixes.length === 0)).toBe(true);
    expect(world.fleet.find((v) => v.supplier === 'bravo').firmware.bms.version).toBe('5.2.2');
  });

  it('won’t start during another rollout', () => {
    const world = bigWorld();
    const first = bravoIssue(world);
    const second = openIssue(world, 'vcu', 'h:lean');
    chooseFix(world, first.id, 'ota');
    expect(() => chooseFix(world, second.id, 'ota')).toThrow();
    expect(second.status).toBe('open');
    expect(second.spentUsd).toBe(0);
  });

  it('replacing parts works through a shop queue, and costs add up', () => {
    const world = bigWorld();
    const issue = openIssue(world, 'vcu', 'h:lean');
    chooseFix(world, issue.id, 'replace');
    advanceFleet(world, 24);
    expect(fixedCount(world, issue)).toBe(40);
    expect(issue.spentUsd).toBe(40 * 540);
    expect(issue.status).toBe('fixing');
  });

  it('a fix never changes the past', () => {
    const world = bigWorld();
    const issue = bravoIssue(world);
    const before = componentReliability(world).find((p) => p.id === 'bms').failures;
    chooseFix(world, issue.id, 'ota');
    until(world, issue, 'measuring');
    expect(componentReliability(world).find((p) => p.id === 'bms').failures).toBeGreaterThanOrEqual(before);
  });

  it('a patch lowers failures on the fixed vehicles, and nobody else’s', () => {
    const fixedWorld = bigWorld();
    const plainWorld = bigWorld();
    const issue = bravoIssue(fixedWorld);
    chooseFix(fixedWorld, issue.id, 'ota');
    advanceFleet(fixedWorld, 24 * 60);
    advanceFleet(plainWorld, 24 * 60);
    const rate = (world, label) => componentReliability(world).find((p) => p.id === 'bms').breakdown.find((g) => g.label === label).failures;
    expect(rate(fixedWorld, 'Supplier Bravo')).toBeLessThan(rate(plainWorld, 'Supplier Bravo'));
    expect(rate(fixedWorld, 'Supplier Alpha')).toBe(rate(plainWorld, 'Supplier Alpha'));
  });

  it('a monitored issue changes nothing', () => {
    const world = bigWorld();
    const issue = bravoIssue(world);
    chooseFix(world, issue.id, 'monitor');
    advanceFleet(world, 24);
    expect(world.fleet.every((v) => v.fixes.length === 0)).toBe(true);
    closeIssue(world, issue.id);
    expect(issue.status).toBe('closed');
  });

  it('refuses a verdict, and a close, on too little data', () => {
    const world = bigWorld();
    const issue = bravoIssue(world);
    chooseFix(world, issue.id, 'ota');
    advanceFleet(world, 24);
    expect(measureIssue(world, issue).verdict).toBe('early');
    expect(() => closeIssue(world, issue.id)).toThrow(/ready to close/);
    issue.status = 'measuring';
    expect(() => closeIssue(world, issue.id)).toThrow(/enough data/);
  });

  it('measures the real effect, which differs from the forecast', () => {
    const world = bigWorld();
    const issue = bravoIssue(world);
    chooseFix(world, issue.id, 'ota');
    until(world, issue, 'measuring');
    advanceFleet(world, 24 * 90);
    const result = measureIssue(world, issue);
    expect(result.verdict).toBe('working');
    expect(result.forecastPct).toBe(-50);
    expect(result.changePct).toBeGreaterThan(-52);
    expect(result.changePct).toBeLessThan(-28);
    expect(result.actual).toBeLessThan(result.expected);
    closeIssue(world, issue.id);
    expect(issue.log.at(-1).text).toMatch(/forecast -50%/);
  });

  it('a closed issue can’t be opened again from the old lifetime rate', () => {
    const world = bigWorld();
    const issue = bravoIssue(world);
    chooseFix(world, issue.id, 'monitor');
    closeIssue(world, issue.id);
    expect(findings(world).find((f) => f.partId === 'bms').closed.id).toBe(issue.id);
    expect(() => bravoIssue(world)).toThrow();
  });

  it('rolling the patch back reopens the issue, and keeps what really happened', () => {
    const world = bigWorld();
    const issue = bravoIssue(world);
    chooseFix(world, issue.id, 'ota');
    advanceFleet(world, 24);
    const owner = world.campaign.owner;
    halt(world.campaign, { by: owner, at: world.now });
    startRollback(world.campaign, { by: owner, at: world.now });
    advanceFleet(world, 24 * 8);
    expect(issue.status).toBe('open');
    expect(issue.fix).toBeNull();
    expect(fixedCount(world, issue)).toBe(0);
    expect(world.fleet.filter((v) => v.fixes.length).every((v) => v.fixes.every((fix) => fix.until !== undefined))).toBe(true);
  });

  it('the decision log only grows, and entries can’t change', () => {
    const world = bigWorld();
    const issue = bravoIssue(world);
    chooseFix(world, issue.id, 'ota');
    const first = issue.log[0];
    expect(() => { 'use strict'; first.text = 'changed'; }).toThrow();
    expect(issue.log.length).toBe(2);
  });

  it('a fix appears in the vehicle’s event log', () => {
    const world = bigWorld();
    const issue = bravoIssue(world);
    chooseFix(world, issue.id, 'ota');
    advanceFleet(world, 24 * 2);
    const vehicle = world.fleet.find((v) => v.fixes.length);
    expect(syncEventLog(world, vehicle.vin).some((e) => /Fix applied for issue #1/.test(e.text))).toBe(true);
  });

  it('weekly counts follow the affected group', () => {
    const world = bigWorld();
    const weeks = issueWeekly(world, bravoIssue(world));
    expect(weeks).toHaveLength(12);
    expect(weeks.reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
  });
});

describe('R43 Today reacts to serious part faults', () => {
  let found = null;
  function faultyRoute() {
    if (found) return found;
    const world = createFleetWorld();
    for (let day = 0; day < 400; day += 5) {
      const row = routeRows(world).find((r) => r.status === 'PART_FAULT');
      if (row) {
        found = { world, row };
        return found;
      }
      advanceFleet(world, 24 * 5);
    }
    throw new Error('No part fault found');
  }

  it('marks the route, and says why in plain words', () => {
    const { row } = faultyRoute();
    expect(explain(row)).toMatch(new RegExp(row.vehicle.vin));
    expect(explain(row)).not.toMatch(/[A-Z]{3}-\d{3}/);
  });

  it('agrees with the vehicle’s own verdict', () => {
    const { world, row } = faultyRoute();
    expect(vehicleTwin(world, row.vehicle.vin).verdict.label).toBe('Service before next shift');
  });

  it('needs a decision, and a battery swap isn’t offered', () => {
    const { world, row } = faultyRoute();
    const decision = operationsView(world).decisions.find((d) => d.row.route.id === row.route.id);
    expect(decision).toBeDefined();
    expect(decision.pack).toBeNull();
  });

  it('raises a rationed alert', () => {
    const { world, row } = faultyRoute();
    row.vehicle.pinnedOffline = false;
    for (let hour = 0; hour < 24 && !world.alerts.some((a) => a.rule === 'part-fault' && a.vin === row.vehicle.vin); hour++) advanceFleet(world, 1);
    evaluateAlerts(world);
    expect(world.alerts.some((a) => a.rule === 'part-fault' && a.vin === row.vehicle.vin)).toBe(true);
  });

  it('a minor fault doesn’t mark the route', () => {
    const world = createFleetWorld(500);
    const part = (vin) => vehicleTwin(world, vin).components;
    const minor = world.fleet.find((v) => part(v.vin).some((c) => c.state === 'watch' && c.openFaults > 0) && !part(v.vin).some((c) => c.state === 'fault'));
    expect(minor).toBeDefined();
    expect(criticalFault(world, minor)).toBeNull();
  });

});
