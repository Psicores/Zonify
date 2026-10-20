import type { GeofenceState, GeofenceTrigger, LocationTarget, Poi, Task } from '../db/schema';
import { distanceMeters, type Coordinates } from '../places/geo';

/** Nombre de la tarea de fondo que recibe las transiciones de geocerca. */
export const GEOFENCE_TASK_NAME = 'zonify-geofences';

/**
 * Regiones que la app registra a la vez como máximo. iOS admite 20 por app; se
 * dejan 2 libres de margen (criterio de US-4.2: nunca más de 18). Android admite 100.
 */
export const MAX_REGIONS = { ios: 18, android: 100 } as const;

/** Máximo de geocercas de locales por rubro (US-4.2: «las 15 más cercanas»). */
export const POI_REGION_LIMIT = 15;
/** Lugares por rubro garantizados aunque haya muchos lugares propios (si hay locales). */
export const MIN_POI_SLOTS = 5;
/** Radio de la geocerca de cada local de rubro. */
export const POI_REGION_RADIUS_METERS = 100;
/**
 * Distancia máxima a la que se buscan locales de rubro: dentro de esta, el
 * caché siempre está descargado (ver `COVERAGE_MARGIN_METERS`).
 */
export const POI_SEARCH_RADIUS_METERS = 2000;
/**
 * Radio de la geocerca «centinela» centrada en el usuario: al salir de ella
 * (moverse más de esto) se vuelven a elegir los locales cercanos.
 */
export const SENTINEL_RADIUS_METERS = 500;
/**
 * Mientras el usuario esté a menos de esto del centro de la centinela
 * registrada, se conserva ese centro: así el ruido del GPS no obliga a
 * re-registrar todas las regiones en cada sincronización.
 */
export const SENTINEL_KEEP_CENTER_METERS = 200;

/**
 * Tiempo mínimo entre dos avisos del mismo trigger. Evita una ráfaga de
 * notificaciones si el GPS salta varias veces sobre el borde de la geocerca.
 */
export const NOTIFICATION_COOLDOWN_MS = 10 * 60_000;
/**
 * Tiempo mínimo entre dos avisos de la misma tarea por rubro: caminando por una
 * avenida se pasa por varias farmacias seguidas.
 */
export const CATEGORY_COOLDOWN_MS = 60 * 60_000;

const TRIGGER_PREFIX = 'trigger:';
const POI_PREFIX = 'poi:';
export const SENTINEL_IDENTIFIER = 'sentinel';

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

/** A qué corresponde una región registrada. */
export type RegionRef = { kind: 'trigger'; id: number } | { kind: 'poi'; id: number } | { kind: 'sentinel' };

/**
 * Identificador de la región de un trigger.
 *
 * @pre `triggerId` es el id de un trigger.
 * @post Devuelve `trigger:<id>`, que `parseRegionIdentifier` convierte de vuelta.
 */
export function regionIdentifier(triggerId: number): string {
  return `${TRIGGER_PREFIX}${triggerId}`;
}

/**
 * Identificador de la región de un local de rubro.
 *
 * @pre `poiId` es el id de una fila de `pois`.
 * @post Devuelve `poi:<id>`, que `parseRegionIdentifier` convierte de vuelta.
 */
export function poiRegionIdentifier(poiId: number): string {
  return `${POI_PREFIX}${poiId}`;
}

/**
 * Interpreta el identificador de una región.
 *
 * @pre Ninguna (el valor viene del sistema operativo).
 * @post Devuelve el trigger (`trigger:<id>`), el local (`poi:<id>`) o la
 *       centinela; `null` si no tiene ninguna de esas formas o el id no es un
 *       entero positivo.
 */
export function parseRegionIdentifier(identifier: unknown): RegionRef | null {
  if (identifier === SENTINEL_IDENTIFIER) return { kind: 'sentinel' };
  if (typeof identifier !== 'string') return null;
  const [kind, prefix] = identifier.startsWith(TRIGGER_PREFIX)
    ? (['trigger', TRIGGER_PREFIX] as const)
    : identifier.startsWith(POI_PREFIX)
      ? (['poi', POI_PREFIX] as const)
      : [null, ''];
  if (!kind) return null;
  const id = Number(identifier.slice(prefix.length));
  return Number.isInteger(id) && id > 0 ? { kind, id } : null;
}

/**
 * Ordena locales alternando rubros: el más cercano de cada rubro, después el
 * segundo de cada uno, etc. Así un rubro denso (farmacias) no tapa a uno escaso
 * (cines).
 *
 * @pre Ninguna.
 * @post Devuelve un local por `osmKey` (el primero según este orden), sin
 *       repetir; dentro de cada vuelta, los rubros van por su local más cercano.
 */
export function interleavePoisByCategory(pois: readonly Poi[], position: Coordinates): Poi[] {
  const byCategory = new Map<number, { poi: Poi; distance: number }[]>();
  for (const poi of pois) {
    const list = byCategory.get(poi.categoryId) ?? [];
    list.push({ poi, distance: distanceMeters(position, poi) });
    byCategory.set(poi.categoryId, list);
  }
  const queues = [...byCategory.values()].map((list) => list.sort((a, b) => a.distance - b.distance));

  const seen = new Set<string>();
  const result: Poi[] = [];
  for (let round = 0; queues.some((q) => q.length > round); round++) {
    const layer = queues
      .filter((q) => q.length > round)
      .map((q) => q[round])
      .sort((a, b) => a.distance - b.distance);
    for (const { poi } of layer) {
      if (seen.has(poi.osmKey)) continue;
      seen.add(poi.osmKey);
      result.push(poi);
    }
  }
  return result;
}

export interface RegionPlanInput {
  /** Triggers armados de lugares propios (ver `listArmed`). */
  places: readonly ArmedTrigger[];
  /** Locales candidatos de los rubros con tareas pendientes. */
  pois: readonly Poi[];
  /** `true` si hay tareas pendientes ancladas solo a un rubro. */
  categoryTasksActive: boolean;
  position: Coordinates | null;
  /** Total de regiones admitido (ver `MAX_REGIONS`). */
  limit: number;
}

/**
 * Elige y arma las regiones a registrar en el sistema operativo (US-3.2 y US-4.2).
 *
 * @pre `places` contiene solo triggers activos de tareas pendientes; `limit` ≥ 1.
 * @post Nunca devuelve más de `limit` regiones. Con tareas por rubro y posición
 *       conocida incluye la centinela (`SENTINEL_RADIUS_METERS` alrededor de
 *       `position`, solo avisa al salir) y hasta `POI_REGION_LIMIT` locales a
 *       `POI_SEARCH_RADIUS_METERS` o menos, alternando rubros (ver
 *       `interleavePoisByCategory`); sin posición no hay ni centinela ni locales.
 *       Los lugares propios (salvo `'dwell'`, que el geofencing de Expo no
 *       admite) entran todos si alcanza el lugar; si no, los más cercanos (sin
 *       posición, los más recientes), reservando a los locales al menos
 *       `MIN_POI_SLOTS` lugares o los que falten. Lugares y locales avisan al
 *       entrar y al salir (para mantener el estado al día). El resultado está
 *       ordenado por `identifier`.
 */
export function planRegions(input: RegionPlanInput): GeofenceRegion[] {
  const { position, limit } = input;
  const sentinel: GeofenceRegion | null =
    input.categoryTasksActive && position
      ? {
          identifier: SENTINEL_IDENTIFIER,
          latitude: position.latitude,
          longitude: position.longitude,
          radius: SENTINEL_RADIUS_METERS,
          notifyOnEnter: false,
          notifyOnExit: true,
        }
      : null;
  const available = Math.max(0, limit - (sentinel ? 1 : 0));

  const pois = position
    ? interleavePoisByCategory(
        input.pois.filter((poi) => distanceMeters(position, poi) <= POI_SEARCH_RADIUS_METERS),
        position,
      ).slice(0, POI_REGION_LIMIT)
    : [];
  const places = input.places
    .filter(({ trigger }) => trigger.transition !== 'dwell')
    .map((armed) => ({ armed, distance: position ? distanceMeters(position, armed.locationTarget) : 0 }))
    .sort((a, b) => a.distance - b.distance || b.armed.trigger.id - a.armed.trigger.id)
    .map(({ armed }) => armed);

  let poiSlots = pois.length;
  if (places.length + pois.length > available) {
    poiSlots = Math.min(pois.length, Math.max(Math.min(pois.length, MIN_POI_SLOTS), available - places.length));
  }
  poiSlots = Math.min(poiSlots, available);
  const placeSlots = available - poiSlots;

  const regions: GeofenceRegion[] = [
    ...places.slice(0, placeSlots).map(({ trigger, locationTarget }) => ({
      identifier: regionIdentifier(trigger.id),
      latitude: locationTarget.latitude,
      longitude: locationTarget.longitude,
      radius: locationTarget.radiusMeters,
      notifyOnEnter: true,
      notifyOnExit: true,
    })),
    ...pois.slice(0, poiSlots).map((poi) => ({
      identifier: poiRegionIdentifier(poi.id),
      latitude: poi.latitude,
      longitude: poi.longitude,
      radius: POI_REGION_RADIUS_METERS,
      notifyOnEnter: true,
      notifyOnExit: false,
    })),
  ];
  if (sentinel) regions.push(sentinel);
  return regions.sort((a, b) => a.identifier.localeCompare(b.identifier));
}

/**
 * Elige el punto alrededor del cual planificar.
 *
 * @pre Ninguna (`registered` es lo que guardó el sistema operativo).
 * @post Si entre `registered` hay una centinela cuyo centro está a menos de
 *       `SENTINEL_KEEP_CENTER_METERS` de `position`, devuelve ese centro; si no,
 *       `position`.
 */
export function planningCenter(registered: unknown, position: Coordinates): Coordinates {
  const sentinel = Array.isArray(registered)
    ? (registered as Partial<GeofenceRegion>[]).find((r) => r?.identifier === SENTINEL_IDENTIFIER)
    : undefined;
  if (typeof sentinel?.latitude !== 'number' || typeof sentinel.longitude !== 'number') return position;
  const center = { latitude: sentinel.latitude, longitude: sentinel.longitude };
  return distanceMeters(center, position) < SENTINEL_KEEP_CENTER_METERS ? center : position;
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

/**
 * Texto del aviso al pasar cerca de un local de un rubro con tareas pendientes.
 *
 * @pre `tasks` no está vacío.
 * @post Con una tarea, el título es la tarea; con varias, «N tareas cerca». El
 *       cuerpo nombra el local (o el rubro si el local no tiene nombre) y, con
 *       varias tareas, sus títulos.
 */
export function categoryNotificationContent(
  tasks: readonly Pick<Task, 'title'>[],
  placeName: string,
): { title: string; body: string } {
  if (tasks.length === 1) return { title: tasks[0].title, body: `${placeName} está cerca` };
  return {
    title: `${tasks.length} tareas cerca`,
    body: `${placeName}: ${tasks.map((t) => t.title).join(', ')}`,
  };
}
