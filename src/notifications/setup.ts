import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

import { ensureZoneAlertsChannel } from '../permissions/service';

/** Categoría de los avisos de zona: define sus botones (US-6.3). Sin `-` ni `:` (lo pide iOS). */
export const ALERT_CATEGORY_ID = 'zoneAlert';

export const ALERT_ACTIONS = {
  complete: 'complete',
  snooze: 'snooze',
} as const;

export type AlertAction = (typeof ALERT_ACTIONS)[keyof typeof ALERT_ACTIONS];

/**
 * Deja listo todo lo que necesita un aviso antes de mostrarse.
 *
 * @pre Ninguna.
 * @post En Android existen los canales de alertas (ver `ensureZoneAlertsChannel`).
 *       Existe la categoría `ALERT_CATEGORY_ID` con los botones «Hecho» y
 *       «Posponer 2 h», que se procesan sin abrir la app. Es idempotente.
 * @throws Error de expo-notifications si el sistema rechaza la configuración.
 */
export async function ensureNotificationSetup(): Promise<void> {
  if (Platform.OS === 'android') await ensureZoneAlertsChannel();
  await Notifications.setNotificationCategoryAsync(ALERT_CATEGORY_ID, [
    {
      identifier: ALERT_ACTIONS.complete,
      buttonTitle: 'Hecho',
      options: { opensAppToForeground: false },
    },
    {
      identifier: ALERT_ACTIONS.snooze,
      buttonTitle: 'Posponer 2 h',
      options: { opensAppToForeground: false },
    },
  ]);
}
