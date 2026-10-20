import type { Repositories } from '../db/repositories';
import {
  decideGeofenceEvent,
  notificationContent,
  parseRegionIdentifier,
  type GeofenceEvent,
} from './model';

export interface GeofenceEventDeps {
  repos: Repositories;
  /** Muestra el aviso y devuelve el id que le asignó el sistema. */
  notify: (
    content: { title: string; body: string },
    data: { taskId: number; triggerId: number },
  ) => Promise<string>;
  now: Date;
}

export type GeofenceEventOutcome =
  | { kind: 'unknown-region' }
  | { kind: 'stale'; triggerId: number }
  | { kind: 'recorded'; triggerId: number }
  | { kind: 'notified'; triggerId: number; notificationLogId: number }
  | { kind: 'notify-failed'; triggerId: number; message: string };

/**
 * Procesa una transición de geocerca: guarda el estado del trigger y, si
 * corresponde, avisa al usuario y lo registra en `notification_logs`.
 *
 * @pre Las migraciones están aplicadas; `identifier` es el de la región que
 *      informó el sistema operativo.
 * @post Si la región no es de la app devuelve `'unknown-region'`, y si su
 *       trigger ya no existe, `'stale'` (la próxima sincronización la quita); en
 *       ambos casos no escribe nada. Si no, `lastState`/`lastTransitionAt` del
 *       trigger quedan al día; cuando `decideGeofenceEvent` dice que hay que
 *       avisar, llama a `notify` y guarda el aviso con `status = 'delivered'`
 *       (`'notified'`) o, si `notify` falla, con `status = 'failed'`
 *       (`'notify-failed'`). Sin aviso devuelve `'recorded'`.
 * @throws Errores de la base de datos.
 */
export async function handleGeofenceEvent(
  deps: GeofenceEventDeps,
  event: GeofenceEvent,
  identifier: unknown,
): Promise<GeofenceEventOutcome> {
  const { repos, notify, now } = deps;
  const triggerId = parseRegionIdentifier(identifier);
  if (triggerId === null) return { kind: 'unknown-region' };

  const trigger = await repos.geofenceTriggers.getById(triggerId);
  if (!trigger) return { kind: 'stale', triggerId };

  const decision = decideGeofenceEvent({
    event,
    trigger,
    taskStatus: trigger.task.status,
    lastNotifiedAt: await repos.notificationLogs.lastFiredAtForTrigger(triggerId),
    now,
  });
  await repos.geofenceTriggers.recordState(triggerId, decision.nextState, now);
  if (!decision.notify) return { kind: 'recorded', triggerId };

  const content = notificationContent(event, trigger.task.title, trigger.locationTarget.name);
  const base = {
    taskId: trigger.taskId,
    geofenceTriggerId: triggerId,
    transition: event,
    title: content.title,
    body: content.body,
    firedAt: now,
  };
  try {
    const platformNotificationId = await notify(content, { taskId: trigger.taskId, triggerId });
    const log = await repos.notificationLogs.create({ ...base, status: 'delivered', platformNotificationId });
    return { kind: 'notified', triggerId, notificationLogId: log.id };
  } catch (e) {
    await repos.notificationLogs.create({ ...base, status: 'failed' });
    return { kind: 'notify-failed', triggerId, message: e instanceof Error ? e.message : String(e) };
  }
}
