import * as Location from 'expo-location';
import * as Notifications from 'expo-notifications';
import * as TaskManager from 'expo-task-manager';
import { Platform } from 'react-native';

import type { Repositories } from '../db/repositories';
import { ALERT_CATEGORY_ID, ensureNotificationSetup } from '../notifications/setup';
import {
  ZONE_ALERTS_CHANNEL_ID,
  ZONE_ALERTS_SILENT_CHANNEL_ID,
  ZONE_ALERTS_VIBRATION,
} from '../permissions/service';
import { circleBounds } from '../places/geo';
import { getLastPlanningFix, setLastPlanningFix } from '../settings/appSettings';
import type { GeofenceNotificationData } from './handleEvent';
import {
  classifyMotion,
  estimateSpeed,
  GEOFENCE_TASK_NAME,
  MAX_REGIONS,
  planningCenter,
  planRegions,
  POI_SEARCH_RADIUS_METERS,
  regionsSignature,
  type MotionFix,
  type MotionMode,
} from './model';

export type GeofenceSyncStatus = 'unavailable' | 'no-permission' | 'stopped' | 'unchanged' | 'registered';

export interface GeofenceSyncResult {
  status: GeofenceSyncStatus;
  /** Regiones que quedaron registradas en el sistema. */
  count: number;
  /** Movimiento estimado al planificar (US-7.1); `'unknown'` si no hizo falta posición. */
  motion?: MotionMode;
}

// Tras salir de la centinela el sistema acaba de calcular la posición, así que
// suele haber una reciente; si no, se pide una con precisión de barrio.
const LAST_KNOWN_MAX_AGE_MS = 2 * 60_000;
const FRESH_FIX_TIMEOUT_MS = 20_000;

/**
 * Convierte una posición de expo-location en `MotionFix`.
 *
 * @pre Ninguna.
 * @post Copia coordenadas, velocidad (`null` si el sistema no la sabe) y momento.
 */
function toMotionFix(location: Location.LocationObject): MotionFix {
  const { latitude, longitude, speed } = location.coords;
  return { latitude, longitude, speed: speed ?? null, at: location.timestamp };
}

/**
 * Última posición conocida, si es reciente.
 *
 * @pre Ninguna.
 * @post Devuelve la posición de hace como mucho `LAST_KNOWN_MAX_AGE_MS`, o `null`.
 */
export async function readRecentFix(): Promise<MotionFix | null> {
  const last = await Location.getLastKnownPositionAsync({ maxAge: LAST_KNOWN_MAX_AGE_MS }).catch(() => null);
  return last ? toMotionFix(last) : null;
}

/**
 * Lee la posición actual con bajo consumo.
 *
 * @pre Hay permiso de ubicación.
 * @post Devuelve `readRecentFix` si hay; si no, un fix de precisión media
 *       obtenido en menos de `FRESH_FIX_TIMEOUT_MS`; `null` si no se pudo.
 */
async function readPlanningPosition(): Promise<MotionFix | null> {
  const recent = await readRecentFix();
  if (recent) return recent;
  const fresh = await Promise.race([
    Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }).catch(() => null),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), FRESH_FIX_TIMEOUT_MS)),
  ]);
  return fresh ? toMotionFix(fresh) : null;
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
 *       `MAX_REGIONS` de la plataforma. Cuando lee la posición, estima el
 *       movimiento con la anterior (US-7.1), elige los radios según él y guarda
 *       la posición para la próxima estimación.
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
  let motion: MotionMode = 'unknown';
  if (current) {
    motion = classifyMotion(estimateSpeed(current, await getLastPlanningFix(repos)));
    await setLastPlanningFix(repos, { latitude: current.latitude, longitude: current.longitude, at: current.at });
  }
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
    motion,
  });

  if (regions.length === 0) {
    if (started) await Location.stopGeofencingAsync(GEOFENCE_TASK_NAME);
    return { status: 'stopped', count: 0, motion };
  }
  if (started && regionsSignature(registered) === regionsSignature(regions)) {
    return { status: 'unchanged', count: regions.length, motion };
  }
  await Location.startGeofencingAsync(GEOFENCE_TASK_NAME, regions);
  return { status: 'registered', count: regions.length, motion };
}

/**
 * Muestra enseguida el aviso de una geocerca.
 *
 * @pre Ninguna.
 * @post El aviso lleva los botones «Hecho» y «Posponer 2 h» (`ALERT_CATEGORY_ID`)
 *       y `data` para abrir o resolver las tareas. Con `data.silent` no suena ni
 *       vibra: en Android sale por el canal de importancia baja y en iOS como
 *       `passive`; si no, suena y vibra (`ZONE_ALERTS_VIBRATION`). Canales y
 *       categoría se crean si faltan. Devuelve el id que le asignó el sistema.
 *       Si el usuario no dio permiso de notificaciones, el sistema lo descarta.
 * @throws Error de expo-notifications si no se pudo programar.
 */
export async function showGeofenceNotification(
  content: { title: string; body: string },
  data: GeofenceNotificationData,
): Promise<string> {
  await ensureNotificationSetup();
  const channelId = data.silent ? ZONE_ALERTS_SILENT_CHANNEL_ID : ZONE_ALERTS_CHANNEL_ID;
  return Notifications.scheduleNotificationAsync({
    content: {
      ...content,
      data: { ...data },
      categoryIdentifier: ALERT_CATEGORY_ID,
      sound: !data.silent,
      vibrate: data.silent ? undefined : ZONE_ALERTS_VIBRATION,
      interruptionLevel: data.silent ? 'passive' : 'active',
    },
    trigger: Platform.OS === 'android' ? { channelId } : null,
  });
}
