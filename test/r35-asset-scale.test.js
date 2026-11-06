import { describe, expect, it } from 'vitest';
import { assetRegister } from '../src/scenarios/assets.js';
import { queryAssets, VIEWS } from '../src/scenarios/assetquery.js';
import { availableSpares } from '../src/scenarios/operations.js';
import { createFleetWorld, resetFleet } from '../src/scenarios/fleet.js';

const big = createFleetWorld(5000);
const { vehicles, packs } = assetRegister(big);

describe('R35 a large fleet stays quick to work through', () => {
  it('only one page of rows comes back, however large the fleet', () => {
    const result = queryAssets(vehicles, 'vehicles', { pageSize: 50 });
    expect(result.rows).toHaveLength(50);
    expect(result.total).toBe(5000);
    expect(result.pages).toBe(100);
  });

  it('pages cover every row exactly once', () => {
    const seen = [];
    for (let page = 1; page <= 100; page++) seen.push(...queryAssets(vehicles, 'vehicles', { page, pageSize: 50 }).rows.map((row) => row.id));
    expect(new Set(seen).size).toBe(5000);
  });

  it('a page past the end falls back to the last real page', () => {
    const result = queryAssets(vehicles, 'vehicles', { page: 999, pageSize: 50 });
    expect(result.page).toBe(100);
    expect(result.rows.length).toBeGreaterThan(0);
  });

  it('puts the worst vehicles first by default', () => {
    const { rows } = queryAssets(vehicles, 'vehicles', { pageSize: 5 });
    expect(rows.every((row) => row.condition === 'fault')).toBe(true);
  });

  it('sorts IDs as numbers, so V-097 comes before V-1000', () => {
    const { ids } = queryAssets(vehicles, 'vehicles', { sort: { key: 'id', dir: 'asc' } });
    expect(ids.indexOf('V-097')).toBeLessThan(ids.indexOf('V-1000'));
  });

  it('finds one vehicle by exact ID among thousands', () => {
    const { ids } = queryAssets(vehicles, 'vehicles', { search: 'v-4321' });
    expect(ids).toEqual(['V-4321']);
  });

  it('every search word has to match', () => {
    const { ids } = queryAssets(vehicles, 'vehicles', { search: 'bravo lean' });
    const rows = vehicles.filter((v) => ids.includes(v.id));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((v) => v.supplier === 'Supplier Bravo' && v.hardware === 'Lean BOM')).toBe(true);
  });

  it('ticks in one facet widen, and ticks across facets narrow', () => {
    const one = queryAssets(vehicles, 'vehicles', { filters: { depot: ['Burbank'] } }).total;
    const two = queryAssets(vehicles, 'vehicles', { filters: { depot: ['Burbank', 'Irvine'] } }).total;
    const narrowed = queryAssets(vehicles, 'vehicles', { filters: { depot: ['Burbank'], signal: ['No signal'] } }).total;
    expect(two).toBeGreaterThan(one);
    expect(narrowed).toBeLessThan(one);
  });

  it('a facet count is what you get by ticking it', () => {
    const { facets } = queryAssets(vehicles, 'vehicles', { filters: { signal: ['No signal'] } });
    const option = facets.find((facet) => facet.id === 'depot').options[0];
    const ticked = queryAssets(vehicles, 'vehicles', { filters: { signal: ['No signal'], depot: [option.value] } });
    expect(ticked.total).toBe(option.count);
  });

  it('a facet keeps its other options after one is ticked', () => {
    const { facets } = queryAssets(vehicles, 'vehicles', { filters: { depot: ['Burbank'] } });
    expect(facets.find((facet) => facet.id === 'depot').options.length).toBeGreaterThan(1);
  });

  it('a vehicle with two flagged parts counts under both', () => {
    const vehicle = vehicles.find((v) => v.flagged.length >= 2);
    expect(vehicle).toBeDefined();
    const { facets } = queryAssets([vehicle], 'vehicles');
    expect(facets.find((facet) => facet.id === 'component').options).toHaveLength(vehicle.flagged.length);
  });

  it('saved views match real rows for vehicles and packs', () => {
    for (const [kind, rows] of [['vehicles', vehicles], ['packs', packs]]) {
      for (const view of VIEWS[kind]) expect(queryAssets(rows, kind, { filters: view.filters }).total).toBeGreaterThan(0);
    }
  });

  it('searches routes only when the persona may see them', () => {
    const small = assetRegister(createFleetWorld());
    const row = small.vehicles.find((v) => v.routeId);
    expect(queryAssets(small.vehicles, 'vehicles', { search: row.routeId, searchRoutes: true }).total).toBeGreaterThan(0);
    expect(queryAssets(small.vehicles, 'vehicles', { search: row.routeId }).total).toBe(0);
  });

  it('a larger fleet keeps the mapped routes and their spares the same', () => {
    const small = createFleetWorld();
    expect(availableSpares(big).map((v) => v.vin)).toEqual(availableSpares(small).map((v) => v.vin));
  });

  it('spare packs grow with the fleet, and every vehicle has one pack', () => {
    expect(packs.length).toBeGreaterThan(5000);
    expect(new Set(vehicles.map((v) => v.packId)).size).toBe(5000);
    expect(packs.filter((p) => p.status === 'Ready').length).toBeGreaterThan(50);
  });

  it('changing the fleet size restarts the simulation and keeps the persona', () => {
    const world = createFleetWorld();
    world.role = 'technician';
    resetFleet(world, 1000);
    expect(world.fleet).toHaveLength(1000);
    expect(world.role).toBe('technician');
  });
});
