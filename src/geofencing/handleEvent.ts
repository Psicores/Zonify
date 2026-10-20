import type { Repositories } from '../db/repositories';
import {
  CATEGORY_COOLDOWN_MS,
  categoryNotificationContent,
  decideGeofenceEvent,
  notificationContent,
  parseRegionIdentifier,
  type GeofenceEvent,
} from './model';

/** Datos que viajan con la notificación (para abrir la tarea al tocarla). */
export interface GeofenceNotificationData {
  taskIds: number[];
  triggerId?: number;
  poiId?: number;
}

export interface GeofenceEventDeps {
  repos: Repositories;
  /** Muestra el aviso y devuelve el id que le asignó el sistema. */
  notify: (content: { title: string; body: string }, data: GeofenceNotificationData) => Promise<string>;
  /** Vuelve a elegir y registrar las geocercas alrededor de la posición actual. */
  replan: () => Promise<unknown>;
  now: Date;
}

export type GeofenceEventOutcome =
  | { kind: 'unknown-region' }
  | { kind: 'ignored' }
  | { kind: 'replanned' }
  | { kind: 'stale'; regionId: number }
  | { kind: 'recorded'; regionId: number }
  | { kind: 'notified'; regionId: number; taskIds: number[] }
  | { kind: 'notify-failed'; regionId: number; message: string };

/**
 * Muestra un aviso y lo guarda en `notification_logs`, una fila por tarea.
 *
 * @pre `taskIds` no está vacío y sus tareas existen.
 * @post Si `notify` funciona, cada tarea tiene una fila `'delivered'` con el id
 *       del sistema y devuelve `'notified'`; si falla, filas `'failed'` y
 *       devuelve `'notify-failed'`.
 * @throws Errores de la base de datos.
 */
async function notifyAndLog(
  deps: GeofenceEventDeps,
  regionId: number,
  content: { title: string; body: string },
  data: GeofenceNotificationData,
  event: GeofenceEvent,
): Promise<GeofenceEventOutcome> {
  const { repos, notify, now } = deps;
  const base = { geofenceTriggerId: data.triggerId ?? null, transition: event, ...content, firedAt: now };
  try {
    const platformNotificationId = await notify(content, data);
    for (const taskId of data.taskIds) {
      await repos.notificationLogs.create({ ...base, taskId, status: 'delivered', platformNotificationId });
    }
    return { kind: 'notified', regionId, taskIds: data.taskIds };
  } catch (e) {
    for (const taskId of data.taskIds) {
      await repos.notificationLogs.create({ ...base, taskId, status: 'failed' });
    }
    return { kind: 'notify-failed', regionId, message: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Procesa una transición de la geocerca de un lugar propio (US-3.2).
 *
 * @pre Las migraciones están aplicadas.
 * @post Si el trigger ya no existe devuelve `'stale'` sin escribir. Si no,
 *       `lastState`/`lastTransitionAt` quedan al día y, cuando
 *       `decideGeofenceEvent` lo indica, se avisa con `notifyAndLog`; sin aviso
 *       devuelve `'recorded'`.
 * @throws Errores de la base de datos.
 */
async function handleTriggerEvent(
  deps: GeofenceEventDeps,
  event: GeofenceEvent,
  triggerId: number,
): Promise<GeofenceEventOutcome> {
  const { repos, now } = deps;
  const trigger = await repos.geofenceTriggers.getById(triggerId);
  if (!trigger) return { kind: 'stale', regionId: triggerId };

  const decision = decideGeofenceEvent({
    event,
    trigger,
    taskStatus: trigger.task.status,
    lastNotifiedAt: await repos.notificationLogs.lastFiredAtForTrigger(triggerId),
    now,
  });
  await repos.geofenceTriggers.recordState(triggerId, decision.nextState, now);
  if (!decision.notify) return { kind: 'recorded', regionId: triggerId };

  const content = notificationContent(event, trigger.task.title, trigger.locationTarget.name);
  return notifyAndLog(deps, triggerId, content, { taskIds: [trigger.taskId], triggerId }, event);
}

/**
 * Procesa la entrada a la geocerca de un local de rubro (US-4.2).
 *
 * @pre Las migraciones están aplicadas.
 * @post Las salidas se ignoran. Si el local ya no está en el caché devuelve
 *       `'stale'`. Si no, busca las tareas pendientes ancladas solo a alguno de
 *       los rubros del local y descarta las avisadas hace menos de
 *       `CATEGORY_COOLDOWN_MS`; si queda alguna, las avisa juntas en una sola
 *       notificación con `notifyAndLog`, y si no, devuelve `'recorded'`.
 * @throws Errores de la base de datos.
 */
async function handlePoiEvent(
  deps: GeofenceEventDeps,
  event: GeofenceEvent,
  poiId: number,
): Promise<GeofenceEventOutcome> {
  if (event !== 'enter') return { kind: 'ignored' };
  const { repos, now } = deps;
  const rows = await repos.pois.listSameOsmElement(poiId);
  if (rows.length === 0) return { kind: 'stale', regionId: poiId };

  const tasks = await repos.tasks.listPendingInCategories(rows.map((row) => row.categoryId));
  const eligible = [];
  for (const task of tasks) {
    const last = await repos.notificationLogs.lastFiredAtForTask(task.id);
    if (last === null || now.getTime() - last.getTime() >= CATEGORY_COOLDOWN_MS) eligible.push(task);
  }
  if (eligible.length === 0) return { kind: 'recorded', regionId: poiId };

  const poi = rows.find((row) => row.name) ?? rows[0];
  const category = poi.name ? undefined : await repos.categories.getById(poi.categoryId);
  const placeName = poi.name ?? category?.name ?? 'Un local';
  const content = categoryNotificationContent(eligible, placeName);
  return notifyAndLog(deps, poiId, content, { taskIds: eligible.map((t) => t.id), poiId }, event);
}

/**
 * Procesa una transición informada por el sistema operativo.
 *
 * @pre Las migraciones están aplicadas; `identifier` es el de la región.
 * @post Región ajena: `'unknown-region'` sin escribir. Centinela: al salir
 *       llama a `replan` (`'replanned'`), al entrar no hace nada (`'ignored'`).
 *       Lugar propio: ver `handleTriggerEvent`. Local de rubro: ver `handlePoiEvent`.
 * @throws Errores de la base de datos o de `replan`.
 */
export async function handleGeofenceEvent(
  deps: GeofenceEventDeps,
  event: GeofenceEvent,
  identifier: unknown,
): Promise<GeofenceEventOutcome> {
  const ref = parseRegionIdentifier(identifier);
  if (!ref) return { kind: 'unknown-region' };
  switch (ref.kind) {
    case 'sentinel':
      if (event !== 'exit') return { kind: 'ignored' };
      await deps.replan();
      return { kind: 'replanned' };
    case 'trigger':
      return handleTriggerEvent(deps, event, ref.id);
    case 'poi':
      return handlePoiEvent(deps, event, ref.id);
  }
}
