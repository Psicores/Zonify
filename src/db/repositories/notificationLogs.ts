import { and, desc, eq, ne } from 'drizzle-orm';

import {
  notificationLogs,
  type NewNotificationLog,
  type NotificationLog,
  type NotificationStatus,
} from '../schema';
import type { AppDatabase } from '../types';

/**
 * Crea el repositorio del historial de notificaciones.
 *
 * @pre `db` tiene las migraciones aplicadas y `PRAGMA foreign_keys = ON`.
 * @post Devuelve operaciones sobre `notification_logs` que usan siempre `db`.
 */
export function createNotificationLogRepository(db: AppDatabase) {
  return {
    /**
     * Registra una notificación.
     *
     * @pre `input.title` no está vacío; si hay `taskId` o `geofenceTriggerId`, existen.
     * @post Devuelve la fila insertada; `status = 'scheduled'` y `firedAt = ahora`
     *       si no se indicaron.
     * @throws Error de SQLite (FOREIGN KEY) si la tarea o el trigger no existen.
     */
    async create(input: NewNotificationLog): Promise<NotificationLog> {
      const [row] = await db.insert(notificationLogs).values(input).returning();
      return row;
    },

    /**
     * Lista las últimas notificaciones.
     *
     * @pre `limit` es un entero positivo.
     * @post Devuelve como máximo `limit` filas, de la más reciente a la más antigua
     *       según `firedAt`.
     */
    listRecent(limit = 50) {
      return db
        .select()
        .from(notificationLogs)
        .orderBy(desc(notificationLogs.firedAt), desc(notificationLogs.id))
        .limit(limit);
    },

    /**
     * Lista las notificaciones de una tarea.
     *
     * @pre Ninguna.
     * @post Devuelve las notificaciones de `taskId`, de la más reciente a la más
     *       antigua; vacío si no hay.
     */
    listByTask(taskId: number) {
      return db
        .select()
        .from(notificationLogs)
        .where(eq(notificationLogs.taskId, taskId))
        .orderBy(desc(notificationLogs.firedAt), desc(notificationLogs.id));
    },

    /**
     * Momento del último aviso de un trigger que llegó a mostrarse o programarse.
     *
     * @pre Ninguna.
     * @post Devuelve el `firedAt` más reciente de `geofenceTriggerId` sin contar
     *       los de `status = 'failed'`, o `null` si no hay ninguno.
     */
    async lastFiredAtForTrigger(geofenceTriggerId: number): Promise<Date | null> {
      const [row] = await db
        .select({ firedAt: notificationLogs.firedAt })
        .from(notificationLogs)
        .where(
          and(
            eq(notificationLogs.geofenceTriggerId, geofenceTriggerId),
            ne(notificationLogs.status, 'failed'),
          ),
        )
        .orderBy(desc(notificationLogs.firedAt))
        .limit(1);
      return row?.firedAt ?? null;
    },

    /**
     * Momento del último aviso de una tarea que llegó a mostrarse o programarse.
     *
     * @pre Ninguna.
     * @post Devuelve el `firedAt` más reciente de `taskId` sin contar los de
     *       `status = 'failed'`, o `null` si no hay ninguno.
     */
    async lastFiredAtForTask(taskId: number): Promise<Date | null> {
      const [row] = await db
        .select({ firedAt: notificationLogs.firedAt })
        .from(notificationLogs)
        .where(and(eq(notificationLogs.taskId, taskId), ne(notificationLogs.status, 'failed')))
        .orderBy(desc(notificationLogs.firedAt))
        .limit(1);
      return row?.firedAt ?? null;
    },

    /**
     * Cambia el estado de una notificación.
     *
     * @pre Ninguna.
     * @post Si existe: `status` queda con el valor indicado y se devuelve la fila;
     *       si no existe, devuelve `undefined`.
     */
    async updateStatus(id: number, status: NotificationStatus): Promise<NotificationLog | undefined> {
      const [row] = await db
        .update(notificationLogs)
        .set({ status })
        .where(eq(notificationLogs.id, id))
        .returning();
      return row;
    },
  };
}
