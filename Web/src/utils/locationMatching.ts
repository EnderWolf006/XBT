import type { SignLocation } from '../types';
export type Point = { latitude: number; longitude: number };

export const LOCATION_MATCH_METERS = 150;
export const EARTH_RADIUS_METERS = 6378137;

export function distanceMeters(a: Point, b: Point): number {
  const rad = Math.PI / 180;
  const dLat = (b.latitude - a.latitude) * rad, dLon = (b.longitude - a.longitude) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.latitude * rad) * Math.cos(b.latitude * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.sqrt(Math.min(1, Math.max(0, h))));
}

export function rankEnabledLocations(locations: SignLocation[], point: Point) {
  return locations.filter(item => item.status === 'enabled' && Number.isSafeInteger(item.id) && item.id > 0)
    .map(location => ({ location, distance: distanceMeters(point, location) }))
    .sort((a, b) => a.distance - b.distance || a.location.id - b.location.id);
}

export function nearestEnabledLocation(locations: SignLocation[], point: Point) {
  const nearest = rankEnabledLocations(locations, point)[0];
  return nearest && nearest.distance <= LOCATION_MATCH_METERS ? nearest.location : null;
}
