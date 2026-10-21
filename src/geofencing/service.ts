import * as Location from 'expo-location';
import * as Notifications from 'expo-notifications';
import * as TaskManager from 'expo-task-manager';
import { Platform } from 'react-native';

import { syncQueue } from '../background/serial';
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
  ALERT_MAX_ACCURACY_METERS,
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
// Para confirmar un aviso: una posición de hace más de 30 s ya puede estar a
// 40 m caminando; y una nueva no puede demorar el aviso más de 15 s.
const ALERT_FIX_MAX_AGE_MS = 30_000;
const ALERT_FIX_TIMEOUT_MS = 15_000;

/**
 * Convierte una posición de expo-location en `MotionFix`.
 *
 * @pre Ninguna.
 * @post Copia coordenadas, velocidad (`null` si el sistema no la sabe) y momento.
 */
function toMotionFix(location: Location.LocationObject): MotionFix {
  const { latitude, longitude, speed, accuracy } = location.coords;
  return { latitude, longitude, speed: speed ?? null, accuracy: accuracy ?? null, at: location.timestamp };
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
 * Posición para confirmar que el usuario está cerca antes de avisar.
 *
 * @pre Hay permiso de ubicación.
 * @post Devuelve la última posición conocida si es de hace `ALERT_FIX_MAX_AGE_MS`
 *       o menos y su error no supera `ALERT_MAX_ACCURACY_METERS` (suele ser la
 *       que acaba de calcular el sistema para la geocerca). Si no, pide una de
 *       alta precisión que tarde como mucho `ALERT_FIX_TIMEOUT_MS`; si tampoco
 *       llega, devuelve `readRecentFix` (aunque sea imprecisa) o `null`.
 */
export async function readAlertFix(): Promise<MotionFix | null> {
  const precise = await Location.getLastKnownPositionAsync({
    maxAge: ALERT_FIX_MAX_AGE_MS,
    requiredAccuracy: ALERT_MAX_ACCURACY_METERS,
  }).catch(() => null);
  if (precise) return toMotionFix(precise);
  const fresh = await Promise.race([
    Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High }).catch(() => null),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), ALERT_FIX_TIMEOUT_MS)),
  ]);
  return fresh ? toMotionFix(fresh) : readRecentFix();
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
async function syncGeofencesNow(repos: Repositories): Promise<GeofenceSyncResult> {
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
 * Alinea las geocercas del sistema operativo, de a una sincronización por vez
 * (US-2.1).
 *
 * @pre Igual que `syncGeofencesNow`.
 * @post Igual que `syncGeofencesNow`, pero espera a que terminen las
 *       sincronizaciones pedidas antes (desde la interfaz, al salir de la
 *       centinela o tras un botón de un aviso): ninguna lee las regiones
 *       registradas ni la última posición mientras otra las está cambiando.
 * @throws Igual que `syncGeofencesNow`.
 */
export function syncGeofences(repos: Repositories): Promise<GeofenceSyncResult> {
  return syncQueue(() => syncGeofencesNow(repos));
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
