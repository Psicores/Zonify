import { migrate } from 'drizzle-orm/expo-sqlite/migrator';
import * as Notifications from 'expo-notifications';
import * as TaskManager from 'expo-task-manager';

import migrations from '../../drizzle/migrations';
import { db } from '../db/client';
import { createRepositories } from '../db/repositories';
import { syncGeofences } from '../geofencing/service';
import { handleAlertAction } from './actions';

/** Tarea que recibe los toques en los botones de los avisos con la app cerrada (US-6.3). */
export const NOTIFICATION_ACTION_TASK_NAME = 'zonify-notification-actions';

// Se define al cargar el bundle: en Android, tocar «Hecho» o «Posponer» con la
// app en segundo plano o cerrada despierta el JS solo para correr esta tarea,
// sin levantar ninguna pantalla.
TaskManager.defineTask<Notifications.NotificationTaskPayload>(
  NOTIFICATION_ACTION_TASK_NAME,
  async ({ data, error }) => {
    if (error || !data || !('actionIdentifier' in data)) return;
    if (data.actionIdentifier === Notifications.DEFAULT_ACTION_IDENTIFIER) return;
    try {
      await migrate(db, migrations);
      const repos = createRepositories(db);
      const outcome = await handleAlertAction(
        {
          repos,
          resync: () => syncGeofences(repos),
          dismiss: Notifications.dismissNotificationAsync,
          now: new Date(),
        },
        data.actionIdentifier,
        data.notification.request.content.data,
        data.notification.request.identifier,
      );
      if (__DEV__) console.log('[avisos] acción en segundo plano', data.actionIdentifier, outcome);
    } catch (e) {
      console.warn('[avisos] no se pudo procesar la acción:', e);
    }
  },
);
