import { describe, expect, it } from 'vitest';
import { commission, createRegistry, grantEntitlement, provision, transfer } from '../src/core/identity.js';
import { createCampaign, createOtaFleet, faultModel, ineligible, outstanding, step } from '../src/core/ota.js';
import { at, HOUR } from '../src/core/time.js';
import { runRangeApp, ASSUMED_PAYLOAD_KG } from '../src/sdv/apps.js';
import { CATALOG, ROADMAP_FEATURE } from '../src/sdv/catalog.js';
import { BATTERY_SUPPLIERS, createHal } from '../src/sdv/hal.js';
import { HARDWARE, validateConfig } from '../src/sdv/hardware.js';
import { REASONS, resolveCapabilities, roadmapFits } from '../src/sdv/resolver.js';
import { assess } from '../src/sdv/scorecard.js';
import { createTwin, drift, reconcile, setDesired, syncEntitlements } from '../src/sdv/twin.js';

const NIGHT = at(1, 20);
const DAYTIME = at(2, 10);
const plant = { packVolts: 49.3, tempC: 8.5, payloadKg: 140 };
const route = { gradePct: 1, stopsPerKm: 3 };
const ids = CATALOG.map((f) => f.id);

function deployed(hardwareRev = 'headroom', entitled = ids, installed = ids) {
  const twin = createTwin({ vin: 'V', hardwareRev, supplier: 'alpha' });
  setDesired(twin, { installed, entitled });
  reconcile(twin, NIGHT);
  return twin;
}

describe('R13 apps do not know who made the part', () => {
  const hal = (supplier, hardware = HARDWARE.headroom) => createHal({ hardware, supplier, plant });

  it('hides genuinely different raw formats behind one contract', () => {
    expect(Object.keys(hal('alpha').rawBattery())).not.toEqual(Object.keys(hal('bravo').rawBattery()));
    expect(hal('alpha').read('battery').packVolts).toBeCloseTo(hal('bravo').read('battery').packVolts, 6);
    expect(hal('alpha').read('battery').tempC).toBeCloseTo(hal('bravo').read('battery').tempC, 6);
  });

  it('gives the same range on either supplier', () => {
    const a = runRangeApp(hal('alpha'), route).estimate.rangeKm.value;
    const b = runRangeApp(hal('bravo'), route).estimate.rangeKm.value;
    expect(a).toBeCloseTo(b, 6);
  });

  it('fails loudly when an adapter breaks the contract', () => {
    const { decode } = BATTERY_SUPPLIERS.bravo;
    BATTERY_SUPPLIERS.bravo.decode = () => ({ packVolts: 49 });
    expect(() => hal('bravo').read('battery')).toThrow(/broke the contract/);
    BATTERY_SUPPLIERS.bravo.decode = decode;
  });

  it('refuses a capability the hardware does not have', () => {
    expect(() => hal('alpha', HARDWARE.lean).read('cargo-load')).toThrow(/no cargo-load/);
  });

  it('labels payload honestly on each hardware revision', () => {
    expect(runRangeApp(hal('alpha'), route).payload).toMatchObject({ value: 140, provenance: 'measured' });
    expect(runRangeApp(hal('alpha', HARDWARE.lean), route).payload).toMatchObject({ value: ASSUMED_PAYLOAD_KG, provenance: 'modeled' });
  });
});

describe('R14 capability is decided per vehicle and explained', () => {
  it('gives identical hardware different features by entitlement', () => {
    const full = resolveCapabilities(deployed('headroom', ids)).active;
    const partial = resolveCapabilities(deployed('headroom', ['range-forecast'])).active;
    expect(full).toHaveLength(5);
    expect(partial).toEqual(['range-forecast']);
  });

  it('states one known reason for every feature', () => {
    for (const feature of resolveCapabilities(deployed('lean', ['range-forecast'])).features) {
      expect(REASONS[feature.state]).toBeTruthy();
    }
  });

  it('checks each condition', () => {
    const state = (twin, id) => resolveCapabilities(twin).features.find((f) => f.id === id).state;
    expect(state(deployed('lean'), 'load-aware-range')).toBe('hardware-missing');
    expect(state(deployed('headroom', ids, []), 'range-forecast')).toBe('not-installed');
    expect(state(deployed('headroom', []), 'range-forecast')).toBe('not-entitled');
    expect(state(deployed('lean'), 'driver-coaching')).toBe('over-budget');
  });

  it('never exceeds the compute budget', () => {
    for (const rev of ['lean', 'headroom']) {
      const { used, budget } = resolveCapabilities(deployed(rev));
      expect(used.cpu).toBeLessThanOrEqual(budget.cpu);
      expect(used.memoryMb).toBeLessThanOrEqual(budget.memoryMb);
    }
  });
});

describe('R15 headroom is sized to a named feature', () => {
  it('fits the roadmap feature only on the headroom revision', () => {
    expect(ROADMAP_FEATURE.id).toBe('proximity-alert');
    expect(roadmapFits(HARDWARE.headroom)).toBe(true);
    expect(roadmapFits(HARDWARE.lean)).toBe(false);
  });

  it('fails the bet if the feature outgrows the headroom', () => {
    const bloated = CATALOG.map((f) => (f.roadmap ? { ...f, cpu: 500 } : f));
    expect(resolveCapabilities(deployed('headroom'), bloated).features.at(-1).state).toBe('over-budget');
  });
});

describe('R16 the cloud decides and the vehicle does not depend on it', () => {
  it('queues changes offline, shows drift, and keeps running', () => {
    const twin = deployed();
    const before = resolveCapabilities(twin).active;
    twin.online = false;
    setDesired(twin, { entitled: ['range-forecast'] });

    expect(reconcile(twin, NIGHT).reason).toBe('offline');
    expect(drift(twin)).toEqual(['entitled']);
    expect(resolveCapabilities(twin).active).toEqual(before);

    twin.online = true;
    expect(reconcile(twin, NIGHT).applied).toBe(true);
    expect(drift(twin)).toEqual([]);
    expect(resolveCapabilities(twin).active).toEqual(['range-forecast']);
  });

  it('holds installs until off shift, but lets entitlement through', () => {
    const twin = deployed('headroom', ids, ['range-forecast']);
    setDesired(twin, { installed: ids });
    expect(reconcile(twin, DAYTIME).reason).toBe('on-shift');
    expect(reconcile(twin, at(2, 19)).applied).toBe(true);

    setDesired(twin, { entitled: ['range-forecast'] });
    expect(reconcile(twin, at(3, 10)).applied).toBe(true);
  });

  it('skips a sync with nothing to do', () => {
    expect(reconcile(deployed(), NIGHT).reason).toBe('in-sync');
  });

  it('ends contract features at the next sync after a transfer, not before', () => {
    const reg = createRegistry();
    provision(reg, { deviceId: 'd', vin: 'V', certificate: 'c', at: 0 });
    commission(reg, { vin: 'V', fleetId: 'A', at: 1, by: 'o' });
    grantEntitlement(reg, { vin: 'V', feature: 'battery-health', scope: 'vehicle', at: 1 });
    grantEntitlement(reg, { vin: 'V', feature: 'range-forecast', scope: 'contract', fleetId: 'A', at: 1 });

    const twin = createTwin({ vin: 'V', hardwareRev: 'lean', supplier: 'alpha' });
    setDesired(twin, { installed: ['battery-health', 'range-forecast'] });
    syncEntitlements(twin, reg, NIGHT);
    reconcile(twin, NIGHT);
    expect(resolveCapabilities(twin).active).toEqual(['range-forecast', 'battery-health']);

    twin.online = false;
    transfer(reg, { vin: 'V', toFleetId: 'B', at: NIGHT + HOUR, by: 'ops' });
    syncEntitlements(twin, reg, NIGHT + 2 * HOUR);
    reconcile(twin, NIGHT + 2 * HOUR);
    expect(resolveCapabilities(twin).active).toContain('range-forecast');

    twin.online = true;
    reconcile(twin, NIGHT + 3 * HOUR);
    expect(resolveCapabilities(twin).active).toEqual(['battery-health']);
  });
});

describe('R17 software cannot leave the envelope', () => {
  it('rejects bad settings at the cloud', () => {
    const twin = deployed();
    expect(() => setDesired(twin, { config: { 'motor.assistLimitKph': 40 } })).toThrow(/within/);
    expect(() => setDesired(twin, { config: { 'brakes.response': 1 } })).toThrow(/bound at manufacture/);
    expect(() => setDesired(twin, { config: { 'made.up': 1 } })).toThrow(/known setting/);
    expect(twin.desired.config['motor.assistLimitKph']).toBe(25);
  });

  it('accepts a setting inside the envelope', () => {
    expect(validateConfig({ 'charge.maxSocPct': 80 })).toEqual([]);
  });

  it('rejects a bad generation on the vehicle and stays on the old one', () => {
    const twin = deployed();
    const generation = twin.reported.generation;
    twin.desired = {
      ...twin.desired,
      entitled: [],
      config: { ...twin.desired.config, 'motor.assistLimitKph': 40 },
      generation: generation + 1,
    };
    expect(reconcile(twin, NIGHT).reason).toBe('rejected');
    expect(twin.reported.generation).toBe(generation);
    expect(twin.reported.config['motor.assistLimitKph']).toBe(25);
    expect(twin.reported.entitled).toEqual(ids);
    expect(twin.reported.rejected.errors[0]).toMatch(/within/);
  });
});

describe('R18 the installed base is the deployment target', () => {
  const mixed = () => createOtaFleet(20, '1.4').map((v, i) => ({ ...v, hardwareRev: i % 4 === 0 ? 'lean' : 'headroom' }));
  const campaign = () => createCampaign({
    id: 'c', fromVersion: '1.4', toVersion: '1.5', owner: 'Owner', startAt: NIGHT,
    stages: [{ name: 'Full', share: 1 }],
    gate: { metric: 'faults', maxRate: 0.1, soakMinutes: HOUR, minSample: 5 },
    eligible: (v) => v.hardwareRev === 'headroom',
  });

  it('excludes incompatible vehicles by name and still completes', () => {
    const fleet = mixed();
    const c = campaign();
    expect(ineligible(c, fleet)).toHaveLength(5);
    step(c, fleet, NIGHT, faultModel(0));
    step(c, fleet, NIGHT + 2 * HOUR, faultModel(0));
    expect(outstanding(c, fleet)).toEqual([]);
    expect(c.status).toBe('complete');
    expect(fleet.filter((v) => v.hardwareRev === 'lean').every((v) => v.version === '1.4')).toBe(true);
  });
});

describe('the software-defined scorecard', () => {
  const passed = (twin) => Object.fromEntries(assess(twin, NIGHT).map((c) => [c.id, c.passed]));

  it('fails a factory-fresh lean vehicle on everything it should', () => {
    const twin = createTwin({ vin: 'V', hardwareRev: 'lean', supplier: 'alpha' });
    expect(passed(twin)).toMatchObject({ headroom: false, 'installed-base': false, 'runtime-entitlement': false, 'cloud-freezes': false });
  });

  it('passes a deployed headroom vehicle on all five', () => {
    expect(Object.values(passed(deployed()))).toEqual([true, true, true, true, true]);
  });

  it('does not change the real twin when it runs', () => {
    const twin = deployed();
    const snapshot = JSON.stringify(twin);
    assess(twin, NIGHT);
    expect(JSON.stringify(twin)).toBe(snapshot);
  });
});
