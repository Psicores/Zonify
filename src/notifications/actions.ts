import type { Repositories } from '../db/repositories';
import { SNOOZE_MS } from '../settings/appSettings';
import { ALERT_ACTIONS } from './setup';

export interface AlertActionDeps {
  repos: Repositories;
  /** Vuelve a registrar las geocercas (las de tareas completadas desaparecen). */
  resync: () => Promise<unknown>;
  /** Quita el aviso de la bandeja de notificaciones. */
  dismiss: (notificationId: string) => Promise<void>;
  now: Date;
}

export type AlertActionOutcome =
  | { kind: 'ignored' }
  | { kind: 'completed'; taskIds: number[]; changed: number }
  | { kind: 'snoozed'; taskIds: number[]; until: Date };

/**
 * Lee las tareas de los datos de un aviso.
 *
 * @pre Ninguna (los datos vienen de la notificación).
 * @post Devuelve los `taskIds` enteros positivos de `data`, sin repetir; vacío
 *       si no hay o no tienen la forma esperada.
 */
export function alertTaskIds(data: unknown): number[] {
  const ids = (data as { taskIds?: unknown } | null | undefined)?.taskIds;
  if (!Array.isArray(ids)) return [];
  return [...new Set(ids.filter((id): id is number => Number.isInteger(id) && id > 0))];
}

/**
 * Pantalla que abre tocar un aviso (US-6.1).
 *
 * @pre Ninguna.
 * @post Devuelve `/tasks/<id>` de la primera tarea del aviso, o `null` si no trae tareas.
 */
export function routeForAlert(data: unknown): string | null {
  const [first] = alertTaskIds(data);
  return first === undefined ? null : `/tasks/${first}`;
}

/**
 * Ejecuta un botón de un aviso sin abrir la app (US-6.3).
 *
 * @pre Las migraciones están aplicadas.
 * @post `'complete'`: las tareas pendientes del aviso quedan completadas, se
 *       re-registran las geocercas (así se cancelan las suyas) y se quita el
 *       aviso. `'snooze'`: las tareas y sus rubros quedan pospuestos
 *       `SNOOZE_MS` (US-6.2) y se quita el aviso. Repetir la misma acción no
 *       cambia el resultado. Otra acción, o un aviso sin tareas: `'ignored'`.
 * @throws Errores de la base de datos o de `resync`; quitar el aviso nunca falla.
 */
export async function handleAlertAction(
  deps: AlertActionDeps,
  action: string,
  data: unknown,
  notificationId: string,
): Promise<AlertActionOutcome> {
  const taskIds = alertTaskIds(data);
  if (taskIds.length === 0) return { kind: 'ignored' };
  const { repos, now } = deps;

  if (action === ALERT_ACTIONS.complete) {
    const changed = await repos.tasks.completeMany(taskIds, now);
    await deps.resync();
    await deps.dismiss(notificationId).catch(() => undefined);
    return { kind: 'completed', taskIds, changed };
  }
  if (action === ALERT_ACTIONS.snooze) {
    const until = new Date(now.getTime() + SNOOZE_MS);
    repos.tasks.snooze(taskIds, until);
    await deps.dismiss(notificationId).catch(() => undefined);
    return { kind: 'snoozed', taskIds, until };
  }
  return { kind: 'ignored' };
}
