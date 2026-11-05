// Position along a route, measured in real distance rather than point count.
const EARTH_KM = 6371;
const radians = (degrees) => (degrees * Math.PI) / 180;

export function distanceKm([lon1, lat1], [lon2, lat2]) {
  const dLat = radians(lat2 - lat1);
  const dLon = radians(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(radians(lat1)) * Math.cos(radians(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.sqrt(a));
}

export function pathLengthKm(path) {
  return path.slice(1).reduce((sum, point, i) => sum + distanceKm(path[i], point), 0);
}

export function splitPath(path, fraction) {
  const target = Math.min(1, Math.max(0, fraction)) * pathLengthKm(path);
  let travelled = 0;
  for (let i = 1; i < path.length; i++) {
    const step = distanceKm(path[i - 1], path[i]);
    if (travelled + step >= target) {
      const t = step === 0 ? 0 : (target - travelled) / step;
      const [ax, ay] = path[i - 1];
      const [bx, by] = path[i];
      const point = [ax + (bx - ax) * t, ay + (by - ay) * t];
      return { point, driven: [...path.slice(0, i), point], remaining: [point, ...path.slice(i)] };
    }
    travelled += step;
  }
  const point = path.at(-1);
  return { point, driven: path, remaining: [point] };
}

export const pointAlong = (path, fraction) => splitPath(path, fraction).point;

export function boundsOf(paths) {
  const points = paths.flat();
  const lons = points.map(([lon]) => lon);
  const lats = points.map(([, lat]) => lat);
  return [[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]];
}

export const insideZone = (point, zone) => distanceKm(point, zone.center) <= zone.radiusKm;

// A circle as a map polygon, corrected for longitude shrinking away from the equator.
export function circlePolygon({ center: [lon, lat], radiusKm }, sides = 48) {
  const latDegrees = radiusKm / 111.32;
  const lonDegrees = latDegrees / Math.cos(radians(lat));
  return Array.from({ length: sides + 1 }, (_, i) => {
    const angle = (i / sides) * Math.PI * 2;
    return [lon + Math.cos(angle) * lonDegrees, lat + Math.sin(angle) * latDegrees];
  });
}
