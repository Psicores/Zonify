import type { Repositories } from '../db/repositories';
import type { Task } from '../db/schema';
import { distanceMeters, type Coordinates } from '../places/geo';
import { getPoiCooldownHours } from '../settings/appSettings';
import { isWithinAlertWindow, scheduleOf } from '../tasks/schedule';
import {
  alertContent,
  CATEGORY_COOLDOWN_MS,
  decideGeofenceEvent,
  HIGHWAY_SPEED_MPS,
  isSnoozed,
  parseRegionIdentifier,
  type GeofenceEvent,
  type MotionFix,
} from './model';

/** Datos que viajan con la notificación: qué tareas abrir o resolver desde ella. */
export interface GeofenceNotificationData {
  taskIds: number[];
  triggerId?: number;
  poiId?: number;
  /** `true` si el aviso va sin sonido ni vibración (fuera del horario de las tareas, US-5.2). */
  silent: boolean;
}

export interface GeofenceEventDeps {
  repos: Repositories;
  /** Muestra el aviso y devuelve el id que le asignó el sistema. */
  notify: (content: { title: string; body: string }, data: GeofenceNotificationData) => Promise<string>;
  /** Vuelve a elegir y registrar las geocercas alrededor de la posición actual. */
  replan: () => Promise<unknown>;
  /** Posición reciente del usuario, si la hay (para la distancia y la velocidad). */
  currentFix: () => Promise<MotionFix | null>;
  now: Date;
}

export type GeofenceEventOutcome =
  | { kind: 'unknown-region' }
  | { kind: 'ignored' }
  | { kind: 'replanned' }
  | { kind: 'stale'; regionId: number }
  | { kind: 'recorded'; regionId: number; reason: string }
  | { kind: 'notified'; regionId: number; taskIds: number[] }
  | { kind: 'notify-failed'; regionId: number; message: string };

/**
 * Muestra un aviso y lo guarda en `notification_logs`, una fila por tarea.
 *
 * @pre `data.taskIds` no está vacío y sus tareas existen.
 * @post Si `notify` funciona, cada tarea tiene una fila `'delivered'` con el id
 *       del sistema y devuelve `'notified'`; si falla, filas `'failed'` y
 *       devuelve `'notify-failed'`. Las filas guardan si el aviso fue
 *       silencioso y, si lo disparó un local de rubro, su `poiOsmKey`.
 * @throws Errores de la base de datos.
 */
async function notifyAndLog(
  deps: GeofenceEventDeps,
  regionId: number,
  content: { title: string; body: string },
  data: GeofenceNotificationData,
  event: GeofenceEvent,
  poiOsmKey: string | null,
): Promise<GeofenceEventOutcome> {
  const { repos, notify, now } = deps;
  const base = {
    geofenceTriggerId: data.triggerId ?? null,
    poiOsmKey,
    transition: event,
    ...content,
    silent: data.silent,
    firedAt: now,
  };
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
 * Indica si una tarea está pospuesta, ella o su rubro (US-6.2).
 *
 * @pre Ninguna.
 * @post Devuelve `true` si la tarea o su categoría tienen `snoozedUntil` posterior a `now`.
 * @throws Errores de la base de datos.
 */
async function taskSnoozed(repos: Repositories, task: Task, now: Date): Promise<boolean> {
  if (isSnoozed(task.snoozedUntil, now)) return true;
  if (task.categoryId === null) return false;
  const category = await repos.categories.getById(task.categoryId);
  return isSnoozed(category?.snoozedUntil, now);
}

/**
 * Distancia desde la posición actual hasta un punto.
 *
 * @pre Ninguna.
 * @post Devuelve los metros, o `null` si no hay posición.
 */
function distanceFrom(fix: MotionFix | null, point: Coordinates): number | null {
  return fix ? distanceMeters(fix, point) : null;
}

/**
 * Procesa una transición de la geocerca de un lugar propio (US-3.2).
 *
 * @pre Las migraciones están aplicadas.
 * @post Si el trigger ya no existe devuelve `'stale'` sin escribir. Si no,
 *       `lastState`/`lastTransitionAt` quedan al día y, cuando
 *       `decideGeofenceEvent` lo indica (con el enfriamiento por lugar
 *       configurado y la posposición de la tarea o su rubro), avisa con
 *       `notifyAndLog`: «📍 <lugar> (a Xm)» y la tarea, en silencio si está fuera
 *       de su ventana de avisos. Sin aviso devuelve `'recorded'`.
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
    snoozed: await taskSnoozed(repos, trigger.task, now),
    lastNotifiedAt: await repos.notificationLogs.lastFiredAtForTrigger(triggerId),
    cooldownMs: (await getPoiCooldownHours(repos)) * 60 * 60_000,
    now,
  });
  await repos.geofenceTriggers.recordState(triggerId, decision.nextState, now);
  if (!decision.notify) return { kind: 'recorded', regionId: triggerId, reason: 'regla' };

  const content = alertContent({
    event,
    placeName: trigger.locationTarget.name,
    distanceMeters: distanceFrom(await deps.currentFix(), trigger.locationTarget),
    taskTitles: [trigger.task.title],
  });
  const silent = !isWithinAlertWindow(scheduleOf(trigger.task), now);
  return notifyAndLog(deps, triggerId, content, { taskIds: [trigger.taskId], triggerId, silent }, event, null);
}

/**
 * Procesa la entrada a la geocerca de un local de rubro (US-4.2, US-6.1, US-6.2).
 *
 * @pre Las migraciones están aplicadas.
 * @post Las salidas se ignoran. Si el local ya no está en el caché devuelve
 *       `'stale'`. No avisa (`'recorded'`) si el local avisó dentro del
 *       enfriamiento configurado, si el usuario va a velocidad de autopista
 *       (`HIGHWAY_SPEED_MPS`) o si no queda ninguna tarea: se descartan las
 *       pospuestas (ellas o su rubro) y las avisadas hace menos de
 *       `CATEGORY_COOLDOWN_MS`. Si queda alguna, las avisa juntas con
 *       `notifyAndLog`: «📍 <local> (a Xm)» y las tareas, sonando si alguna está
 *       dentro de su ventana de avisos.
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
  const osmKey = rows[0].osmKey;

  const cooldownMs = (await getPoiCooldownHours(repos)) * 60 * 60_000;
  const lastForPoi = await repos.notificationLogs.lastFiredAtForPoi(osmKey);
  if (lastForPoi && now.getTime() - lastForPoi.getTime() < cooldownMs) {
    return { kind: 'recorded', regionId: poiId, reason: 'enfriamiento del local' };
  }
  const fix = await deps.currentFix();
  if (fix?.speed != null && fix.speed >= HIGHWAY_SPEED_MPS) {
    return { kind: 'recorded', regionId: poiId, reason: 'velocidad de autopista' };
  }

  const tasks = await repos.tasks.listPendingInCategories(rows.map((row) => row.categoryId));
  const eligible: Task[] = [];
  for (const task of tasks) {
    if (await taskSnoozed(repos, task, now)) continue;
    const last = await repos.notificationLogs.lastFiredAtForTask(task.id);
    if (last === null || now.getTime() - last.getTime() >= CATEGORY_COOLDOWN_MS) eligible.push(task);
  }
  if (eligible.length === 0) return { kind: 'recorded', regionId: poiId, reason: 'sin tareas para avisar' };

  const poi = rows.find((row) => row.name) ?? rows[0];
  const category = poi.name ? undefined : await repos.categories.getById(poi.categoryId);
  const content = alertContent({
    event,
    placeName: poi.name ?? category?.name ?? 'Un local',
    distanceMeters: distanceFrom(fix, poi),
    taskTitles: eligible.map((t) => t.title),
  });
  const silent = !eligible.some((task) => isWithinAlertWindow(scheduleOf(task), now));
  return notifyAndLog(
    deps,
    poiId,
    content,
    { taskIds: eligible.map((t) => t.id), poiId, silent },
    event,
    osmKey,
  );
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
