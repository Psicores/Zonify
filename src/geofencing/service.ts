import * as Location from 'expo-location';
import * as Notifications from 'expo-notifications';
import * as TaskManager from 'expo-task-manager';
import { Platform } from 'react-native';

import type { Repositories } from '../db/repositories';
import { ensureZoneAlertsChannel, ZONE_ALERTS_CHANNEL_ID } from '../permissions/service';
import { buildRegions, GEOFENCE_TASK_NAME, MAX_REGIONS, regionsSignature } from './model';

export type GeofenceSyncStatus = 'unavailable' | 'no-permission' | 'stopped' | 'unchanged' | 'registered';

export interface GeofenceSyncResult {
  status: GeofenceSyncStatus;
  /** Regiones que quedaron registradas en el sistema. */
  count: number;
}

// Para priorizar regiones alcanza una posición de la última media hora.
const PRIORITY_POSITION_MAX_AGE_MS = 30 * 60_000;

/**
 * Alinea las geocercas del sistema operativo con los triggers armados de la base.
 *
 * @pre La tarea `GEOFENCE_TASK_NAME` está definida (se importó `./background`)
 *      y las migraciones están aplicadas.
 * @post Sin TaskManager devuelve `'unavailable'` sin tocar nada. Sin permiso de
 *       ubicación en segundo plano detiene el geofencing y devuelve
 *       `'no-permission'`. Si no queda ningún trigger armado lo detiene
 *       (`'stopped'`). Si las regiones registradas ya coinciden con
 *       `buildRegions`, no las vuelve a registrar (`'unchanged'`): cada registro
 *       hace que Android repita el estado actual de todas. Si no, las registra
 *       (`'registered'`).
 * @throws Error de expo-location si el sistema rechaza el registro (p. ej. sin
 *         ubicación precisa en Android).
 */
export async function syncGeofences(repos: Repositories): Promise<GeofenceSyncResult> {
  if (!(await TaskManager.isAvailableAsync())) return { status: 'unavailable', count: 0 };

  const started = await Location.hasStartedGeofencingAsync(GEOFENCE_TASK_NAME);
  const permission = await Location.getBackgroundPermissionsAsync();
  const armed = permission.granted ? await repos.geofenceTriggers.listArmed() : [];
  const limit = Platform.OS === 'ios' ? MAX_REGIONS.ios : MAX_REGIONS.android;
  const position =
    armed.length > limit
      ? await Location.getLastKnownPositionAsync({ maxAge: PRIORITY_POSITION_MAX_AGE_MS }).catch(() => null)
      : null;
  const regions = buildRegions(armed, position?.coords ?? null, limit);

  if (regions.length === 0) {
    if (started) await Location.stopGeofencingAsync(GEOFENCE_TASK_NAME);
    return { status: permission.granted ? 'stopped' : 'no-permission', count: 0 };
  }

  if (started) {
    const options = await TaskManager.getTaskOptionsAsync<{ regions?: unknown }>(GEOFENCE_TASK_NAME).catch(
      () => null,
    );
    if (regionsSignature(options?.regions) === regionsSignature(regions)) {
      return { status: 'unchanged', count: regions.length };
    }
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
  data: { taskId: number; triggerId: number },
): Promise<string> {
  if (Platform.OS === 'android') await ensureZoneAlertsChannel();
  return Notifications.scheduleNotificationAsync({
    content: { ...content, data },
    trigger: Platform.OS === 'android' ? { channelId: ZONE_ALERTS_CHANNEL_ID } : null,
  });
}
