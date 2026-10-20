import { and, eq } from 'drizzle-orm';

import {
  geofenceTriggers,
  locationTargets,
  tasks,
  type GeofenceState,
  type GeofenceTrigger,
  type NewGeofenceTrigger,
} from '../schema';
import type { AppDatabase } from '../types';

/**
 * Crea el repositorio de triggers de geocerca (relación tarea ↔ lugar).
 *
 * @pre `db` tiene las migraciones aplicadas y `PRAGMA foreign_keys = ON`.
 * @post Devuelve operaciones sobre `geofence_triggers` que usan siempre `db`.
 */
export function createGeofenceTriggerRepository(db: AppDatabase) {
  return {
    /**
     * Inserta un trigger.
     *
     * @pre La tarea y el lugar existen; no hay otro trigger con la misma
     *      (tarea, lugar, transición); si `transition = 'dwell'`, `dwellSeconds` > 0.
     * @post Devuelve la fila insertada; por defecto `transition = 'enter'`,
     *       `isActive = true` y `lastState = 'unknown'`.
     * @throws Error de SQLite (FOREIGN KEY, UNIQUE o CHECK) si no se cumple la precondición.
     */
    async create(input: NewGeofenceTrigger): Promise<GeofenceTrigger> {
      const [row] = await db.insert(geofenceTriggers).values(input).returning();
      return row;
    },

    /**
     * Busca un trigger con su tarea y su lugar.
     *
     * @pre Ninguna.
     * @post Devuelve el trigger con `task` y `locationTarget`, o `undefined` si no existe.
     */
    getById(id: number) {
      return db.query.geofenceTriggers.findFirst({
        where: eq(geofenceTriggers.id, id),
        with: { task: true, locationTarget: true },
      });
    },

    /**
     * Lista los triggers de una tarea.
     *
     * @pre Ninguna.
     * @post Devuelve todos los triggers de `taskId` (activos o no) con su
     *       `locationTarget`; vacío si la tarea no tiene o no existe.
     */
    listByTask(taskId: number) {
      return db.query.geofenceTriggers.findMany({
        where: eq(geofenceTriggers.taskId, taskId),
        with: { locationTarget: true },
      });
    },

    /**
     * Lista los triggers que hay que registrar en el sistema operativo.
     *
     * @pre Ninguna.
     * @post Devuelve `{ trigger, task, locationTarget }` por cada trigger con
     *       `isActive = true` cuya tarea está en `'pending'`; excluye el resto.
     */
    listArmed() {
      return db
        .select({ trigger: geofenceTriggers, task: tasks, locationTarget: locationTargets })
        .from(geofenceTriggers)
        .innerJoin(tasks, eq(tasks.id, geofenceTriggers.taskId))
        .innerJoin(locationTargets, eq(locationTargets.id, geofenceTriggers.locationTargetId))
        .where(and(eq(geofenceTriggers.isActive, true), eq(tasks.status, 'pending')));
    },

    /**
     * Lista los triggers activos con su lugar, sea cual sea el estado de la tarea.
     *
     * @pre Ninguna.
     * @post Devuelve `{ trigger, locationTarget }` por cada trigger con
     *       `isActive = true`; excluye los pausados.
     */
    listActiveWithLocation() {
      return db
        .select({ trigger: geofenceTriggers, locationTarget: locationTargets })
        .from(geofenceTriggers)
        .innerJoin(locationTargets, eq(locationTargets.id, geofenceTriggers.locationTargetId))
        .where(eq(geofenceTriggers.isActive, true));
    },

    /**
     * Registra el estado observado de la geocerca.
     *
     * @pre Ninguna.
     * @post Si existe: `lastState = state`, `lastTransitionAt = at` y se devuelve
     *       la fila; si no existe, devuelve `undefined`.
     */
    async recordState(
      id: number,
      state: GeofenceState,
      at: Date = new Date(),
    ): Promise<GeofenceTrigger | undefined> {
      const [row] = await db
        .update(geofenceTriggers)
        .set({ lastState: state, lastTransitionAt: at })
        .where(eq(geofenceTriggers.id, id))
        .returning();
      return row;
    },

    /**
     * Activa o pausa un trigger.
     *
     * @pre Ninguna.
     * @post Si existe: `isActive` queda con el valor indicado y se devuelve la fila;
     *       si no existe, devuelve `undefined`.
     */
    async setActive(id: number, isActive: boolean): Promise<GeofenceTrigger | undefined> {
      const [row] = await db
        .update(geofenceTriggers)
        .set({ isActive })
        .where(eq(geofenceTriggers.id, id))
        .returning();
      return row;
    },

    /**
     * Borra un trigger.
     *
     * @pre Ninguna.
     * @post El trigger ya no existe y sus `notification_logs` quedan con
     *       `geofenceTriggerId = null`. No falla si el id no existía.
     */
    async remove(id: number): Promise<void> {
      await db.delete(geofenceTriggers).where(eq(geofenceTriggers.id, id));
    },
  };
}
