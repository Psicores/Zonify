import { slugsForOsmTags, type CatalogCategory } from '../categories/catalog';
import type { Bounds } from '../places/geo';

/** Local de OpenStreetMap ya asignado a un rubro, listo para el caché. */
export interface ParsedPoi {
  /** Tipo (`n`, `w`, `r`) e id del elemento de OSM. */
  osmKey: string;
  slug: string;
  name: string | null;
  address: string | null;
  latitude: number;
  longitude: number;
}

/** Tiempo máximo que se le pide al servidor de Overpass, en segundos. */
export const OVERPASS_TIMEOUT_SECONDS = 60;

/**
 * Resumen de las etiquetas de un catálogo, para saber si una zona del caché se
 * bajó con las etiquetas actuales.
 *
 * @pre Ninguna.
 * @post Devuelve las etiquetas `clave=valor` ordenadas y separadas por `;`; el
 *       orden del catálogo no influye.
 */
export function catalogSignature(catalog: readonly CatalogCategory[]): string {
  return [...new Set(catalog.flatMap((c) => c.tags.map((t) => `${t.key}=${t.value}`)))].sort().join(';');
}

/**
 * Escapa un valor para usarlo dentro de una expresión regular de Overpass.
 *
 * @pre Ninguna.
 * @post Devuelve `value` con los metacaracteres de regex y las comillas escapados.
 */
function escapeRegex(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|"]/g, '\\$&');
}

/**
 * Arma la consulta de Overpass QL que trae los locales del catálogo en una zona.
 *
 * @pre `catalog` no está vacío; `bounds` es un rectángulo válido que no cruza el
 *      antimeridiano.
 * @post Devuelve una consulta con una cláusula por clave de OSM (con una regex
 *       que une sus valores, más rápida que una cláusula por etiqueta), para
 *       nodos, vías y relaciones; las vías y relaciones vuelven con su centro.
 */
export function buildOverpassQuery(catalog: readonly CatalogCategory[], bounds: Bounds): string {
  const [west, south, east, north] = bounds;
  const bbox = [south, west, north, east].map((n) => n.toFixed(6)).join(',');
  const valuesByKey = new Map<string, Set<string>>();
  for (const tag of catalog.flatMap((c) => c.tags)) {
    const values = valuesByKey.get(tag.key) ?? new Set<string>();
    values.add(tag.value);
    valuesByKey.set(tag.key, values);
  }
  const clauses = [...valuesByKey.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, values]) => {
      const regex = [...values].sort().map(escapeRegex).join('|');
      return `nwr["${key}"~"^(${regex})$"](${bbox});`;
    });
  return `[out:json][timeout:${OVERPASS_TIMEOUT_SECONDS}];(${clauses.join('')});out center tags;`;
}

interface OverpassElement {
  type?: unknown;
  id?: unknown;
  lat?: unknown;
  lon?: unknown;
  center?: { lat?: unknown; lon?: unknown };
  tags?: Record<string, unknown>;
}

/**
 * Devuelve un texto de etiqueta de OSM si existe y no está vacío.
 *
 * @pre Ninguna.
 * @post Devuelve el valor recortado, o `null` si no es un texto con contenido.
 */
function tagText(tags: Record<string, unknown>, key: string): string | null {
  const value = tags[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * Convierte la respuesta de Overpass en locales por rubro.
 *
 * @pre Ninguna (la respuesta viene de la red).
 * @post Devuelve una entrada por cada (elemento, rubro del catálogo) con
 *       coordenadas válidas: las de un nodo o el centro de una vía/relación.
 *       `name` es `name` (o `brand`) y `address` es «calle número» si OSM la
 *       tiene. Ignora elementos sin coordenadas o sin rubro, y no repite
 *       (`osmKey`, `slug`). Si la respuesta no es una lista de elementos devuelve vacío.
 */
export function parseOverpassResponse(body: unknown): ParsedPoi[] {
  const elements = (body as { elements?: unknown } | null)?.elements;
  if (!Array.isArray(elements)) return [];

  const seen = new Set<string>();
  const result: ParsedPoi[] = [];
  for (const raw of elements as OverpassElement[]) {
    const type = raw?.type;
    if ((type !== 'node' && type !== 'way' && type !== 'relation') || typeof raw.id !== 'number') continue;
    const latitude = type === 'node' ? raw.lat : raw.center?.lat;
    const longitude = type === 'node' ? raw.lon : raw.center?.lon;
    if (typeof latitude !== 'number' || typeof longitude !== 'number') continue;
    if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) continue;

    const tags = raw.tags ?? {};
    const street = tagText(tags, 'addr:street');
    const number = tagText(tags, 'addr:housenumber');
    const osmKey = `${type[0]}${raw.id}`;
    for (const slug of slugsForOsmTags(tags)) {
      const key = `${osmKey}/${slug}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({
        osmKey,
        slug,
        name: tagText(tags, 'name') ?? tagText(tags, 'brand'),
        address: street ? (number ? `${street} ${number}` : street) : null,
        latitude,
        longitude,
      });
    }
  }
  return result;
}

/**
 * Indica si una respuesta de Overpass está completa.
 *
 * @pre Ninguna (la respuesta viene de la red).
 * @post Devuelve `false` si no tiene lista `elements` o si trae un `remark` de
 *       error (Overpass corta por tiempo o memoria, responde 200 y deja los
 *       datos a medias); `true` en otro caso.
 */
export function isCompleteOverpassResponse(body: unknown): boolean {
  const { elements, remark } = (body ?? {}) as { elements?: unknown; remark?: unknown };
  if (!Array.isArray(elements)) return false;
  return !(typeof remark === 'string' && /error|timed out|out of memory/i.test(remark));
}
