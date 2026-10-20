import * as BackgroundTask from 'expo-background-task';
import * as TaskManager from 'expo-task-manager';

import { db } from '../db/client';
import { ensureMigrated } from '../db/migrate';
import { createRepositories } from '../db/repositories';
import { runPoiSync } from './service';

/** Tarea periódica que mantiene al día el caché de POIs (US-4.3). */
export const POI_SYNC_TASK_NAME = 'zonify-poi-sync';

// Se define al cargar el bundle: el sistema puede lanzarla con la app cerrada
// (WorkManager en Android, BGTaskScheduler en iOS), sin montar componentes.
TaskManager.defineTask(POI_SYNC_TASK_NAME, async () => {
  try {
    await ensureMigrated();
    const outcome = await runPoiSync(createRepositories(db));
    if (__DEV__) console.log('[pois] sync en segundo plano', outcome);
    return BackgroundTask.BackgroundTaskResult.Success;
  } catch (e) {
    console.warn('[pois] no se pudo actualizar el caché:', e);
    return BackgroundTask.BackgroundTaskResult.Failed;
  }
});
