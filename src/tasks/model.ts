import type { TaskStatus } from '../db/schema';

/** Largo máximo del título; alcanza para un mandado y evita textos pegados por error. */
export const TASK_TITLE_MAX_LENGTH = 200;

/** Nombre de cada estado tal como se muestra al usuario. */
export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  pending: 'Activa',
  completed: 'Completada',
  archived: 'Archivada',
};

/**
 * Limpia el texto escrito en el alta rápida para usarlo como título.
 *
 * @pre Ninguna.
 * @post Devuelve el texto sin espacios al principio ni al final y con los
 *       espacios internos repetidos (incluidos saltos de línea) reducidos a uno,
 *       recortado a `TASK_TITLE_MAX_LENGTH` caracteres; devuelve `null` si no
 *       queda nada que guardar.
 */
export function normalizeTaskTitle(raw: string): string | null {
  const title = raw.replace(/\s+/g, ' ').trim().slice(0, TASK_TITLE_MAX_LENGTH).trimEnd();
  return title.length > 0 ? title : null;
}
