import * as Location from 'expo-location';
import * as Notifications from 'expo-notifications';
import * as TaskManager from 'expo-task-manager';
import { Platform } from 'react-native';

import type { Repositories } from '../db/repositories';
import { ensureZoneAlertsChannel, ZONE_ALERTS_CHANNEL_ID } from '../permissions/service';
import { circleBounds, type Coordinates } from '../places/geo';
import type { GeofenceNotificationData } from './handleEvent';
import {
  GEOFENCE_TASK_NAME,
  MAX_REGIONS,
  planningCenter,
  planRegions,
  POI_SEARCH_RADIUS_METERS,
  regionsSignature,
} from './model';

export type GeofenceSyncStatus = 'unavailable' | 'no-permission' | 'stopped' | 'unchanged' | 'registered';

export interface GeofenceSyncResult {
  status: GeofenceSyncStatus;
  /** Regiones que quedaron registradas en el sistema. */
  count: number;
}

// Tras salir de la centinela el sistema acaba de calcular la posición, así que
// suele haber una reciente; si no, se pide una con precisión de barrio.
const LAST_KNOWN_MAX_AGE_MS = 2 * 60_000;
const FRESH_FIX_TIMEOUT_MS = 20_000;

/**
 * Lee la posición actual con bajo consumo.
 *
 * @pre Hay permiso de ubicación.
 * @post Devuelve la última posición conocida si tiene menos de
 *       `LAST_KNOWN_MAX_AGE_MS`; si no, un fix de precisión media obtenido en
 *       menos de `FRESH_FIX_TIMEOUT_MS`; `null` si no se pudo.
 */
async function readPlanningPosition(): Promise<Coordinates | null> {
  const last = await Location.getLastKnownPositionAsync({ maxAge: LAST_KNOWN_MAX_AGE_MS }).catch(() => null);
  if (last) return last.coords;
  const fresh = await Promise.race([
    Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }).catch(() => null),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), FRESH_FIX_TIMEOUT_MS)),
  ]);
  return fresh?.coords ?? null;
}

/**
 * Alinea las geocercas del sistema operativo con lo que hay que vigilar:
 * lugares propios (US-3.2) y locales cercanos de los rubros con tareas (US-4.2).
 *
 * @pre La tarea `GEOFENCE_TASK_NAME` está definida (se importó `./background`)
 *      y las migraciones están aplicadas.
 * @post Sin TaskManager devuelve `'unavailable'` sin tocar nada. Sin permiso de
 *       ubicación en segundo plano detiene el geofencing (`'no-permission'`).
 *       Si no queda nada que vigilar lo detiene (`'stopped'`). Si las regiones
 *       registradas ya coinciden con `planRegions`, no las vuelve a registrar
 *       (`'unchanged'`): cada registro hace que Android repita el estado actual
 *       de todas. Si no, las reemplaza (`'registered'`). Nunca registra más de
 *       `MAX_REGIONS` de la plataforma.
 * @throws Error de expo-location si el sistema rechaza el registro (p. ej. sin
 *         ubicación precisa en Android).
 */
export async function syncGeofences(repos: Repositories): Promise<GeofenceSyncResult> {
  if (!(await TaskManager.isAvailableAsync())) return { status: 'unavailable', count: 0 };

  const started = await Location.hasStartedGeofencingAsync(GEOFENCE_TASK_NAME);
  const permission = await Location.getBackgroundPermissionsAsync();
  if (!permission.granted) {
    if (started) await Location.stopGeofencingAsync(GEOFENCE_TASK_NAME);
    return { status: 'no-permission', count: 0 };
  }

  const [armed, categoryIds] = await Promise.all([
    repos.geofenceTriggers.listArmed(),
    repos.tasks.pendingCategoryIds(),
  ]);
  const limit = Platform.OS === 'ios' ? MAX_REGIONS.ios : MAX_REGIONS.android;
  const registered = started
    ? ((await TaskManager.getTaskOptionsAsync<{ regions?: unknown }>(GEOFENCE_TASK_NAME).catch(() => null))
        ?.regions ?? null)
    : null;
  const current = categoryIds.length > 0 || armed.length > limit ? await readPlanningPosition() : null;
  const position = current ? planningCenter(registered, current) : null;
  const pois =
    position && categoryIds.length > 0
      ? await repos.pois.listInBounds(circleBounds(position, POI_SEARCH_RADIUS_METERS), categoryIds)
      : [];
  const regions = planRegions({
    places: armed,
    pois,
    categoryTasksActive: categoryIds.length > 0,
    position,
    limit,
  });

  if (regions.length === 0) {
    if (started) await Location.stopGeofencingAsync(GEOFENCE_TASK_NAME);
    return { status: 'stopped', count: 0 };
  }
  if (started && regionsSignature(registered) === regionsSignature(regions)) {
    return { status: 'unchanged', count: regions.length };
  }
  await Location.startGeofencingAsync(GEOFENCE_TASK_NAME, regions);
  return { status: 'registered', count: regions.length };
}

/**
 * Muestra enseguida el aviso de una geocerca.
 *
 * @pre Ninguna.
 * @post En Android el aviso sale por el canal `ZONE_ALERTS_CHANNEL_ID` (que se
 *       crea si falta). Devuelve el id que le asignó el sistema. Si el usuario
 *       no dio permiso de notificaciones, el sistema lo descarta en silencio.
 * @throws Error de expo-notifications si no se pudo programar.
 */
export async function showGeofenceNotification(
  content: { title: string; body: string },
  data: GeofenceNotificationData,
): Promise<string> {
  if (Platform.OS === 'android') await ensureZoneAlertsChannel();
  return Notifications.scheduleNotificationAsync({
    content: { ...content, data: { ...data } },
    trigger: Platform.OS === 'android' ? { channelId: ZONE_ALERTS_CHANNEL_ID } : null,
  });
}
