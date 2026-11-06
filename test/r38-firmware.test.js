import { describe, expect, it } from 'vitest';
import { assetHistory, assetRegister } from '../src/scenarios/assets.js';
import { vehicleTwin } from '../src/scenarios/components.js';
import { advanceFleet, createFleetWorld, startRollout } from '../src/scenarios/fleet.js';
import { compatibilityIssues, fleetFirmware, firmwareView, fittedTargets, NOT_UPDATABLE, planUpdate, PATCHES, RELEASES, releaseLabel, runUpdate, startUpdate, stepUpdate, TARGETS } from '../src/scenarios/firmware.js';
import { completeService } from '../src/scenarios/maintenance.js';
import { scheduleRepair } from '../src/scenarios/components.js';

function parked(role = 'technician') {
  const world = createFleetWorld();
  advanceFleet(world, 9);
  world.role = role;
  return world;
}
const rich = (world) => world.fleet.find((v) => v.online && v.hardwareRev === 'headroom');
const versions = (vehicle) => Object.fromEntries(Object.entries(vehicle.firmware).map(([id, entry]) => [id, entry.version]));

describe('R38 every part’s firmware is visible', () => {
  it('a vehicle starts with every fitted part on its release set', () => {
    const world = createFleetWorld();
    for (const vehicle of world.fleet) {
      expect(Object.keys(vehicle.firmware)).toEqual(fittedTargets(vehicle).map((t) => t.id));
      expect(releaseLabel(vehicle)).toBe('1.4.2');
    }
  });

  it('parts the hardware lacks have no firmware', () => {
    const lean = createFleetWorld().fleet.find((v) => v.hardwareRev === 'lean');
    expect(lean.firmware.cargo).toBeUndefined();
    expect(lean.firmware.proximity).toBeUndefined();
  });

  it('the battery supplier decides the BMS image', () => {
    const { fleet } = createFleetWorld();
    expect(fleet.find((v) => v.supplier === 'alpha').firmware.bms.version).not.toBe(fleet.find((v) => v.supplier === 'bravo').firmware.bms.version);
  });

  it('brakes and parts with no firmware can’t be targeted', () => {
    for (const { id } of NOT_UPDATABLE) expect(TARGETS.some((t) => t.id === id)).toBe(false);
  });

  it('a fleet rollout moves every part, and a rollback moves them back', () => {
    const world = createFleetWorld();
    const before = versions(world.fleet[1]);
    startRollout(world, 'fw-good');
    const { applier, fromVersion, toVersion } = world.campaign;
    applier.install({ toVersion }, world.fleet[1]);
    expect(world.fleet[1].firmware.gateway.version).toBe('2.4.0');
    expect(releaseLabel(world.fleet[1])).toBe('1.5.0');
    applier.revert({ fromVersion }, world.fleet[1]);
    expect(versions(world.fleet[1])).toEqual(before);
  });

  it('a campaign run end to end leaves parts matching the release', () => {
    const world = createFleetWorld();
    startRollout(world, 'fw-good');
    advanceFleet(world, 24 * 6);
    const updated = world.fleet.filter((v) => v.version === '1.5.0');
    expect(updated.length).toBeGreaterThan(0);
    for (const vehicle of updated) expect(releaseLabel(vehicle)).toBe('1.5.0');
  });

  it('the fleet view counts every vehicle, and mixed and latest vehicles apart', () => {
    const world = parked();
    const vehicle = rich(world);
    const start = fleetFirmware(world);
    expect(start.releases).toEqual([{ version: '1.4.2', vehicles: 60 }]);
    expect(start.behind).toBe(60);
    startUpdate(world, vehicle.vin, 'patch-proximity');
    runUpdate(world, vehicle.vin);
    expect(fleetFirmware(world).releases).toContainEqual({ version: '1.4.2 (mixed)', vehicles: 1 });
    startUpdate(world, vehicle.vin, '1.5.0');
    runUpdate(world, vehicle.vin);
    const after = fleetFirmware(world);
    expect(after.releases).toContainEqual({ version: '1.5.0', vehicles: 1 });
    expect(after.behind).toBe(59);
  });

  it('the fleet view only counts vehicles that have the part', () => {
    const world = createFleetWorld();
    const cargo = fleetFirmware(world).parts.find((part) => part.id === 'cargo');
    expect(cargo.versions.reduce((sum, item) => sum + item.vehicles, 0)).toBe(world.fleet.filter((v) => v.hardwareRev === 'headroom').length);
  });

  it('the fleet view counts a part that won’t start', () => {
    const world = parked();
    const vehicle = rich(world);
    startUpdate(world, vehicle.vin, 'patch-proximity', 'cut:proximity');
    runUpdate(world, vehicle.vin);
    expect(fleetFirmware(world).parts.find((part) => part.id === 'proximity').wontStart).toBe(1);
  });

  it('every release set is a tested combination', () => {
    for (const release of Object.values(RELEASES)) {
      const flat = Object.fromEntries(Object.entries(release.parts).map(([id, v]) => [id, typeof v === 'string' ? v : v.alpha]));
      expect(compatibilityIssues(flat)).toEqual([]);
    }
  });
});

describe('R39 one vehicle can be updated in the simulator', () => {
  it('runs a full release and reports it', () => {
    const world = parked();
    const { vin } = rich(world);
    startUpdate(world, vin, '1.5.0');
    expect(runUpdate(world, vin).status).toBe('done');
    const vehicle = world.fleet.find((v) => v.vin === vin);
    expect(vehicle.version).toBe('1.5.0');
    expect(releaseLabel(vehicle)).toBe('1.5.0');
    expect(vehicle.firmware.vcu).toMatchObject({ version: '1.5.0', spare: '1.4.2', slot: 'B' });
  });

  it('stages two-slot parts, flashes one-slot parts, then switches', () => {
    const world = parked();
    const kinds = planUpdate(world, rich(world).vin, '1.5.0').steps.map((step) => step.kind);
    expect(kinds.lastIndexOf('stage')).toBeLessThan(kinds.indexOf('flash'));
    expect(kinds.lastIndexOf('flash')).toBeLessThan(kinds.indexOf('activate'));
  });

  it('a staged part keeps running its old version until the switch', () => {
    const world = parked();
    const vehicle = rich(world);
    startUpdate(world, vehicle.vin, '1.5.0');
    while (world.updates[vehicle.vin].steps[world.updates[vehicle.vin].index].kind !== 'activate') stepUpdate(world, vehicle.vin);
    expect(vehicle.firmware.vcu).toMatchObject({ version: '1.4.2', spare: '1.5.0' });
  });

  it('blocks on shift, with no signal, and during a fleet rollout', () => {
    const shift = createFleetWorld();
    expect(planUpdate(shift, 'V-002', '1.5.0').blocked.join()).toMatch(/On shift/);
    const world = parked();
    const offline = world.fleet.find((v) => !v.online);
    expect(planUpdate(world, offline.vin, '1.5.0').blocked.join()).toMatch(/No signal/);
    startRollout(world, 'fw-good');
    expect(planUpdate(world, rich(world).vin, '1.5.0').blocked.join()).toMatch(/fleet rollout/);
    expect(() => startUpdate(world, rich(world).vin, '1.5.0')).toThrow();
  });

  it('a vehicle update blocks a fleet rollout from starting', () => {
    const world = parked();
    startUpdate(world, rich(world).vin, '1.5.0');
    expect(() => startRollout(world, 'fw-good')).toThrow();
  });

  it('only a technician or engineer can update', () => {
    const world = parked('owner');
    expect(() => startUpdate(world, rich(world).vin, '1.5.0')).toThrow();
  });

  it('refuses a patch that makes an untested combination', () => {
    const world = parked();
    const plan = planUpdate(world, rich(world).vin, 'patch-inverter');
    expect(plan.blocked.join()).toMatch(/needs Vehicle computer 1.5.0/);
    expect(() => startUpdate(world, rich(world).vin, 'patch-inverter')).toThrow();
  });

  it('a patch updates one part and shows as mixed', () => {
    const world = parked();
    const vehicle = rich(world);
    startUpdate(world, vehicle.vin, 'patch-proximity');
    runUpdate(world, vehicle.vin);
    expect(vehicle.firmware.proximity.version).toBe('1.0.2');
    expect(vehicle.version).toBe('1.4.2');
    expect(releaseLabel(vehicle)).toBe('1.4.2 (mixed)');
    expect(assetRegister(world).vehicles.find((v) => v.id === vehicle.vin).firmware).toBe('1.4.2 (mixed)');
  });

  it('a patch for a part the vehicle lacks isn’t offered', () => {
    const world = parked();
    const lean = world.fleet.find((v) => v.hardwareRev === 'lean');
    expect(firmwareView(world, lean.vin).options.map((o) => o.id)).not.toContain('patch-proximity');
  });

  it('a dropped signal changes nothing and resumes', () => {
    const world = parked();
    const vehicle = rich(world);
    const before = versions(vehicle);
    startUpdate(world, vehicle.vin, '1.5.0', 'signal');
    stepUpdate(world, vehicle.vin);
    expect(world.updates[vehicle.vin].index).toBe(0);
    expect(versions(vehicle)).toEqual(before);
    expect(runUpdate(world, vehicle.vin).status).toBe('done');
  });

  it('a power cut on a two-slot part leaves the running copy alone', () => {
    const world = parked();
    const vehicle = rich(world);
    startUpdate(world, vehicle.vin, '1.5.0', 'cut:vcu');
    expect(runUpdate(world, vehicle.vin).status).toBe('done');
    expect(world.updates[vehicle.vin].log.some((e) => /running copy was never touched/.test(e.text))).toBe(true);
  });

  it('a power cut on a recoverable one-slot part retries from the bootloader', () => {
    const world = parked();
    const vehicle = rich(world);
    startUpdate(world, vehicle.vin, '1.5.0', 'cut:bms');
    while (vehicle.firmware.bms.state === 'ok' && world.updates[vehicle.vin].status === 'running') stepUpdate(world, vehicle.vin);
    expect(vehicle.firmware.bms.state).toBe('recovery');
    expect(runUpdate(world, vehicle.vin).status).toBe('done');
    expect(vehicle.firmware.bms.state).toBe('ok');
  });

  it('a power cut with no recovery path needs a technician, and shows as a fault', () => {
    const world = parked();
    const vehicle = rich(world);
    startUpdate(world, vehicle.vin, 'patch-proximity', 'cut:proximity');
    expect(runUpdate(world, vehicle.vin).status).toBe('needs-service');
    const part = vehicleTwin(world, vehicle.vin).components.find((c) => c.id === 'proximity');
    expect(part.state).toBe('fault');
    expect(planUpdate(world, vehicle.vin, '1.5.0').blocked.join()).toMatch(/needs a repair/);
    scheduleRepair(world, vehicle.vin, 'proximity');
    completeService(world, world.serviceOrders.at(-1).id);
    expect(vehicle.firmware.proximity.state).toBe('ok');
    expect(vehicle.firmware.proximity.version).toBe('1.0.1');
  });

  it('a failed health check puts two-slot parts back and leaves a tested combination', () => {
    const world = parked();
    const vehicle = rich(world);
    startUpdate(world, vehicle.vin, '1.5.0', 'health:vcu');
    expect(runUpdate(world, vehicle.vin).status).toBe('reverted');
    expect(vehicle.firmware.vcu.version).toBe('1.4.2');
    expect(vehicle.firmware.inverter.version).toBe('4.0.2');
    expect(vehicle.firmware.bms.version).not.toBe('3.1.0');
    expect(vehicle.version).toBe('1.4.2');
    expect(releaseLabel(vehicle)).toBe('1.4.2 (mixed)');
    expect(firmwareView(world, vehicle.vin).issues).toEqual([]);
  });

  it('a one-slot part that fails its check is reflashed from the cached copy', () => {
    const world = parked();
    const vehicle = rich(world);
    const before = vehicle.firmware.bms.version;
    startUpdate(world, vehicle.vin, '1.5.0', 'health:bms');
    expect(runUpdate(world, vehicle.vin).status).toBe('stopped');
    expect(vehicle.firmware.bms.version).toBe(before);
    expect(vehicle.firmware.vcu.version).toBe('1.4.2');
  });

  it('a stopped update can be tried again', () => {
    const world = parked();
    const vehicle = rich(world);
    startUpdate(world, vehicle.vin, '1.5.0', 'health:vcu');
    runUpdate(world, vehicle.vin);
    startUpdate(world, vehicle.vin, '1.5.0');
    expect(runUpdate(world, vehicle.vin).status).toBe('done');
    expect(releaseLabel(vehicle)).toBe('1.5.0');
  });

  it('every one-slot version works with every tested set', () => {
    const single = TARGETS.filter((t) => t.slots === 1).map((t) => t.id);
    const flat = (release) => Object.fromEntries(Object.entries(release.parts).map(([id, v]) => [id, typeof v === 'string' ? v : v.alpha]));
    for (const a of Object.values(RELEASES)) {
      for (const b of Object.values(RELEASES)) {
        const mix = { ...flat(a), ...Object.fromEntries(single.map((id) => [id, flat(b)[id]])) };
        expect(compatibilityIssues(mix)).toEqual([]);
      }
    }
    expect(PATCHES.length).toBeGreaterThan(0);
  });

  it('can go back to the earlier set', () => {
    const world = parked();
    const vehicle = rich(world);
    startUpdate(world, vehicle.vin, '1.5.0');
    runUpdate(world, vehicle.vin);
    startUpdate(world, vehicle.vin, '1.4.2');
    runUpdate(world, vehicle.vin);
    expect(releaseLabel(vehicle)).toBe('1.4.2');
  });

  it('updates appear in the vehicle’s history', () => {
    const world = parked();
    const { vin } = rich(world);
    startUpdate(world, vin, '1.5.0');
    runUpdate(world, vin);
    expect(assetHistory(world, vin).some((e) => /Release 1.5.0 installed/.test(e.text))).toBe(true);
  });

});
