import type { Href } from 'expo-router';

import type { Repositories } from '../db/repositories';
import { claimAlertResponse, SNOOZE_MS } from '../settings/appSettings';
import { ALERT_ACTIONS } from './setup';

export interface AlertActionDeps {
  repos: Repositories;
  /** Vuelve a registrar las geocercas (las de tareas completadas desaparecen). */
  resync: () => Promise<unknown>;
  now: Date;
}

export type AlertActionOutcome =
  | { kind: 'ignored' }
  | { kind: 'duplicate' }
  | { kind: 'completed'; taskIds: number[]; changed: number; resynced: boolean }
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
 * Datos de un aviso a partir de su contenido (US-1.1).
 *
 * @pre Ninguna.
 * @post Devuelve `content.data` si está. Si no, `content.dataString` interpretado
 *       como JSON: así llegan los datos de un aviso local a la tarea de fondo de
 *       Android, porque expo-notifications solo los convierte para los oyentes
 *       de React. `null` si no hay datos o el JSON es inválido.
 */
export function notificationContentData(content: unknown): unknown {
  const fields = content as { data?: unknown; dataString?: unknown } | null | undefined;
  if (fields?.data != null) return fields.data;
  if (typeof fields?.dataString !== 'string') return null;
  try {
    return JSON.parse(fields.dataString) as unknown;
  } catch {
    return null;
  }
}

/**
 * Clave que identifica una respuesta a un aviso, para atenderla una sola vez.
 *
 * @pre Ninguna.
 * @post Devuelve `<id del aviso>/<acción>`.
 */
export function alertResponseKey(notificationId: string, action: string): string {
  return `${notificationId}/${action}`;
}

/**
 * Pantalla que abre tocar un aviso (US-6.1), como ruta tipada (US-3.3).
 *
 * @pre Ninguna.
 * @post Devuelve el detalle (`/tasks/[id]`) de la primera tarea del aviso, o
 *       `null` si no trae tareas.
 */
export function routeForAlert(data: unknown): Href | null {
  const [first] = alertTaskIds(data);
  return first === undefined ? null : { pathname: '/tasks/[id]', params: { id: first } };
}

/**
 * Ejecuta un botón de un aviso sin abrir la app (US-6.3, US-1.1). Quitar el
 * aviso de la bandeja le toca a quien llama, antes de esperar en `eventQueue`.
 *
 * @pre Las migraciones están aplicadas.
 * @post Otra acción, o un aviso sin tareas: `'ignored'` sin escribir. Si la
 *       respuesta `responseKey` ya se atendió (Android la entrega a la tarea de
 *       fondo y otra vez a la app al abrirla): `'duplicate'` sin escribir.
 *       `'complete'`: las tareas pendientes del aviso quedan completadas con
 *       `completedAt = now` y se re-registran las geocercas (así se cancelan las
 *       suyas); si eso falla, la tarea igual queda completada y `resynced` es
 *       `false`. `'snooze'`: las tareas y sus rubros quedan pospuestos
 *       `SNOOZE_MS` (US-6.2).
 * @throws Errores de la base de datos.
 */
export async function handleAlertAction(
  deps: AlertActionDeps,
  action: string,
  data: unknown,
  responseKey: string,
): Promise<AlertActionOutcome> {
  const taskIds = alertTaskIds(data);
  if (taskIds.length === 0) return { kind: 'ignored' };
  if (action !== ALERT_ACTIONS.complete && action !== ALERT_ACTIONS.snooze) return { kind: 'ignored' };
  const { repos, now } = deps;
  if (!(await claimAlertResponse(repos, responseKey))) return { kind: 'duplicate' };

  if (action === ALERT_ACTIONS.complete) {
    const changed = await repos.tasks.completeMany(taskIds, now);
    const resynced = await deps.resync().then(
      () => true,
      () => false,
    );
    return { kind: 'completed', taskIds, changed, resynced };
  }
  const until = new Date(now.getTime() + SNOOZE_MS);
  repos.tasks.snooze(taskIds, until);
  return { kind: 'snoozed', taskIds, until };
}
