export interface Coordinates {
  latitude: number;
  longitude: number;
}

/** Rectángulo `[oeste, sur, este, norte]` en grados. */
export type Bounds = [west: number, south: number, east: number, north: number];

/** Polígono GeoJSON (RFC 7946) con un solo anillo; compatible con las fuentes de MapLibre. */
export interface PolygonFeature {
  type: 'Feature';
  properties: Record<string, never>;
  geometry: { type: 'Polygon'; coordinates: [number, number][][] };
}

/** Radio medio de la Tierra en metros (esfera de la IUGG). */
const EARTH_RADIUS_METERS = 6_371_000;

const toRad = (deg: number) => (deg * Math.PI) / 180;
const toDeg = (rad: number) => (rad * 180) / Math.PI;

/**
 * Calcula la distancia sobre la superficie terrestre (fórmula de haversine).
 *
 * @pre Latitudes en [-90, 90] y longitudes en [-180, 180], en grados.
 * @post Devuelve la distancia en metros (≥ 0) entre `a` y `b`.
 */
export function distanceMeters(a: Coordinates, b: Coordinates): number {
  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.latitude)) * Math.cos(toRad(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Punto al que se llega partiendo de `origin` con un rumbo y una distancia.
 *
 * @pre `origin` es válido, `meters` ≥ 0 y `bearingDeg` en grados (0 = norte,
 *      90 = este).
 * @post Devuelve el destino con la longitud normalizada a [-180, 180].
 */
export function destinationPoint(origin: Coordinates, meters: number, bearingDeg: number): Coordinates {
  const angular = meters / EARTH_RADIUS_METERS;
  const bearing = toRad(bearingDeg);
  const lat1 = toRad(origin.latitude);
  const lon1 = toRad(origin.longitude);
  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(angular) + Math.cos(lat1) * Math.sin(angular) * Math.cos(bearing),
  );
  const lon2 =
    lon1 +
    Math.atan2(
      Math.sin(bearing) * Math.sin(angular) * Math.cos(lat1),
      Math.cos(angular) - Math.sin(lat1) * Math.sin(lat2),
    );
  return { latitude: toDeg(lat2), longitude: ((toDeg(lon2) + 540) % 360) - 180 };
}

/**
 * Rumbo inicial para ir de `from` a `to`.
 *
 * @pre Ambos puntos son válidos.
 * @post Devuelve el rumbo en grados, en [0, 360) (0 = norte, 90 = este); 0 si
 *       los puntos coinciden.
 */
export function bearingDegrees(from: Coordinates, to: Coordinates): number {
  const lat1 = toRad(from.latitude);
  const lat2 = toRad(to.latitude);
  const dLon = toRad(to.longitude - from.longitude);
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/**
 * Polígono GeoJSON que aproxima un círculo sobre el mapa, para dibujar una geocerca.
 *
 * @pre `radiusMeters` > 0 y `steps` ≥ 3.
 * @post Devuelve un `PolygonFeature` con `steps` vértices equidistantes del
 *       centro (más el de cierre, igual al primero), en orden [longitud, latitud].
 */
export function circlePolygon(
  center: Coordinates,
  radiusMeters: number,
  steps = 64,
): PolygonFeature {
  const ring: [number, number][] = [];
  for (let i = 0; i < steps; i++) {
    const point = destinationPoint(center, radiusMeters, (i * 360) / steps);
    ring.push([point.longitude, point.latitude]);
  }
  ring.push(ring[0]);
  return { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [ring] } };
}

/**
 * Rectángulo que contiene un círculo, para encuadrarlo con la cámara.
 *
 * @pre `radiusMeters` > 0 y el círculo no cruza el antimeridiano ni los polos.
 * @post Devuelve `[oeste, sur, este, norte]` en grados.
 */
export function circleBounds(center: Coordinates, radiusMeters: number): Bounds {
  const north = destinationPoint(center, radiusMeters, 0).latitude;
  const south = destinationPoint(center, radiusMeters, 180).latitude;
  const east = destinationPoint(center, radiusMeters, 90).longitude;
  const west = destinationPoint(center, radiusMeters, 270).longitude;
  return [west, south, east, north];
}
