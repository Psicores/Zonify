import type { Repositories } from '../db/repositories';
import type { Task } from '../db/schema';
import { distanceMeters, type Coordinates } from '../places/geo';
import { clampRadius } from '../places/model';
import { getPoiCooldownHours } from '../settings/appSettings';
import { isWithinAlertWindow, scheduleOf } from '../tasks/schedule';
import {
  alertContent,
  CATEGORY_COOLDOWN_MS,
  classifyMotion,
  decideGeofenceEvent,
  HIGHWAY_SPEED_MPS,
  isCoolingDown,
  isSnoozed,
  judgeProximity,
  latestDate,
  MOTION_PROFILES,
  parseRegionIdentifier,
  PROXIMITY_CHECK_ATTEMPTS,
  PROXIMITY_RETRY_MS,
  type GeofenceEvent,
  type MotionFix,
  type ProximityVerdict,
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
  /** Posición actual del usuario, lo más precisa posible (cercanía, distancia y velocidad). */
  currentFix: () => Promise<MotionFix | null>;
  /** Espera entre dos intentos de confirmar la cercanía. */
  wait: (ms: number) => Promise<void>;
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
 * Hasta cuándo se pospuso una tarea, ella o su rubro (US-6.2, US-1.2).
 *
 * @pre Ninguna.
 * @post Devuelve el `snoozedUntil` más tardío entre la tarea y su categoría,
 *       aunque ya haya vencido (sirve para cortar el enfriamiento), o `null`
 *       si nunca se pospusieron.
 * @throws Errores de la base de datos.
 */
async function snoozedUntilFor(repos: Repositories, task: Task): Promise<Date | null> {
  if (task.categoryId === null) return task.snoozedUntil;
  const category = await repos.categories.getById(task.categoryId);
  return latestDate(task.snoozedUntil, category?.snoozedUntil);
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

/** Por qué no se avisó cuando la cercanía no se pudo confirmar. */
const PROXIMITY_REASONS: Record<Exclude<ProximityVerdict, 'near'>, string> = {
  imprecise: 'precisión insuficiente',
  far: 'todavía lejos',
};

/**
 * Confirma con posiciones precisas que el usuario llegó (calibración de
 * proximidad): la geocerca del sistema es más grande que el radio de aviso y
 * puede dispararse por un salto de antena.
 *
 * @pre Ninguna.
 * @post Pide hasta `PROXIMITY_CHECK_ATTEMPTS` posiciones con `deps.currentFix`,
 *       esperando `PROXIMITY_RETRY_MS` (`deps.wait`) entre una y otra, y
 *       termina en cuanto `judgeProximity` da `'near'` con el radio
 *       `alertRadiusFor(posición)`. Devuelve el veredicto de la última y la
 *       última posición obtenida (o `null` si no hubo ninguna).
 */
async function confirmProximity(
  deps: GeofenceEventDeps,
  point: Coordinates,
  alertRadiusFor: (fix: MotionFix | null) => number,
): Promise<{ verdict: ProximityVerdict; fix: MotionFix | null }> {
  let result: { verdict: ProximityVerdict; fix: MotionFix | null } = { verdict: 'imprecise', fix: null };
  for (let attempt = 0; attempt < PROXIMITY_CHECK_ATTEMPTS; attempt++) {
    if (attempt > 0) await deps.wait(PROXIMITY_RETRY_MS);
    const fix = await deps.currentFix();
    result = { verdict: judgeProximity(fix, point, alertRadiusFor(fix)), fix: fix ?? result.fix };
    if (result.verdict === 'near') break;
  }
  return result;
}

/**
 * Radio de aviso de un local de rubro según cómo se mueve el usuario.
 *
 * @pre Ninguna.
 * @post `poiAlertRadius` del perfil de `classifyMotion` con la velocidad de `fix`.
 */
function poiAlertRadius(fix: MotionFix | null): number {
  return MOTION_PROFILES[classifyMotion(fix?.speed ?? null)].poiAlertRadius;
}

/**
 * Procesa una transición de la geocerca de un lugar propio (US-3.2).
 *
 * @pre Las migraciones están aplicadas.
 * @post Si el trigger ya no existe devuelve `'stale'` sin escribir. Si no,
 *       `lastState`/`lastTransitionAt` quedan al día y, cuando
 *       `decideGeofenceEvent` lo indica (con el enfriamiento por lugar
 *       configurado y la posposición de la tarea o su rubro, que lo corta al
 *       vencer), avisa con
 *       `notifyAndLog`: «📍 <lugar> (a Xm)» y la tarea, en silencio si está fuera
 *       de su ventana de avisos. Al entrar, antes de avisar confirma con
 *       `confirmProximity` que el usuario está al radio guardado del lugar o
 *       menos; si no se confirma, no avisa. Sin aviso devuelve `'recorded'`.
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
    snoozedUntil: await snoozedUntilFor(repos, trigger.task),
    lastNotifiedAt: await repos.notificationLogs.lastFiredAtForTrigger(triggerId),
    cooldownMs: (await getPoiCooldownHours(repos)) * 60 * 60_000,
    now,
  });
  await repos.geofenceTriggers.recordState(triggerId, decision.nextState, now);
  if (!decision.notify) return { kind: 'recorded', regionId: triggerId, reason: 'regla' };

  // Al salir no hay cercanía que confirmar: el aviso es justamente que se fue.
  let fix: MotionFix | null = null;
  if (event === 'enter') {
    const alertRadius = clampRadius(trigger.locationTarget.radiusMeters);
    const proximity = await confirmProximity(deps, trigger.locationTarget, () => alertRadius);
    if (proximity.verdict !== 'near') {
      return { kind: 'recorded', regionId: triggerId, reason: PROXIMITY_REASONS[proximity.verdict] };
    }
    fix = proximity.fix;
  }
  const content = alertContent({
    event,
    placeName: trigger.locationTarget.name,
    distanceMeters: distanceFrom(fix, trigger.locationTarget),
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
 *       `'stale'`. No avisa (`'recorded'`) si el local sigue en enfriamiento
 *       (`isCoolingDown`: el configurado desde su último aviso, o hasta que
 *       venza la posposición de su rubro si fue posterior a ese aviso, US-1.2),
 *       si no queda ninguna tarea (se descartan las pospuestas, ellas o su
 *       rubro, y las avisadas hace menos de `CATEGORY_COOLDOWN_MS`), si
 *       `confirmProximity` no confirma que el usuario está al radio de aviso
 *       del local (`poiAlertRadius`: 80 m, 100 m en vehículo) o menos, o si va a
 *       velocidad de autopista (`HIGHWAY_SPEED_MPS`). Si no, avisa las tareas
 *       juntas con `notifyAndLog`: «📍 <local> (a Xm)», sonando si alguna está
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
  const categories = await Promise.all(
    [...new Set(rows.map((row) => row.categoryId))].map((id) => repos.categories.getById(id)),
  );
  const categorySnoozedUntil = latestDate(...categories.map((category) => category?.snoozedUntil));
  if (isCoolingDown(lastForPoi, cooldownMs, categorySnoozedUntil, now)) {
    return { kind: 'recorded', regionId: poiId, reason: 'enfriamiento del local' };
  }

  const tasks = await repos.tasks.listPendingInCategories(rows.map((row) => row.categoryId));
  const eligible: Task[] = [];
  for (const task of tasks) {
    if (isSnoozed(await snoozedUntilFor(repos, task), now)) continue;
    const last = await repos.notificationLogs.lastFiredAtForTask(task.id);
    if (last === null || now.getTime() - last.getTime() >= CATEGORY_COOLDOWN_MS) eligible.push(task);
  }
  if (eligible.length === 0) return { kind: 'recorded', regionId: poiId, reason: 'sin tareas para avisar' };

  // Lo caro (pedir posiciones) va después de lo que solo lee la base.
  const poi = rows.find((row) => row.name) ?? rows[0];
  const { verdict, fix } = await confirmProximity(deps, poi, poiAlertRadius);
  if (verdict !== 'near') return { kind: 'recorded', regionId: poiId, reason: PROXIMITY_REASONS[verdict] };
  if (fix?.speed != null && fix.speed >= HIGHWAY_SPEED_MPS) {
    return { kind: 'recorded', regionId: poiId, reason: 'velocidad de autopista' };
  }

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
