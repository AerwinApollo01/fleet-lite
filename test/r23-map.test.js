import { describe, expect, it } from 'vitest';
import { boundsOf, distanceKm, pathLengthKm, pointAlong, splitPath } from '../src/core/geo.js';
import { createFleetWorld, advanceFleet } from '../src/scenarios/fleet.js';
import { DEPOT, operationsView, ROUTES, routeRow } from '../src/scenarios/operations.js';
import routeData from '../src/data/la-routes.json';

const square = [[0, 0], [0, 0.01], [0.01, 0.01], [0.01, 0], [0, 0]];

describe('geometry', () => {
  it('measures real distance', () => {
    expect(distanceKm([-118.25, 34.05], [-118.25, 34.15])).toBeCloseTo(11.12, 1);
  });

  it('places a point by distance, not by point count', () => {
    const path = [[0, 0], [0, 0.001], [0, 0.01]];
    expect(pointAlong(path, 0.5)[1]).toBeCloseTo(0.005, 5);
  });

  it('handles both ends and out-of-range input', () => {
    expect(pointAlong(square, 0)).toEqual([0, 0]);
    expect(pointAlong(square, 1)).toEqual([0, 0]);
    expect(pointAlong(square, -1)).toEqual([0, 0]);
    expect(pointAlong(square, 2)).toEqual([0, 0]);
  });

  it('splits a path without losing distance', () => {
    const { driven, remaining } = splitPath(square, 0.3);
    expect(pathLengthKm(driven) + pathLengthKm(remaining)).toBeCloseTo(pathLengthKm(square), 6);
    expect(driven.at(-1)).toEqual(remaining[0]);
  });

  it('finds bounds', () => {
    expect(boundsOf([square])).toEqual([[0, 0], [0.01, 0.01]]);
  });
});

describe('R23 routes are real streets, and the map shows what was last reported', () => {
  it('credits the data source', () => {
    expect(routeData.attribution).toMatch(/OpenStreetMap/);
    expect(routeData.attribution).toMatch(/ODbL/);
  });

  it('has a street-following loop for every route, starting and ending at the depot', () => {
    expect(ROUTES).toHaveLength(54);
    for (const route of ROUTES) {
      expect(route.path.length).toBeGreaterThan(20);
      expect(route.stops.length).toBeGreaterThanOrEqual(3);
      expect(distanceKm(route.path[0], DEPOT)).toBeLessThan(0.5);
      expect(distanceKm(route.path.at(-1), DEPOT)).toBeLessThan(0.5);
    }
  });

  it('keeps simplified geometry close to the routed distance', () => {
    for (const route of ROUTES) expect(Math.abs(pathLengthKm(route.path) - route.km) / route.km).toBeLessThan(0.05);
  });

  it('stays in central Los Angeles', () => {
    const [[west, south], [east, north]] = boundsOf(ROUTES.map((r) => r.path));
    expect(west).toBeGreaterThan(-118.4);
    expect(east).toBeLessThan(-118.15);
    expect(south).toBeGreaterThan(33.98);
    expect(north).toBeLessThan(34.13);
  });

  it('names an area for every route', () => {
    for (const route of ROUTES) expect(route.area).toBeTruthy();
    expect(new Set(ROUTES.map((r) => r.area)).size).toBe(12);
  });

  it('moves a connected vehicle along its route', () => {
    const world = createFleetWorld();
    const row = operationsView(world).rows.find((r) => r.vehicle.online);
    const before = row.position;
    advanceFleet(world, 2);
    const after = routeRow(world, row.route.id);
    if (after.vehicle.online) expect(after.position).not.toEqual(before);
  });

  it('shows an offline vehicle where it last reported, not where it should be by now', () => {
    const world = createFleetWorld();
    const row = operationsView(world).rows.find((r) => !r.vehicle.online);
    expect(row.position).toEqual(pointAlong(row.route.path, row.routeDone));
    const expectedNow = (world.now / 60 - 6) / 12;
    expect(row.routeDone).toBeLessThan(expectedNow);
  });

  it('puts every vehicle at the depot before the shift', () => {
    const world = createFleetWorld();
    advanceFleet(world, 10);
    for (const row of operationsView(world).rows) expect(distanceKm(row.position, DEPOT)).toBeLessThan(0.5);
  });
});
