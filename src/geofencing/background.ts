import * as Location from 'expo-location';
import * as Notifications from 'expo-notifications';
import * as TaskManager from 'expo-task-manager';

import { db } from '../db/client';
import { ensureMigrated } from '../db/migrate';
import { createRepositories } from '../db/repositories';
import { handleGeofenceEvent } from './handleEvent';
import { GEOFENCE_TASK_NAME, type GeofenceEvent } from './model';
import { readRecentFix, showGeofenceNotification, syncGeofences } from './service';

// Este módulo se evalúa al cargar el bundle, también cuando el sistema despierta
// la app cerrada por una geocerca: ahí no se monta ningún componente, así que la
// tarea y el handler de notificaciones tienen que quedar definidos acá.

interface GeofencingTaskData {
  eventType: Location.GeofencingEventType;
  region: Location.LocationRegion;
}

// Con la app abierta las notificaciones no se muestran salvo que un handler lo
// pida. Las silenciosas (fuera del horario de la tarea) van solo a la lista.
Notifications.setNotificationHandler({
  handleNotification: async (notification) => {
    const silent = notification.request.content.data?.silent === true;
    return {
      shouldShowBanner: !silent,
      shouldShowList: true,
      shouldPlaySound: !silent,
      shouldSetBadge: false,
    };
  },
});

TaskManager.defineTask<GeofencingTaskData>(GEOFENCE_TASK_NAME, async ({ data, error }) => {
  if (error) {
    console.warn('[geofence] el sistema informó un error:', error.message);
    return;
  }
  const event: GeofenceEvent | null =
    data.eventType === Location.GeofencingEventType.Enter
      ? 'enter'
      : data.eventType === Location.GeofencingEventType.Exit
        ? 'exit'
        : null;
  if (!event) return;

  try {
    // Si la app se actualizó y el evento llega antes de abrirla, el esquema
    // podría estar atrasado; migra una sola vez por runtime.
    await ensureMigrated();
    const repos = createRepositories(db);
    const outcome = await handleGeofenceEvent(
      {
        repos,
        notify: showGeofenceNotification,
        // Al salir de la centinela: nuevas geocercas de rubro alrededor de la posición actual.
        replan: () => syncGeofences(repos),
        currentFix: readRecentFix,
        now: new Date(),
      },
      event,
      data.region.identifier,
    );
    if (__DEV__) console.log('[geofence]', event, data.region.identifier, outcome);
  } catch (e) {
    console.warn('[geofence] no se pudo procesar el evento:', e);
  }
});
