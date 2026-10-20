import { and, eq, inArray, notExists } from 'drizzle-orm';

import { geofenceTriggers, locationTargets, type LocationTarget, type NewLocationTarget } from '../schema';
import type { AppDatabase } from '../types';

export type TaskPlaceInput = Omit<NewLocationTarget, 'id' | 'createdAt' | 'updatedAt'>;

type Executor = Pick<AppDatabase, 'select' | 'delete'>;

/**
 * Borra los lugares indicados que ya no usa ningún trigger.
 *
 * @pre Se llama dentro de una transacción, después de borrar los triggers.
 * @post Los lugares de `ids` sin triggers dejan de existir; los demás no cambian.
 */
function removeOrphanTargets(tx: Executor, ids: number[]): void {
  if (ids.length === 0) return;
  tx.delete(locationTargets)
    .where(
      and(
        inArray(locationTargets.id, ids),
        notExists(
          tx
            .select({ id: geofenceTriggers.id })
            .from(geofenceTriggers)
            .where(eq(geofenceTriggers.locationTargetId, locationTargets.id)),
        ),
      ),
    )
    .run();
}

/**
 * Quita todos los triggers de una tarea y los lugares que solo ella usaba.
 *
 * @pre Se llama dentro de una transacción.
 * @post La tarea no tiene triggers; los lugares que quedaron sin ninguno no existen.
 */
function detachTask(tx: Executor, taskId: number): void {
  const previous = tx
    .select({ id: geofenceTriggers.locationTargetId })
    .from(geofenceTriggers)
    .where(eq(geofenceTriggers.taskId, taskId))
    .all()
    .map((row) => row.id);
  tx.delete(geofenceTriggers).where(eq(geofenceTriggers.taskId, taskId)).run();
  removeOrphanTargets(tx, previous);
}

/**
 * Crea el repositorio que ancla tareas a un lugar específico (US-3.1).
 * Cada tarea tiene a lo sumo un lugar propio: elegir otro reemplaza el anterior.
 *
 * @pre `db` tiene las migraciones aplicadas y `PRAGMA foreign_keys = ON`.
 * @post Devuelve operaciones que mantienen juntos `location_targets` y
 *       `geofence_triggers`, siempre sobre `db`.
 */
export function createTaskPlaceRepository(db: AppDatabase) {
  return {
    /**
     * Busca el lugar al que está anclada una tarea.
     *
     * @pre Ninguna.
     * @post Devuelve el lugar del trigger más antiguo de la tarea, o `undefined`
     *       si no tiene ninguno (o si la tarea no existe).
     */
    async get(taskId: number): Promise<LocationTarget | undefined> {
      const [row] = await db
        .select({ place: locationTargets })
        .from(geofenceTriggers)
        .innerJoin(locationTargets, eq(locationTargets.id, geofenceTriggers.locationTargetId))
        .where(eq(geofenceTriggers.taskId, taskId))
        .orderBy(geofenceTriggers.id)
        .limit(1);
      return row?.place;
    },

    /**
     * Ancla una tarea a un lugar nuevo, en una sola transacción.
     *
     * @pre La tarea existe; `place` tiene `name`, coordenadas en rango y
     *      `radiusMeters` > 0.
     * @post Se crea el lugar y un trigger activo de entrada (`'enter'`) que lo une
     *       a la tarea; los triggers anteriores de la tarea se borran, y con ellos
     *       los lugares que quedaron sin uso. Devuelve el lugar creado. Si algo
     *       falla, no cambia nada.
     * @throws Error de SQLite (FOREIGN KEY o CHECK) si no se cumple la precondición.
     */
    setPlace(taskId: number, place: TaskPlaceInput): LocationTarget {
      return db.transaction((tx) => {
        detachTask(tx, taskId);
        const target = tx.insert(locationTargets).values(place).returning().get();
        tx.insert(geofenceTriggers).values({ taskId, locationTargetId: target.id }).run();
        return target;
      });
    },

    /**
     * Desancla una tarea de su lugar.
     *
     * @pre Ninguna.
     * @post La tarea queda sin triggers y se borran los lugares que solo usaba
     *       ella. No falla si no tenía lugar o no existe.
     */
    clearPlace(taskId: number): void {
      db.transaction((tx) => detachTask(tx, taskId));
    },
  };
}
