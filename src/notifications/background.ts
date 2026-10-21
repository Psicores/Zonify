import * as Notifications from 'expo-notifications';
import * as TaskManager from 'expo-task-manager';

import { eventQueue } from '../background/serial';
import { db } from '../db/client';
import { ensureMigrated } from '../db/migrate';
import { createRepositories } from '../db/repositories';
import { syncGeofences } from '../geofencing/service';
import { alertResponseKey, handleAlertAction, notificationContentData } from './actions';

/** Tarea que recibe los toques en los botones de los avisos con la app cerrada (US-6.3). */
export const NOTIFICATION_ACTION_TASK_NAME = 'zonify-notification-actions';

// Se define al cargar el bundle (desde `index.ts`): en Android, tocar «Hecho» o
// «Posponer» con la app en segundo plano o cerrada despierta el JS solo para
// correr esta tarea, sin levantar ninguna pantalla.
TaskManager.defineTask<Notifications.NotificationTaskPayload>(
  NOTIFICATION_ACTION_TASK_NAME,
  async ({ data, error }) => {
    if (error || !data || !('actionIdentifier' in data)) return;
    if (data.actionIdentifier === Notifications.DEFAULT_ACTION_IDENTIFIER) return;
    const { identifier, content } = data.notification.request;
    // Primero el aviso (US-1.1): Android no lo quita al tocar un botón, y la
    // cola puede estar ocupada con un evento que espera la posición.
    await Notifications.dismissNotificationAsync(identifier).catch(() => undefined);
    try {
      await ensureMigrated();
      const repos = createRepositories(db);
      // En la misma cola que los eventos de geocercas (US-2.1): un aviso que
      // llega mientras se completa o pospone una tarea ve el cambio ya hecho.
      const outcome = await eventQueue(() =>
        handleAlertAction(
          { repos, resync: () => syncGeofences(repos), now: new Date() },
          data.actionIdentifier,
          // Acá los datos llegan como texto (`dataString`), no como objeto.
          notificationContentData(content),
          alertResponseKey(identifier, data.actionIdentifier),
        ),
      );
      if (__DEV__) console.log('[avisos] acción en segundo plano', data.actionIdentifier, outcome);
    } catch (e) {
      console.warn('[avisos] no se pudo procesar la acción:', e);
    }
  },
);

// También al cargar el bundle: la tarea tiene que estar registrada antes del
// primer aviso, aunque la app no haya llegado a montar ninguna pantalla. El
// registro se guarda en el sistema; si ya está, no se repite.
TaskManager.isTaskRegisteredAsync(NOTIFICATION_ACTION_TASK_NAME)
  .then((registered) => (registered ? undefined : Notifications.registerTaskAsync(NOTIFICATION_ACTION_TASK_NAME)))
  .catch((e: unknown) => console.warn('[avisos] no se pudo registrar la tarea de acciones:', e));
