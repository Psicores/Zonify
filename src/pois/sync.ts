import { CATEGORY_CATALOG } from '../categories/catalog';
import type { Repositories } from '../db/repositories';
import type { PoiArea } from '../db/schema';
import { circleBounds, distanceMeters, type Coordinates } from '../places/geo';
import { buildOverpassQuery, catalogSignature, parseOverpassResponse } from './overpass';

/** Radio de cada zona que se descarga alrededor del usuario («radio habitual»). */
export const AREA_RADIUS_METERS = 3000;
/**
 * Una zona cubre al usuario si está a esta distancia o más del borde: así las
 * geocercas de rubro alrededor suyo salen siempre de datos descargados.
 */
export const COVERAGE_MARGIN_METERS = 1000;
/** Antigüedad a partir de la cual una zona se vuelve a bajar (si hay Wi-Fi y carga). */
export const REFRESH_AFTER_MS = 7 * 24 * 60 * 60_000;
/** Lo descargado hace más de esto se borra. */
export const RETENTION_MS = 60 * 24 * 60 * 60_000;

export type AreaStatus = 'fresh' | 'stale' | 'missing';

export interface Conditions {
  wifi: boolean;
  charging: boolean;
}

/**
 * Estado del caché en la posición del usuario.
 *
 * @pre Ninguna.
 * @post Considera solo las zonas bajadas con `signature` que cubren `position`
 *       (centro a `AREA_RADIUS - COVERAGE_MARGIN` o menos). Devuelve `'fresh'` si
 *       alguna tiene menos de `REFRESH_AFTER_MS`, `'stale'` si solo hay viejas y
 *       `'missing'` si no hay ninguna.
 */
export function areaStatus(
  areas: readonly PoiArea[],
  position: Coordinates,
  signature: string,
  now: Date,
): AreaStatus {
  const covering = areas.filter(
    (area) =>
      area.catalogSignature === signature &&
      distanceMeters(position, { latitude: area.centerLatitude, longitude: area.centerLongitude }) <=
        area.radiusMeters - COVERAGE_MARGIN_METERS,
  );
  if (covering.length === 0) return 'missing';
  return covering.some((area) => now.getTime() - area.fetchedAt.getTime() < REFRESH_AFTER_MS)
    ? 'fresh'
    : 'stale';
}

/**
 * Decide si conviene descargar la zona ahora.
 *
 * @pre Ninguna.
 * @post Nunca sin Wi-Fi. Una zona que falta se baja con Wi-Fi aunque el
 *       teléfono no esté cargando (sin ella los recordatorios por rubro no
 *       funcionan); una vieja se refresca solo con Wi-Fi y cargando. Una al día
 *       no se baja.
 */
export function shouldDownload(status: AreaStatus, conditions: Conditions): boolean {
  if (!conditions.wifi || status === 'fresh') return false;
  return status === 'missing' || conditions.charging;
}

export interface PoiSyncDeps {
  repos: Repositories;
  /** Ejecuta una consulta de Overpass y devuelve el JSON. */
  fetchOverpass: (query: string) => Promise<unknown>;
  /** Id de la categoría de cada `slug` del catálogo (ver `seedCatalog`). */
  categoryIds: ReadonlyMap<string, number>;
  now: Date;
}

export type PoiSyncOutcome =
  | { kind: 'skipped'; status: AreaStatus }
  | { kind: 'downloaded'; status: AreaStatus; poiCount: number };

/**
 * Descarga, si corresponde, los locales del catálogo alrededor de una posición.
 *
 * @pre Las migraciones están aplicadas y el catálogo sembrado (`categoryIds`).
 * @post Si `shouldDownload` dice que no, no escribe nada (`'skipped'`). Si no,
 *       baja los locales de la zona de `AREA_RADIUS_METERS` alrededor de
 *       `position`, los guarda con `saveArea` (reemplazando los de esa zona) y
 *       borra lo bajado hace más de `RETENTION_MS` (`'downloaded'`).
 * @throws El error de `fetchOverpass` o de la base; en ese caso no cambia nada.
 */
export async function syncPoisAround(
  deps: PoiSyncDeps,
  position: Coordinates,
  conditions: Conditions,
): Promise<PoiSyncOutcome> {
  const { repos, fetchOverpass, categoryIds, now } = deps;
  const signature = catalogSignature(CATEGORY_CATALOG);
  const status = areaStatus(await repos.pois.listAreas(), position, signature, now);
  if (!shouldDownload(status, conditions)) return { kind: 'skipped', status };

  const bounds = circleBounds(position, AREA_RADIUS_METERS);
  const parsed = parseOverpassResponse(await fetchOverpass(buildOverpassQuery(CATEGORY_CATALOG, bounds)));
  const items = parsed.flatMap(({ slug, ...poi }) => {
    const categoryId = categoryIds.get(slug);
    return categoryId === undefined ? [] : [{ ...poi, categoryId }];
  });

  repos.pois.saveArea(
    {
      centerLatitude: position.latitude,
      centerLongitude: position.longitude,
      radiusMeters: AREA_RADIUS_METERS,
      catalogSignature: signature,
      poiCount: items.length,
      fetchedAt: now,
    },
    bounds,
    [...categoryIds.values()],
    items,
  );
  repos.pois.prune(new Date(now.getTime() - RETENTION_MS));
  return { kind: 'downloaded', status, poiCount: items.length };
}
