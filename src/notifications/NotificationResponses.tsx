import * as Notifications from 'expo-notifications';
import { useRouter } from 'expo-router';
import { useEffect, useMemo, useRef } from 'react';

import { eventQueue } from '../background/serial';
import { db } from '../db/client';
import { createRepositories } from '../db/repositories';
import { syncGeofences } from '../geofencing/service';
import { alertResponseKey, handleAlertAction, routeForAlert } from './actions';
import { ensureNotificationSetup } from './setup';

/**
 * Atiende los toques en los avisos (US-6.1, US-6.3). No dibuja nada.
 *
 * @pre Se monta dentro del layout raíz de Expo Router, con las migraciones
 *      aplicadas. La tarea de fondo de acciones se registra al cargar el bundle
 *      (`./background`).
 * @post Al montarse deja listos canales y botones. Tocar un aviso (también si
 *       abrió la app desde cerrada) navega al detalle de su primera tarea; tocar
 *       «Hecho» o «Posponer» con la app abierta quita el aviso enseguida y
 *       ejecuta `handleAlertAction`, que no repite una respuesta que ya atendió
 *       la tarea de fondo. Los fallos se informan en la consola.
 */
export function NotificationResponses() {
  const repos = useMemo(() => createRepositories(db), []);
  const router = useRouter();
  const response = Notifications.useLastNotificationResponse();
  const handled = useRef(new Set<string>());

  useEffect(() => {
    ensureNotificationSetup().catch((e: unknown) => console.warn('[avisos] no se pudo configurar:', e));
  }, []);

  useEffect(() => {
    if (!response) return;
    const { identifier, content } = response.notification.request;
    const key = alertResponseKey(identifier, response.actionIdentifier);
    if (handled.current.has(key)) return;
    handled.current.add(key);

    if (response.actionIdentifier === Notifications.DEFAULT_ACTION_IDENTIFIER) {
      const route = routeForAlert(content.data);
      if (route) router.push(route);
      Notifications.clearLastNotificationResponse();
      return;
    }
    // Primero el aviso: Android no lo quita al tocar un botón (US-1.1).
    Notifications.dismissNotificationAsync(identifier).catch(() => undefined);
    // Misma cola que los eventos de geocercas y que los botones con la app cerrada (US-2.1).
    eventQueue(() =>
      handleAlertAction(
        { repos, resync: () => syncGeofences(repos), now: new Date() },
        response.actionIdentifier,
        content.data,
        key,
      ),
    )
      .then((outcome) => {
        if (__DEV__) console.log('[avisos] acción', response.actionIdentifier, outcome);
      })
      .catch((e: unknown) => console.warn('[avisos] no se pudo procesar la acción:', e))
      .finally(() => Notifications.clearLastNotificationResponse());
  }, [response, repos, router]);

  return null;
}
