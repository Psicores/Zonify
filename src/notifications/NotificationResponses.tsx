import * as Notifications from 'expo-notifications';
import { useRouter } from 'expo-router';
import { useEffect, useMemo, useRef } from 'react';

import { db } from '../db/client';
import { createRepositories } from '../db/repositories';
import { syncGeofences } from '../geofencing/service';
import { handleAlertAction, routeForAlert } from './actions';
import { NOTIFICATION_ACTION_TASK_NAME } from './background';
import { ensureNotificationSetup } from './setup';

/**
 * Atiende los toques en los avisos (US-6.1, US-6.3). No dibuja nada.
 *
 * @pre Se monta dentro del layout raíz de Expo Router, con las migraciones aplicadas.
 * @post Al montarse deja listos canales y botones y registra la tarea de fondo
 *       de acciones. Tocar un aviso (también si abrió la app desde cerrada)
 *       navega al detalle de su primera tarea; tocar «Hecho» o «Posponer» con la
 *       app abierta ejecuta `handleAlertAction`. Cada respuesta se atiende una
 *       sola vez. Los fallos se informan en la consola.
 */
export function NotificationResponses() {
  const repos = useMemo(() => createRepositories(db), []);
  const router = useRouter();
  const response = Notifications.useLastNotificationResponse();
  const handled = useRef(new Set<string>());

  useEffect(() => {
    ensureNotificationSetup().catch((e: unknown) => console.warn('[avisos] no se pudo configurar:', e));
    Notifications.registerTaskAsync(NOTIFICATION_ACTION_TASK_NAME).catch((e: unknown) =>
      console.warn('[avisos] no se pudo registrar la tarea de acciones:', e),
    );
  }, []);

  useEffect(() => {
    if (!response) return;
    const { identifier, content } = response.notification.request;
    const key = `${identifier}/${response.actionIdentifier}`;
    if (handled.current.has(key)) return;
    handled.current.add(key);

    if (response.actionIdentifier === Notifications.DEFAULT_ACTION_IDENTIFIER) {
      const route = routeForAlert(content.data);
      if (route) router.push(route);
      Notifications.clearLastNotificationResponse();
      return;
    }
    handleAlertAction(
      {
        repos,
        resync: () => syncGeofences(repos),
        dismiss: Notifications.dismissNotificationAsync,
        now: new Date(),
      },
      response.actionIdentifier,
      content.data,
      identifier,
    )
      .then((outcome) => {
        if (__DEV__) console.log('[avisos] acción', response.actionIdentifier, outcome);
      })
      .catch((e: unknown) => console.warn('[avisos] no se pudo procesar la acción:', e))
      .finally(() => Notifications.clearLastNotificationResponse());
  }, [response, repos, router]);

  return null;
}
