import type { Coordinates } from './geo';
import {
  buildReverseUrl,
  buildSearchUrl,
  parsePhotonFeature,
  parsePhotonResponse,
  type PlaceCandidate,
} from './model';

// Photon (komoot) es gratuito y sin clave, con uso razonable: se identifica la
// app y solo se busca con el texto ya escrito (ver usePlaceSearch).
const HEADERS = { Accept: 'application/json', 'User-Agent': 'Zonify/1.0 (com.zonify.app)' };

/**
 * Pide una URL de Photon y devuelve el JSON.
 *
 * @pre `url` es de Photon.
 * @post Devuelve el cuerpo parseado.
 * @throws `AbortError` si `signal` se aborta; `Error` si no hay red o la
 *         respuesta no es 2xx.
 */
async function getJson(url: string, signal?: AbortSignal): Promise<unknown> {
  const response = await fetch(url, { headers: HEADERS, signal });
  if (!response.ok) throw new Error(`El buscador respondió ${response.status}`);
  return response.json();
}

/**
 * Busca comercios, lugares y direcciones que coinciden con un texto.
 *
 * @pre `query` tiene al menos `MIN_QUERY_LENGTH` caracteres útiles.
 * @post Devuelve hasta 8 lugares, priorizando los cercanos a `near` si se indica.
 * @throws Igual que `getJson`.
 */
export async function searchPlaces(
  query: string,
  near: Coordinates | null,
  signal?: AbortSignal,
): Promise<PlaceCandidate[]> {
  return parsePhotonResponse(await getJson(buildSearchUrl(query, near), signal));
}

/**
 * Busca el lugar conocido más cercano a un punto.
 *
 * @pre `point` es válido.
 * @post Devuelve el lugar más cercano según Photon, o `null` si no hay ninguno.
 * @throws Igual que `getJson`.
 */
export async function reverseGeocode(point: Coordinates, signal?: AbortSignal): Promise<PlaceCandidate | null> {
  const body = (await getJson(buildReverseUrl(point), signal)) as { features?: unknown[] } | null;
  const first = Array.isArray(body?.features) ? body.features[0] : undefined;
  return first === undefined ? null : parsePhotonFeature(first);
}
