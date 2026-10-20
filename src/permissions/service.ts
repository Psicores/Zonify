import * as Battery from 'expo-battery';
import * as Device from 'expo-device';
import * as IntentLauncher from 'expo-intent-launcher';
import * as Location from 'expo-location';
import * as Notifications from 'expo-notifications';
import { AndroidImportance, IosAuthorizationStatus } from 'expo-notifications';
import { Linking, Platform } from 'react-native';

import {
  findAggressiveVendor,
  type BatteryStatus,
  type PermissionAccess,
  type PermissionSnapshot,
} from './model';

/** Canal de Android por el que salen las alertas de geocercas. */
// v2: el canal original se creó sin vibración explícita y Android no deja
// cambiar sonido ni vibración de un canal existente (US-6.1).
export const ZONE_ALERTS_CHANNEL_ID = 'zone-alerts-v2';
const LEGACY_ZONE_ALERTS_CHANNEL_ID = 'zone-alerts';
/** Patrón de vibración de los avisos: dos pulsos cortos (ms: espera, vibra, espera, vibra). */
export const ZONE_ALERTS_VIBRATION = [0, 250, 150, 250];
/** Canal para avisos fuera del horario de la tarea: sin sonido ni vibración (US-5.2). */
export const ZONE_ALERTS_SILENT_CHANNEL_ID = 'zone-alerts-silent';

/**
 * Reduce una respuesta de permisos de Expo a `PermissionAccess`.
 *
 * @pre Ninguna.
 * @post `granted` si está concedido; `undetermined` si nunca se pidió; si no,
 *       `denied` o `blocked` según el sistema permita volver a pedirlo.
 */
function toAccess(response: Location.PermissionResponse): PermissionAccess {
  if (response.granted) return 'granted';
  if (response.status === Location.PermissionStatus.UNDETERMINED) return 'undetermined';
  return response.canAskAgain ? 'denied' : 'blocked';
}

/**
 * Reduce el estado de notificaciones a `PermissionAccess`. En iOS usa
 * `ios.status`, que es el valor fiable según la documentación de Expo.
 *
 * @pre Ninguna.
 * @post En iOS, una autorización rechazada es `blocked` (iOS no vuelve a mostrar
 *       el diálogo) y cualquier autorización concedida es `granted`.
 */
function notificationAccess(response: Notifications.NotificationPermissionsStatus): PermissionAccess {
  if (Platform.OS === 'ios' && response.ios) {
    switch (response.ios.status) {
      case IosAuthorizationStatus.NOT_DETERMINED:
        return 'undetermined';
      case IosAuthorizationStatus.DENIED:
        return 'blocked';
      default:
        return 'granted';
    }
  }
  return toAccess(response);
}

/**
 * Indica si el permiso de ubicación concedido es preciso.
 *
 * @pre Ninguna.
 * @post `true` con precisión fina (Android) o completa (iOS), o si la
 *       plataforma no informa precisión; `false` en otro caso.
 */
function isPrecise(response: Location.LocationPermissionResponse): boolean {
  if (response.android) return response.android.accuracy === 'fine';
  if (response.ios) return response.ios.accuracy === 'full';
  return true;
}

/**
 * Lee las restricciones de batería que afectan al background.
 *
 * @pre Ninguna.
 * @post En Android devuelve la optimización de la app, el ahorro de energía y
 *       el fabricante si es conocido por ser agresivo; en otras plataformas
 *       devuelve todo desactivado, porque no aplican.
 */
async function readBatteryStatus(): Promise<BatteryStatus> {
  if (Platform.OS !== 'android') return { optimized: false, powerSaver: false, vendor: null };

  const [optimized, powerSaver] = await Promise.all([
    Battery.isBatteryOptimizationEnabledAsync(),
    Battery.isLowPowerModeEnabledAsync(),
  ]);
  return { optimized, powerSaver, vendor: findAggressiveVendor(Device.manufacturer) };
}

/**
 * Lee el estado actual de todos los permisos del onboarding, sin mostrar
 * ningún diálogo.
 *
 * @pre Ninguna.
 * @post Devuelve una foto del estado de ubicación, notificaciones y batería.
 * @throws Error del módulo nativo si alguna consulta falla.
 */
export async function readPermissionSnapshot(): Promise<PermissionSnapshot> {
  const [foreground, background, notifications, battery] = await Promise.all([
    Location.getForegroundPermissionsAsync(),
    Location.getBackgroundPermissionsAsync(),
    Notifications.getPermissionsAsync(),
    readBatteryStatus(),
  ]);

  return {
    foreground: toAccess(foreground),
    precise: isPrecise(foreground),
    background: toAccess(background),
    notifications: notificationAccess(notifications),
    battery,
  };
}

/**
 * Muestra el diálogo nativo de ubicación en primer plano ("mientras se usa la app").
 *
 * @pre Ninguna.
 * @post El usuario respondió el diálogo, o el sistema lo omitió porque ya
 *       estaba resuelto.
 */
export async function requestForegroundLocation(): Promise<void> {
  await Location.requestForegroundPermissionsAsync();
}

/**
 * Pide elevar la ubicación a background ("todo el tiempo" / "siempre"). En
 * Android 11+ el sistema abre la pantalla de permisos de la app en vez de un diálogo.
 *
 * @pre La ubicación en primer plano está concedida.
 * @post El usuario respondió, o volvió de la pantalla de permisos.
 */
export async function requestBackgroundLocation(): Promise<void> {
  await Location.requestBackgroundPermissionsAsync();
}

/**
 * Crea (o actualiza) los canales de Android por los que salen los avisos de zona.
 *
 * @pre Ninguna.
 * @post Existen `ZONE_ALERTS_CHANNEL_ID` (importancia alta, sonido del sistema
 *       y vibración `ZONE_ALERTS_VIBRATION`) y `ZONE_ALERTS_SILENT_CHANNEL_ID`
 *       (importancia baja, sin sonido ni vibración), y ya no existe el canal
 *       original sin vibración. Android no deja cambiar el sonido de un canal ya
 *       creado, por eso el silencio va en un canal aparte. En iOS no hace nada.
 */
export async function ensureZoneAlertsChannel(): Promise<void> {
  await Notifications.setNotificationChannelAsync(ZONE_ALERTS_CHANNEL_ID, {
    name: 'Alertas de zona',
    description: 'Avisos al llegar o salir de un lugar con tareas pendientes',
    importance: AndroidImportance.HIGH,
    // Sin `sound`: usa el sonido de notificación del sistema (un texto se toma
    // como nombre de un archivo de sonido propio).
    enableVibrate: true,
    vibrationPattern: ZONE_ALERTS_VIBRATION,
  });
  await Notifications.deleteNotificationChannelAsync(LEGACY_ZONE_ALERTS_CHANNEL_ID).catch(() => undefined);
  await Notifications.setNotificationChannelAsync(ZONE_ALERTS_SILENT_CHANNEL_ID, {
    name: 'Alertas de zona fuera de horario',
    description: 'Los mismos avisos, sin sonido ni vibración, fuera del horario elegido para la tarea',
    importance: AndroidImportance.LOW,
    sound: null,
    enableVibrate: false,
    vibrationPattern: null,
  });
}

/**
 * Crea el canal de alertas y pide permiso de notificaciones locales. En
 * Android 13+ el diálogo de POST_NOTIFICATIONS no aparece si no existe un canal.
 *
 * @pre Ninguna.
 * @post Existe el canal `ZONE_ALERTS_CHANNEL_ID` (solo Android) y el usuario
 *       respondió el diálogo, o el sistema lo omitió porque ya estaba resuelto.
 */
export async function requestNotifications(): Promise<void> {
  await ensureZoneAlertsChannel();
  await Notifications.requestPermissionsAsync();
}

/**
 * Abre la pantalla de Ajustes de la app.
 *
 * @pre Ninguna.
 * @post El sistema muestra los ajustes de Zonify.
 */
export async function openAppSettings(): Promise<void> {
  await Linking.openSettings();
}

/**
 * Abre una pantalla de ajustes de Android; si el fabricante no la tiene,
 * abre los ajustes de la app.
 *
 * @pre `Platform.OS === 'android'`.
 * @post El sistema muestra la pantalla pedida o, en su defecto, los ajustes de Zonify.
 */
async function openAndroidSettings(action: IntentLauncher.ActivityAction): Promise<void> {
  try {
    await IntentLauncher.startActivityAsync(action);
  } catch {
    await Linking.openSettings();
  }
}

/**
 * Abre la lista de optimización de batería, donde el usuario puede excluir a Zonify.
 *
 * @pre `Platform.OS === 'android'`.
 * @post El sistema muestra la lista de optimización o, en su defecto, los ajustes de Zonify.
 */
export function openBatteryOptimizationSettings(): Promise<void> {
  return openAndroidSettings(IntentLauncher.ActivityAction.IGNORE_BATTERY_OPTIMIZATION_SETTINGS);
}

/**
 * Abre los ajustes del ahorro de energía.
 *
 * @pre `Platform.OS === 'android'`.
 * @post El sistema muestra el ahorro de energía o, en su defecto, los ajustes de Zonify.
 */
export function openPowerSaverSettings(): Promise<void> {
  return openAndroidSettings(IntentLauncher.ActivityAction.BATTERY_SAVER_SETTINGS);
}

/**
 * Abre en el navegador la guía de dontkillmyapp.com para un fabricante.
 *
 * @pre `slug` es una ruta válida de dontkillmyapp.com.
 * @post El navegador muestra la guía.
 */
export async function openVendorGuide(slug: string): Promise<void> {
  await Linking.openURL(`https://dontkillmyapp.com/${slug}`);
}
