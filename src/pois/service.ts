import * as Battery from 'expo-battery';
import * as Location from 'expo-location';
import * as Network from 'expo-network';

import { seedCatalog } from '../categories/seed';
import type { Repositories } from '../db/repositories';
import { isCompleteOverpassResponse, OVERPASS_TIMEOUT_SECONDS } from './overpass';
import { syncPoisAround, type Conditions, type PoiSyncOutcome } from './sync';

// Para decidir qué zona bajar alcanza una posición de la última hora: suele ser
// donde el teléfono se carga (casa, trabajo), el «radio habitual» del usuario.
const POSITION_MAX_AGE_MS = 60 * 60_000;

// Instancias públicas de Overpass, en orden de preferencia: si una está caída o
// saturada (pasa seguido) se prueba la siguiente.
const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];
// Margen sobre el timeout que se le pide al servidor, para la transferencia.
const REQUEST_TIMEOUT_MS = (OVERPASS_TIMEOUT_SECONDS + 30) * 1000;

/**
 * Ejecuta una consulta de Overpass probando las instancias públicas en orden.
 *
 * @pre `query` es Overpass QL con salida JSON.
 * @post Devuelve el JSON de la primera instancia que responde 2xx con una
 *       respuesta completa (ver `isCompleteOverpassResponse`).
 * @throws `Error` con el motivo de la última instancia si ninguna respondió bien.
 */
export async function fetchOverpass(query: string): Promise<unknown> {
  let lastError: unknown = null;
  for (const endpoint of OVERPASS_ENDPOINTS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'Zonify/1.0 (com.zonify.app)',
        },
        body: `data=${encodeURIComponent(query)}`,
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`${endpoint} respondió ${response.status}`);
      const body: unknown = await response.json();
      if (!isCompleteOverpassResponse(body)) throw new Error(`${endpoint} devolvió una respuesta incompleta`);
      return body;
    } catch (e) {
      lastError = e;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Overpass no respondió');
}

/**
 * Lee si el teléfono está en Wi-Fi y cargando.
 *
 * @pre Ninguna.
 * @post `wifi` es `true` solo si la red activa es Wi-Fi y conectada; `charging`
 *       es `true` si está enchufado (cargando o con la batería llena). Si algún
 *       dato no se puede leer, cuenta como `false`.
 */
export async function readConditions(): Promise<Conditions> {
  const [network, battery] = await Promise.all([
    Network.getNetworkStateAsync().catch(() => null),
    Battery.getBatteryStateAsync().catch(() => null),
  ]);
  return {
    wifi: network?.type === Network.NetworkStateType.WIFI && network.isConnected === true,
    charging: battery === Battery.BatteryState.CHARGING || battery === Battery.BatteryState.FULL,
  };
}

/**
 * Actualiza el caché de POIs alrededor del usuario si las condiciones lo permiten.
 *
 * @pre Las migraciones están aplicadas.
 * @post Siembra el catálogo de rubros. Sin una posición conocida de la última
 *       hora devuelve `'no-position'` sin descargar; si no, aplica
 *       `syncPoisAround` con el Wi-Fi y la carga actuales.
 * @throws Igual que `syncPoisAround`.
 */
export async function runPoiSync(repos: Repositories): Promise<PoiSyncOutcome | { kind: 'no-position' }> {
  const categoryIds = seedCatalog(repos);
  const last = await Location.getLastKnownPositionAsync({ maxAge: POSITION_MAX_AGE_MS }).catch(() => null);
  if (!last) return { kind: 'no-position' };
  return syncPoisAround(
    { repos, fetchOverpass, categoryIds, now: new Date() },
    last.coords,
    await readConditions(),
  );
}
