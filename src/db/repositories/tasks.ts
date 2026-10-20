import { and, desc, eq, inArray, isNotNull, notExists, type SQL } from 'drizzle-orm';

import { categories, geofenceTriggers, tasks, type NewTask, type Task, type TaskStatus } from '../schema';
import type { AppDatabase } from '../types';

export type TaskUpdate = Partial<Omit<NewTask, 'id' | 'createdAt' | 'updatedAt'>>;

/** Ventana de avisos de una tarea (ver `src/tasks/schedule.ts`). */
export interface TaskAlertWindow {
  alertStartMinute: number | null;
  alertEndMinute: number | null;
  alertDays: number | null;
}

const isMinuteOfDay = (value: number) => Number.isInteger(value) && value >= 0 && value <= 1439;

/**
 * Comprueba que una ventana de avisos sea guardable.
 *
 * @pre Ninguna.
 * @post No hace nada si la ventana es válida.
 * @throws `RangeError` si solo uno de los extremos de la franja es `null`, si
 *         algún extremo no es un minuto del día (0–1439) o si `alertDays` no es
 *         `null` ni un entero entre 1 y 127.
 */
export function assertValidAlertWindow(window: TaskAlertWindow): void {
  const { alertStartMinute: start, alertEndMinute: end, alertDays: days } = window;
  if ((start === null) !== (end === null)) {
    throw new RangeError('La franja horaria necesita hora de inicio y de fin');
  }
  if (start !== null && end !== null && (!isMinuteOfDay(start) || !isMinuteOfDay(end))) {
    throw new RangeError('La franja horaria tiene una hora fuera de rango');
  }
  if (days !== null && (!Number.isInteger(days) || days < 1 || days > 127)) {
    throw new RangeError('Hay que elegir al menos un día');
  }
}

export interface TaskFilter {
  status?: TaskStatus;
  /** Estados admitidos; se combina con `status` si se indican los dos. */
  statuses?: readonly TaskStatus[];
  categoryId?: number;
}

/**
 * Condición de «tarea anclada a un rubro»: pendiente, con categoría y sin
 * ningún lugar propio activo (el lugar concreto tiene prioridad sobre el rubro).
 *
 * @pre Ninguna.
 * @post Devuelve la condición SQL sobre `tasks`.
 */
function categoryAnchoredPending(db: AppDatabase): SQL {
  return and(
    eq(tasks.status, 'pending'),
    isNotNull(tasks.categoryId),
    notExists(
      db
        .select({ id: geofenceTriggers.id })
        .from(geofenceTriggers)
        .where(and(eq(geofenceTriggers.taskId, tasks.id), eq(geofenceTriggers.isActive, true))),
    ),
  )!;
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
     * Rubros con alguna tarea pendiente anclada solo al rubro.
     *
     * @pre Ninguna.
     * @post Devuelve, sin repetir, los `categoryId` de las tareas pendientes con
     *       rubro y sin lugar propio activo; vacío si no hay.
     */
    async pendingCategoryIds(): Promise<number[]> {
      const rows = await db
        .selectDistinct({ categoryId: tasks.categoryId })
        .from(tasks)
        .where(categoryAnchoredPending(db));
      return rows.map((row) => row.categoryId!);
    },

    /**
     * Lista las tareas pendientes ancladas solo a ciertos rubros.
     *
     * @pre Ninguna.
     * @post Devuelve las tareas pendientes cuyo rubro está en `categoryIds` y que
     *       no tienen lugar propio activo, de la más antigua a la más reciente;
     *       vacío si `categoryIds` está vacío.
     */
    async listPendingInCategories(categoryIds: readonly number[]): Promise<Task[]> {
      if (categoryIds.length === 0) return [];
      return db
        .select()
        .from(tasks)
        .where(and(categoryAnchoredPending(db), inArray(tasks.categoryId, [...categoryIds])))
        .orderBy(tasks.createdAt, tasks.id);
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
     * Cambia la ventana en la que suenan los avisos de una tarea (US-5.2).
     *
     * @pre Ninguna.
     * @post Si la ventana es válida y la tarea existe, la guarda y devuelve la
     *       fila; si la tarea no existe, devuelve `undefined`.
     * @throws `RangeError` (ver `assertValidAlertWindow`) sin modificar nada.
     */
    setAlertWindow(id: number, window: TaskAlertWindow) {
      assertValidAlertWindow(window);
      return this.update(id, window);
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
     * Completa varias tareas a la vez (acción «Hecho» de una notificación).
     *
     * @pre Ninguna.
     * @post Las tareas de `ids` que estaban pendientes quedan `'completed'` con
     *       `completedAt = at`; las demás no cambian (repetir la acción no
     *       pisa la fecha). Devuelve cuántas cambiaron.
     */
    async completeMany(ids: readonly number[], at: Date = new Date()): Promise<number> {
      if (ids.length === 0) return 0;
      const rows = await db
        .update(tasks)
        .set({ status: 'completed', completedAt: at })
        .where(and(inArray(tasks.id, [...ids]), eq(tasks.status, 'pending')))
        .returning({ id: tasks.id });
      return rows.length;
    },

    /**
     * Pospone tareas y silencia sus rubros (acción «Posponer» de una notificación, US-6.2).
     *
     * @pre Ninguna.
     * @post Las tareas de `ids` y los rubros de esas tareas quedan con
     *       `snoozedUntil = until`, en una transacción. Ids inexistentes se ignoran.
     */
    snooze(ids: readonly number[], until: Date): void {
      if (ids.length === 0) return;
      db.transaction((tx) => {
        tx.update(tasks).set({ snoozedUntil: until }).where(inArray(tasks.id, [...ids])).run();
        const categoryIds = tx
          .selectDistinct({ id: tasks.categoryId })
          .from(tasks)
          .where(and(inArray(tasks.id, [...ids]), isNotNull(tasks.categoryId)))
          .all()
          .map((row) => row.id!);
        if (categoryIds.length > 0) {
          tx.update(categories).set({ snoozedUntil: until }).where(inArray(categories.id, categoryIds)).run();
        }
      });
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
