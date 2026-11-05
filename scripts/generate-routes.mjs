// Run once: builds street-following delivery loops for central Los Angeles.
// Routing: OSRM public server (best effort, so keep this gentle). Data: OpenStreetMap (ODbL).
// Usage: node scripts/generate-routes.mjs
import { writeFileSync } from 'node:fs';
import { mulberry32 } from '../src/core/rng.js';

const OSRM = 'https://router.project-osrm.org/route/v1/driving';
const HEADERS = { 'User-Agent': 'fleet-lite-route-generator/0.1 (github.com/AerwinApollo01/fleet-lite)' };
const DEPOT = [-118.232, 34.03];
const ROUTE_COUNT = 54;
const MIN_KM = 13;
const MAX_KM = 29;
const PAUSE_MS = 1200;

const AREAS = [
  ['Downtown', -118.255, 34.045],
  ['Chinatown', -118.238, 34.063],
  ['Westlake', -118.275, 34.058],
  ['Koreatown', -118.3, 34.061],
  ['Echo Park', -118.26, 34.078],
  ['Silver Lake', -118.27, 34.087],
  ['Hollywood', -118.325, 34.098],
  ['Mid-City', -118.335, 34.045],
  ['University Park', -118.285, 34.024],
  ['Boyle Heights', -118.205, 34.034],
  ['Lincoln Heights', -118.21, 34.075],
  ['Pico-Union', -118.285, 34.045],
];

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const round = ([lon, lat]) => [Number(lon.toFixed(5)), Number(lat.toFixed(5))];

function stopsFor(area, random, spread, count) {
  const [, lon, lat] = area;
  const start = random() * Math.PI * 2;
  return Array.from({ length: count }, (_, i) => {
    const angle = start + (i / count) * Math.PI * 2;
    const reach = spread * (0.5 + random() * 0.5);
    return [lon + Math.cos(angle) * reach * 1.2, lat + Math.sin(angle) * reach];
  });
}

async function route(points) {
  const coordinates = points.map((p) => p.join(',')).join(';');
  const response = await fetch(`${OSRM}/${coordinates}?overview=full&geometries=geojson`, { headers: HEADERS });
  if (!response.ok) throw new Error(`OSRM returned ${response.status}`);
  const body = await response.json();
  if (body.code !== 'Ok') throw new Error(`OSRM said ${body.code}`);
  return body;
}

// Douglas-Peucker, so the file stays small and still follows the streets.
function simplify(path, tolerance) {
  if (path.length < 3) return path;
  const [ax, ay] = path[0];
  const [bx, by] = path.at(-1);
  const length = Math.hypot(bx - ax, by - ay);
  let furthest = 0;
  let index = 0;
  for (let i = 1; i < path.length - 1; i++) {
    const [x, y] = path[i];
    // A loop starts and ends in the same place, so measure from that point instead of a line.
    const distance = length < 1e-9
      ? Math.hypot(x - ax, y - ay)
      : Math.abs((bx - ax) * (ay - y) - (ax - x) * (by - ay)) / length;
    if (distance > furthest) { furthest = distance; index = i; }
  }
  if (furthest <= tolerance) return [path[0], path.at(-1)];
  return [...simplify(path.slice(0, index + 1), tolerance).slice(0, -1), ...simplify(path.slice(index), tolerance)];
}

const routes = [];
for (let i = 0; i < ROUTE_COUNT; i++) {
  const area = AREAS[i % AREAS.length];
  const random = mulberry32(1000 + i);
  let spread = 0.012;
  let count = 5;
  let result = null;

  for (let attempt = 0; attempt < 5; attempt++) {
    const stops = stopsFor(area, random, spread, count);
    const body = await route([DEPOT, ...stops, DEPOT]);
    await pause(PAUSE_MS);
    const km = body.routes[0].distance / 1000;
    result = { body, km };
    if (km >= MIN_KM && km <= MAX_KM) break;
    if (km > MAX_KM) { spread *= 0.7; count = Math.max(3, count - 1); }
    else { spread *= 1.3; count += 1; }
  }

  const { body, km } = result;
  routes.push({
    id: `R-${String(i + 1).padStart(2, '0')}`,
    area: area[0],
    km: Number(km.toFixed(1)),
    stops: body.waypoints.slice(1, -1).map((w) => round(w.location)),
    path: simplify(body.routes[0].geometry.coordinates, 0.00004).map(round),
  });
  console.log(routes.at(-1).id, area[0], routes.at(-1).km, 'km', routes.at(-1).path.length, 'points');
}

writeFileSync('src/data/la-routes.json', `${JSON.stringify({
  attribution: 'Route geometry derived from OpenStreetMap data, © OpenStreetMap contributors, ODbL 1.0. Routed with OSRM.',
  depot: DEPOT,
  routes,
})}\n`);
