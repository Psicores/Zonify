import { and, desc, eq, inArray, type SQL } from 'drizzle-orm';

import { tasks, type NewTask, type Task, type TaskStatus } from '../schema';
import type { AppDatabase } from '../types';

export type TaskUpdate = Partial<Omit<NewTask, 'id' | 'createdAt' | 'updatedAt'>>;

export interface TaskFilter {
  status?: TaskStatus;
  /** Estados admitidos; se combina con `status` si se indican los dos. */
  statuses?: readonly TaskStatus[];
  categoryId?: number;
}

/**
 * Crea el repositorio de tareas.
 *
 * @pre `db` tiene las migraciones aplicadas y `PRAGMA foreign_keys = ON`.
 * @post Devuelve operaciones sobre `tasks` que usan siempre `db`.
 */
export function createTaskRepository(db: AppDatabase) {
  return {
    /**
     * Inserta una tarea.
     *
     * @pre `input.title` no está vacío; si hay `categoryId`, esa categoría existe.
     * @post Devuelve la fila insertada; `status` vale `'pending'` si no se indicó.
     * @throws Error de SQLite (FOREIGN KEY) si la categoría no existe.
     */
    async create(input: NewTask): Promise<Task> {
      const [row] = await db.insert(tasks).values(input).returning();
      return row;
    },

    /**
     * Busca una tarea con sus relaciones.
     *
     * @pre Ninguna.
     * @post Devuelve la tarea con `category` (o `null`) y `geofenceTriggers`, cada uno
     *       con su `locationTarget`; devuelve `undefined` si la tarea no existe.
     */
    getById(id: number) {
      return db.query.tasks.findFirst({
        where: eq(tasks.id, id),
        with: {
          category: true,
          geofenceTriggers: { with: { locationTarget: true } },
        },
      });
    },

    /**
     * Lista tareas, con filtros opcionales.
     *
     * @pre Ninguna.
     * @post Devuelve las tareas que cumplen todos los filtros indicados (todas si
     *       `filter` está vacío; ninguna si `statuses` está vacío), de la más
     *       reciente a la más antigua.
     */
    list(filter: TaskFilter = {}) {
      const conditions: SQL[] = [];
      if (filter.status) conditions.push(eq(tasks.status, filter.status));
      if (filter.statuses) conditions.push(inArray(tasks.status, [...filter.statuses]));
      if (filter.categoryId !== undefined) conditions.push(eq(tasks.categoryId, filter.categoryId));

      return db
        .select()
        .from(tasks)
        .where(and(...conditions))
        .orderBy(desc(tasks.createdAt), desc(tasks.id));
    },

    /**
     * Modifica una tarea.
     *
     * @pre `changes` tiene al menos un campo; si cambia `categoryId`, la categoría existe.
     * @post Si existe, persiste los cambios, renueva `updatedAt` y devuelve la fila
     *       actualizada; si no existe, devuelve `undefined` sin modificar nada.
     * @throws Error de SQLite (FOREIGN KEY) si la categoría no existe.
     */
    async update(id: number, changes: TaskUpdate): Promise<Task | undefined> {
      const [row] = await db.update(tasks).set(changes).where(eq(tasks.id, id)).returning();
      return row;
    },

    /**
     * Marca una tarea como completada.
     *
     * @pre Ninguna.
     * @post Si existe: `status = 'completed'`, `completedAt = at` y se devuelve la
     *       fila; si no existe, devuelve `undefined`. Sus triggers dejan de estar armados.
     */
    complete(id: number, at: Date = new Date()) {
      return this.update(id, { status: 'completed', completedAt: at });
    },

    /**
     * Vuelve a dejar una tarea como pendiente.
     *
     * @pre Ninguna.
     * @post Si existe: `status = 'pending'`, `completedAt = null` y se devuelve la
     *       fila; si no existe, devuelve `undefined`.
     */
    reopen(id: number) {
      return this.update(id, { status: 'pending', completedAt: null });
    },

    /**
     * Archiva una tarea: deja de verse en las listas sin borrarla.
     *
     * @pre Ninguna.
     * @post Si existe: `status = 'archived'` (`completedAt` no cambia) y se devuelve
     *       la fila; si no existe, devuelve `undefined`. Sus triggers dejan de estar armados.
     */
    archive(id: number) {
      return this.update(id, { status: 'archived' });
    },

    /**
     * Borra una tarea.
     *
     * @pre Ninguna.
     * @post La tarea ya no existe, se borran en cascada sus `geofence_triggers` y sus
     *       `notification_logs` quedan con `taskId = null`. No falla si el id no existía.
     */
    async remove(id: number): Promise<void> {
      await db.delete(tasks).where(eq(tasks.id, id));
    },
  };
}
