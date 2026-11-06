// A battery pack is its own asset. It outlives any one vehicle, so identity, health, and history
// belong to the pack. Figures are simulated.
import { hash01 } from '../core/rng.js';
import { DAY, HOUR } from '../core/time.js';

const MIN_SPARE_PACKS = 10;
export const FULL_VOLTS = 54;
export const LOW_HEALTH_PCT = 90;
const CHARGE_HOURS = 4;

export function createPackState(fleet, now) {
  const spares = Math.max(MIN_SPARE_PACKS, Math.round(fleet.length / 6));
  const charging = Math.max(3, Math.round(spares * 0.3));
  const total = fleet.length + spares;
  const packs = Array.from({ length: total }, (_, i) => {
    const id = `P-${1001 + i}`;
    return {
      id,
      vin: fleet[i]?.vin ?? null,
      baseHealthPct: 99.5 - hash01(`${id}:soh`) * 10,
      cycles: Math.round(80 + hash01(`${id}:cycles`) * 620),
      ageDays: Math.round(60 + hash01(`${id}:age`) * 640),
      readyAt: i >= total - charging ? now + (2 + ((i - total + charging) % 3)) * HOUR : null,
    };
  });
  return { packs, packEvents: [] };
}

export const packFor = (world, vehicle) => world.packs.find((pack) => pack.vin === vehicle.vin);

export function packStatus(pack, now) {
  if (pack.vin) return 'INSTALLED';
  return pack.readyAt !== null && now < pack.readyAt ? 'CHARGING' : 'READY';
}

export const readyPacks = (world) => world.packs.filter((pack) => packStatus(pack, world.now) === 'READY');

// Each cycle wears a pack slightly, so swaps show up in its health over time.
export const packHealth = (pack) => Math.round((pack.baseHealthPct - pack.cycles * 0.002) * 10) / 10;

export function lastPackSwap(world, vin, day) {
  return world.packEvents.filter((event) => event.vin === vin && event.day === day).at(-1) ?? null;
}

export function installPack(world, vehicle, packId, day) {
  const incoming = world.packs.find((pack) => pack.id === packId);
  const outgoing = packFor(world, vehicle);
  outgoing.vin = null;
  outgoing.readyAt = world.now + CHARGE_HOURS * HOUR;
  outgoing.cycles += 1;
  incoming.vin = vehicle.vin;
  incoming.readyAt = null;
  world.packEvents.push({ vin: vehicle.vin, removed: outgoing.id, installed: incoming.id, at: world.now, day });
}

export const dayOf = (now) => Math.floor(now / DAY);
