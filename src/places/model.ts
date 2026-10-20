import { distanceMeters, type Coordinates } from './geo';

/** Radios rápidos del selector, en metros. */
export const RADIUS_PRESETS = [100, 200, 500] as const;
export const DEFAULT_RADIUS_METERS = 200;
// Por debajo de ~100 m las geocercas de Android e iOS fallan seguido; por
// encima de 2 km el aviso deja de ser «estás ahí».
export const MIN_RADIUS_METERS = 100;
export const MAX_RADIUS_METERS = 2000;

/**
 * Distancia máxima entre el punto presionado y el lugar conocido más cercano
 * para tomar ese lugar en vez del punto exacto.
 */
export const SNAP_DISTANCE_METERS = 40;
/** Hasta esta distancia el lugar más cercano sirve como referencia del punto elegido. */
export const NEARBY_LABEL_METERS = 150;

/** Largo mínimo del texto antes de buscar, para no pedir resultados de una letra. */
export const MIN_QUERY_LENGTH = 3;

const PHOTON_BASE_URL = 'https://photon.komoot.io';

/** Lugar elegido o candidato a elegir: un POI, una dirección o un punto del mapa. */
export interface PlaceCandidate {
  /** Identificador estable del resultado (p. ej. `N123` para un nodo de OSM). */
  key: string;
  /** Nombre comercial, o la dirección si el lugar no tiene nombre. */
  name: string;
  /** Dirección legible, sin repetir `name`; `null` si no se conoce. */
  address: string | null;
  latitude: number;
  longitude: number;
}

/** Propiedades de un resultado de Photon que usa la app (el resto se ignora). */
interface PhotonProperties {
  osm_type?: string;
  osm_id?: number;
  name?: string;
  housenumber?: string;
  street?: string;
  locality?: string;
  district?: string;
  city?: string;
  state?: string;
  country?: string;
}

interface PhotonFeature {
  properties?: PhotonProperties;
  geometry?: { type?: string; coordinates?: unknown };
}

/**
 * Ajusta un radio a los límites admitidos.
 *
 * @pre `meters` es un número finito.
 * @post Devuelve `meters` redondeado a decenas y acotado a
 *       [`MIN_RADIUS_METERS`, `MAX_RADIUS_METERS`].
 */
export function clampRadius(meters: number): number {
  const rounded = Math.round(meters / 10) * 10;
  return Math.min(MAX_RADIUS_METERS, Math.max(MIN_RADIUS_METERS, rounded));
}

/**
 * Arma la URL de autocompletado de Photon.
 *
 * @pre `query` no está vacío.
 * @post Devuelve la URL con el texto codificado, `limit` resultados y, si hay
 *       `near`, los resultados priorizados cerca de esa posición.
 */
export function buildSearchUrl(query: string, near: Coordinates | null, limit = 8): string {
  const params = new URLSearchParams({ q: query.trim(), limit: String(limit) });
  if (near) {
    params.set('lat', near.latitude.toFixed(5));
    params.set('lon', near.longitude.toFixed(5));
  }
  return `${PHOTON_BASE_URL}/api/?${params.toString()}`;
}

/**
 * Arma la URL de geocodificación inversa de Photon (punto → lugar).
 *
 * @pre `point` es válido.
 * @post Devuelve la URL que pide el lugar más cercano a `point`.
 */
export function buildReverseUrl(point: Coordinates): string {
  const params = new URLSearchParams({
    lat: point.latitude.toFixed(6),
    lon: point.longitude.toFixed(6),
    limit: '1',
  });
  return `${PHOTON_BASE_URL}/reverse?${params.toString()}`;
}

/**
 * Une partes de texto en una dirección, sin vacíos ni repetidos.
 *
 * @pre Ninguna.
 * @post Devuelve las partes no vacías, en orden y sin repetir (ignorando
 *       mayúsculas), separadas por «, »; `null` si no queda ninguna.
 */
function joinParts(parts: (string | undefined | null)[]): string | null {
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const part of parts) {
    const text = part?.trim();
    if (!text || seen.has(text.toLowerCase())) continue;
    seen.add(text.toLowerCase());
    kept.push(text);
  }
  return kept.length > 0 ? kept.join(', ') : null;
}

/**
 * Convierte un resultado de Photon en un lugar de la app.
 *
 * @pre Ninguna (acepta cualquier valor, viene de la red).
 * @post Devuelve `null` si no es un punto con coordenadas válidas o si no tiene
 *       nombre, calle ni ciudad con qué nombrarlo. Si no, `name` es el nombre del
 *       POI (o «calle número» si no tiene, o la ciudad) y `address` la calle con
 *       número, barrio y ciudad, sin repetir lo que ya dice `name`.
 */
export function parsePhotonFeature(feature: unknown): PlaceCandidate | null {
  const { properties: p = {}, geometry } = (feature ?? {}) as PhotonFeature;
  const coords = geometry?.type === 'Point' ? geometry.coordinates : null;
  if (!Array.isArray(coords) || coords.length < 2) return null;
  const [longitude, latitude] = coords as [unknown, unknown];
  if (typeof latitude !== 'number' || typeof longitude !== 'number') return null;
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;

  const streetLine = p.street?.trim() ? `${p.street.trim()}${p.housenumber ? ` ${p.housenumber}` : ''}` : null;
  const name = p.name?.trim() || streetLine || p.city?.trim() || p.locality?.trim();
  if (!name) return null;

  const area = [p.locality ?? p.district, p.city ?? p.state].filter(
    (part) => part?.trim().toLowerCase() !== name.toLowerCase(),
  );
  const address = joinParts([streetLine === name ? null : streetLine, ...area]);

  const key = p.osm_type && p.osm_id !== undefined ? `${p.osm_type}${p.osm_id}` : `${latitude},${longitude}`;
  return { key, name, address, latitude, longitude };
}

/**
 * Convierte la respuesta completa de Photon en lugares.
 *
 * @pre Ninguna (acepta cualquier valor, viene de la red).
 * @post Devuelve los resultados válidos según `parsePhotonFeature`, en el orden
 *       recibido y sin repetir `key`; vacío si la respuesta no es una colección.
 */
export function parsePhotonResponse(body: unknown): PlaceCandidate[] {
  const features = (body as { features?: unknown } | null)?.features;
  if (!Array.isArray(features)) return [];
  const byKey = new Map<string, PlaceCandidate>();
  for (const feature of features) {
    const place = parsePhotonFeature(feature);
    if (place && !byKey.has(place.key)) byKey.set(place.key, place);
  }
  return [...byKey.values()];
}

/**
 * Lugar para un punto del mapa que no coincide con nada conocido.
 *
 * @pre `point` es válido.
 * @post Devuelve un lugar llamado «Punto en el mapa» con las coordenadas como dirección.
 */
export function pinnedPoint(point: Coordinates): PlaceCandidate {
  const latitude = Number(point.latitude.toFixed(6));
  const longitude = Number(point.longitude.toFixed(6));
  return {
    key: `${latitude},${longitude}`,
    name: 'Punto en el mapa',
    address: `${latitude.toFixed(5)}, ${longitude.toFixed(5)}`,
    latitude,
    longitude,
  };
}

/**
 * Decide qué lugar queda elegido al mantener presionado un punto del mapa.
 *
 * @pre `point` es válido.
 * @post Si `nearest` está a `SNAP_DISTANCE_METERS` o menos, devuelve `nearest`
 *       (el usuario apuntó a ese comercio). Si no, devuelve el punto exacto como
 *       `pinnedPoint`; si `nearest` está a `NEARBY_LABEL_METERS` o menos, la
 *       dirección pasa a ser «Cerca de <nombre>».
 */
export function resolvePressedPoint(point: Coordinates, nearest: PlaceCandidate | null): PlaceCandidate {
  const distance = nearest ? distanceMeters(point, nearest) : Infinity;
  if (nearest && distance <= SNAP_DISTANCE_METERS) return nearest;
  const pinned = pinnedPoint(point);
  return nearest && distance <= NEARBY_LABEL_METERS ? { ...pinned, address: `Cerca de ${nearest.name}` } : pinned;
}
