import type { AppDatabase } from '../types';
import { createCategoryRepository } from './categories';
import { createGeofenceTriggerRepository } from './geofenceTriggers';
import { createLocationTargetRepository } from './locationTargets';
import { createNotificationLogRepository } from './notificationLogs';
import { createTaskPlaceRepository } from './taskPlaces';
import { createTaskRepository } from './tasks';

/**
 * Crea todos los repositorios sobre una misma conexión.
 *
 * @pre `db` tiene las migraciones aplicadas y `PRAGMA foreign_keys = ON`.
 * @post Devuelve un repositorio por entidad; todos comparten `db`, así que ven
 *       los mismos datos.
 */
export function createRepositories(db: AppDatabase) {
  return {
    categories: createCategoryRepository(db),
    locationTargets: createLocationTargetRepository(db),
    tasks: createTaskRepository(db),
    geofenceTriggers: createGeofenceTriggerRepository(db),
    notificationLogs: createNotificationLogRepository(db),
    taskPlaces: createTaskPlaceRepository(db),
  };
}

export type Repositories = ReturnType<typeof createRepositories>;
