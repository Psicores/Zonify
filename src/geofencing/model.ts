import type { GeofenceState, GeofenceTrigger, LocationTarget, Task } from '../db/schema';
import { distanceMeters, type Coordinates } from '../places/geo';

/** Nombre de la tarea de fondo que recibe las transiciones de geocerca. */
export const GEOFENCE_TASK_NAME = 'zonify-geofences';

/**
 * Regiones que el sistema operativo monitorea a la vez por app: iOS admite 20
 * y Android 100.
 */
export const MAX_REGIONS = { ios: 20, android: 100 } as const;

/**
 * Tiempo mínimo entre dos avisos del mismo trigger. Evita una ráfaga de
 * notificaciones si el GPS salta varias veces sobre el borde de la geocerca.
 */
export const NOTIFICATION_COOLDOWN_MS = 10 * 60_000;

const REGION_PREFIX = 'trigger:';

export type GeofenceEvent = 'enter' | 'exit';

/** Región en el formato de `Location.startGeofencingAsync`. */
export interface GeofenceRegion {
  identifier: string;
  latitude: number;
  longitude: number;
  radius: number;
  notifyOnEnter: boolean;
  notifyOnExit: boolean;
}

/** Trigger listo para registrar, con su tarea y su lugar (ver `listArmed`). */
export interface ArmedTrigger {
  trigger: GeofenceTrigger;
  task: Task;
  locationTarget: LocationTarget;
}

/**
 * Identificador de la región de un trigger.
 *
 * @pre `triggerId` es el id de un trigger.
 * @post Devuelve `trigger:<id>`, que `parseRegionIdentifier` convierte de vuelta.
 */
export function regionIdentifier(triggerId: number): string {
  return `${REGION_PREFIX}${triggerId}`;
}

/**
 * Recupera el id del trigger a partir del identificador de una región.
 *
 * @pre Ninguna (el valor viene del sistema operativo).
 * @post Devuelve el id si `identifier` tiene la forma `trigger:<entero positivo>`;
 *       si no, `null`.
 */
export function parseRegionIdentifier(identifier: unknown): number | null {
  if (typeof identifier !== 'string' || !identifier.startsWith(REGION_PREFIX)) return null;
  const id = Number(identifier.slice(REGION_PREFIX.length));
  return Number.isInteger(id) && id > 0 ? id : null;
}

/**
 * Elige y arma las regiones a registrar en el sistema operativo.
 *
 * @pre `armed` contiene solo triggers activos de tareas pendientes; `limit` ≥ 0.
 * @post Devuelve una región por trigger de entrada o de salida (los `'dwell'`
 *       se omiten: el geofencing nativo de Expo no los admite), todas avisando al
 *       entrar y al salir para mantener `lastState` al día. Si hay más de
 *       `limit`, se quedan las más cercanas a `position` (o, sin posición, las de
 *       triggers más recientes). El resultado está ordenado por `identifier`.
 */
export function buildRegions(
  armed: readonly ArmedTrigger[],
  position: Coordinates | null,
  limit: number,
): GeofenceRegion[] {
  const candidates = armed.filter(({ trigger }) => trigger.transition !== 'dwell');
  const ranked = position
    ? [...candidates].sort(
        (a, b) => distanceMeters(position, a.locationTarget) - distanceMeters(position, b.locationTarget),
      )
    : [...candidates].sort((a, b) => b.trigger.id - a.trigger.id);

  return ranked
    .slice(0, limit)
    .map(({ trigger, locationTarget }) => ({
      identifier: regionIdentifier(trigger.id),
      latitude: locationTarget.latitude,
      longitude: locationTarget.longitude,
      radius: locationTarget.radiusMeters,
      notifyOnEnter: true,
      notifyOnExit: true,
    }))
    .sort((a, b) => a.identifier.localeCompare(b.identifier));
}

/**
 * Resume un conjunto de regiones para saber si cambió.
 *
 * @pre Ninguna (acepta lo que guardó el sistema operativo).
 * @post Devuelve el mismo texto para dos conjuntos con iguales identificadores,
 *       centros (redondeados a 1e-6°) y radios, sin importar el orden; los
 *       elementos sin la forma esperada se ignoran.
 */
export function regionsSignature(regions: unknown): string {
  if (!Array.isArray(regions)) return '';
  return regions
    .filter(
      (r): r is GeofenceRegion =>
        typeof r?.identifier === 'string' &&
        typeof r.latitude === 'number' &&
        typeof r.longitude === 'number' &&
        typeof r.radius === 'number',
    )
    .map((r) => `${r.identifier}@${r.latitude.toFixed(6)},${r.longitude.toFixed(6)}/${Math.round(r.radius)}`)
    .sort()
    .join('|');
}

export interface GeofenceDecision {
  /** Estado a guardar en el trigger. */
  nextState: GeofenceState;
  /** `true` si hay que avisarle al usuario. */
  notify: boolean;
}

/**
 * Decide qué hacer con una transición informada por el sistema operativo.
 *
 * @pre `now` y `lastNotifiedAt` están en la misma escala de tiempo.
 * @post `nextState` es `'inside'` al entrar y `'outside'` al salir. `notify` es
 *       `true` solo si el trigger está activo, su tarea pendiente, la transición
 *       coincide con la del trigger, el estado anterior no era ya el nuevo (al
 *       registrar las regiones Android repite el estado actual, y eso no es un
 *       cruce) y no hubo otro aviso del trigger en `NOTIFICATION_COOLDOWN_MS`.
 */
export function decideGeofenceEvent(input: {
  event: GeofenceEvent;
  trigger: GeofenceTrigger;
  taskStatus: Task['status'];
  lastNotifiedAt: Date | null;
  now: Date;
}): GeofenceDecision {
  const { event, trigger, taskStatus, lastNotifiedAt, now } = input;
  const nextState: GeofenceState = event === 'enter' ? 'inside' : 'outside';
  const coolingDown =
    lastNotifiedAt !== null && now.getTime() - lastNotifiedAt.getTime() < NOTIFICATION_COOLDOWN_MS;
  const notify =
    trigger.isActive &&
    taskStatus === 'pending' &&
    trigger.transition === event &&
    trigger.lastState !== nextState &&
    !coolingDown;
  return { nextState, notify };
}

/**
 * Texto del aviso de una tarea al cruzar su geocerca.
 *
 * @pre `event` es la transición del trigger que avisa.
 * @post El título es el de la tarea y el cuerpo dice si se llegó al lugar o se salió de él.
 */
export function notificationContent(
  event: GeofenceEvent,
  taskTitle: string,
  placeName: string,
): { title: string; body: string } {
  return {
    title: taskTitle,
    body: event === 'enter' ? `Estás en ${placeName}` : `Saliste de ${placeName}`,
  };
}
