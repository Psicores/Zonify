import type { GeofenceState, GeofenceTrigger, LocationTarget, Poi, PoiArea, Task } from '../db/schema';
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
/**
 * Distancia máxima a la que se buscan locales de rubro: dentro de esta, el
 * caché siempre está descargado (ver `COVERAGE_MARGIN_METERS`).
 */
export const POI_SEARCH_RADIUS_METERS = 2000;
/**
 * Cómo se está moviendo el usuario, estimado por velocidad (US-7.1). `unknown`
 * cuando no hay datos para estimarla.
 */
export type MotionMode = 'still' | 'walking' | 'vehicle' | 'unknown';

/** Por debajo de esto (m/s) el usuario está quieto. */
export const STILL_MAX_SPEED_MPS = 0.5;
/** Desde esto (m/s, ~25 km/h) el usuario va en un vehículo. */
export const VEHICLE_MIN_SPEED_MPS = 7;
/**
 * Desde esto (m/s, ~80 km/h) no se avisa por locales de rubro: en una autopista
 * no hay cómo frenar, y es el caso típico de falso positivo.
 */
export const HIGHWAY_SPEED_MPS = 22;

/**
 * Radios según el movimiento (US-7.1). A pie, geocercas de local ajustadas
 * (100 m) y centinela de 500 m. En vehículo, locales de 250 m para dar tiempo a
 * reaccionar con la latencia del sistema, y centinela de 1,5 km para no despertar
 * la app cada pocas cuadras. Quieto no cambia nada: la app no consulta el GPS
 * y las geocercas del sistema son pasivas (celdas y Wi-Fi).
 */
export const MOTION_PROFILES: Record<MotionMode, { poiRadius: number; sentinelRadius: number }> = {
  still: { poiRadius: 100, sentinelRadius: 500 },
  walking: { poiRadius: 100, sentinelRadius: 500 },
  vehicle: { poiRadius: 250, sentinelRadius: 1500 },
  unknown: { poiRadius: 100, sentinelRadius: 500 },
};

/** Las dos posiciones usadas para estimar la velocidad no pueden estar más separadas que esto. */
export const SPEED_ESTIMATE_MAX_GAP_MS = 15 * 60_000;
/**
 * Mientras el usuario esté a menos de esto del centro de la centinela
 * registrada, se conserva ese centro: así el ruido del GPS no obliga a
 * re-registrar todas las regiones en cada sincronización.
 */
export const SENTINEL_KEEP_CENTER_METERS = 200;

/**
 * Tiempo mínimo entre dos avisos de la misma tarea por rubro: caminando por una
 * avenida se pasa por varias farmacias seguidas. Aparte, cada local o lugar
 * tiene su propio enfriamiento configurable (US-6.2, ver `appSettings`).
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
  /** Movimiento estimado; elige los radios (ver `MOTION_PROFILES`). */
  motion: MotionMode;
}

/**
 * Elige y arma las regiones a registrar en el sistema operativo (US-3.2 y US-4.2).
 *
 * @pre `places` contiene solo triggers activos de tareas pendientes; `limit` ≥ 1.
 * @post Nunca devuelve más de `limit` regiones. Con tareas por rubro y posición
 *       conocida incluye la centinela (radio según `motion`, alrededor de
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
  const profile = MOTION_PROFILES[input.motion];
  const sentinel: GeofenceRegion | null =
    input.categoryTasksActive && position
      ? {
          identifier: SENTINEL_IDENTIFIER,
          latitude: position.latitude,
          longitude: position.longitude,
          radius: profile.sentinelRadius,
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
      radius: profile.poiRadius,
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
 * Huella de lo que puede cambiar las geocercas registradas (US-2.2).
 *
 * @pre Ninguna (cada lista puede no haber cargado todavía).
 * @post Devuelve el mismo texto mientras no cambien: qué tareas están
 *       pendientes y con qué rubro, qué triggers están armados con qué
 *       transición, centro y radio, y cuándo se descargó cada zona del caché de
 *       POIs. Títulos, horarios, posposiciones y el último estado de cada
 *       geocerca (`lastState`) no la cambian. Van las tareas pendientes y no
 *       solo sus rubros: la consulta en vivo de triggers solo escucha su propia
 *       tabla, y completar una tarea con lugar se nota en la de tareas.
 */
export function geofenceWatchKey(
  pending: readonly Pick<Task, 'id' | 'categoryId'>[] | undefined,
  armed:
    | readonly {
        trigger: Pick<GeofenceTrigger, 'id' | 'transition'>;
        locationTarget: Pick<LocationTarget, 'latitude' | 'longitude' | 'radiusMeters'>;
      }[]
    | undefined,
  areas: readonly Pick<PoiArea, 'fetchedAt'>[] | undefined,
): string {
  return [
    pending?.map((t) => `${t.id}:${t.categoryId ?? ''}`).join(','),
    armed
      ?.map(
        ({ trigger, locationTarget: l }) =>
          `${trigger.id}:${trigger.transition}:${l.latitude}:${l.longitude}:${l.radiusMeters}`,
      )
      .join(','),
    areas?.map((a) => a.fetchedAt.getTime()).join(','),
  ].join('|');
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
 * Indica si algo está pospuesto en un momento dado.
 *
 * @pre Ninguna.
 * @post Devuelve `true` si `until` es posterior a `now`.
 */
export function isSnoozed(until: Date | null | undefined, now: Date): boolean {
  return until != null && until.getTime() > now.getTime();
}

/**
 * Decide qué hacer con una transición informada por el sistema operativo.
 *
 * @pre `now` y `lastNotifiedAt` están en la misma escala de tiempo; `cooldownMs` ≥ 0.
 * @post `nextState` es `'inside'` al entrar y `'outside'` al salir. `notify` es
 *       `true` solo si el trigger está activo, su tarea pendiente y no
 *       pospuesta (`snoozed`), la transición coincide con la del trigger, el
 *       estado anterior no era ya el nuevo (al registrar las regiones Android
 *       repite el estado actual, y eso no es un cruce) y no hubo otro aviso del
 *       trigger en los últimos `cooldownMs` (US-6.2).
 */
export function decideGeofenceEvent(input: {
  event: GeofenceEvent;
  trigger: GeofenceTrigger;
  taskStatus: Task['status'];
  snoozed: boolean;
  lastNotifiedAt: Date | null;
  cooldownMs: number;
  now: Date;
}): GeofenceDecision {
  const { event, trigger, taskStatus, snoozed, lastNotifiedAt, cooldownMs, now } = input;
  const nextState: GeofenceState = event === 'enter' ? 'inside' : 'outside';
  const coolingDown = lastNotifiedAt !== null && now.getTime() - lastNotifiedAt.getTime() < cooldownMs;
  const notify =
    trigger.isActive &&
    taskStatus === 'pending' &&
    !snoozed &&
    trigger.transition === event &&
    trigger.lastState !== nextState &&
    !coolingDown;
  return { nextState, notify };
}

/**
 * Distancia corta para el título de un aviso.
 *
 * @pre `meters` ≥ 0.
 * @post «a 90m» (redondeado a decenas) por debajo de 1 km; «a 1,2km» desde 1 km.
 */
export function formatAlertDistance(meters: number): string {
  const rounded = Math.round(meters / 10) * 10;
  if (rounded < 1000) return `a ${rounded}m`;
  return `a ${(meters / 1000).toFixed(1).replace('.', ',')}km`;
}

/**
 * Une textos como en una enumeración en español.
 *
 * @pre Ninguna.
 * @post «A», «A y B», «A, B y C»; vacío si no hay textos.
 */
export function joinSpanish(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} y ${items[items.length - 1]}`;
}

/**
 * Texto enriquecido de un aviso (US-6.1): el lugar arriba y las tareas abajo.
 *
 * @pre `taskTitles` no está vacío.
 * @post Al entrar, el título es «📍 <lugar>» con «(a 90m)» si se conoce la
 *       distancia; al salir, «📍 Saliste de <lugar>». El cuerpo son los títulos
 *       de las tareas unidos con `joinSpanish`.
 */
export function alertContent(input: {
  event: GeofenceEvent;
  placeName: string;
  distanceMeters: number | null;
  taskTitles: readonly string[];
}): { title: string; body: string } {
  const { event, placeName, distanceMeters, taskTitles } = input;
  const title =
    event === 'exit'
      ? `📍 Saliste de ${placeName}`
      : `📍 ${placeName}${distanceMeters === null ? '' : ` (${formatAlertDistance(distanceMeters)})`}`;
  return { title, body: joinSpanish(taskTitles) };
}

/** Posición con velocidad y momento, como la entrega expo-location. */
export interface MotionFix extends Coordinates {
  /** Velocidad informada por el sistema en m/s; `null` o negativa si no la sabe. */
  speed: number | null;
  /** Momento de la posición, en ms desde epoch. */
  at: number;
}

/**
 * Estima la velocidad del usuario.
 *
 * @pre Ninguna.
 * @post Si el sistema informó una velocidad válida (≥ 0) la devuelve. Si no, y
 *       hay una posición anterior de hasta `SPEED_ESTIMATE_MAX_GAP_MS` antes,
 *       devuelve distancia / tiempo entre ambas. Si no, `null`.
 */
export function estimateSpeed(
  fix: MotionFix,
  previous: { latitude: number; longitude: number; at: number } | null,
): number | null {
  if (fix.speed !== null && fix.speed >= 0) return fix.speed;
  if (!previous) return null;
  const elapsed = fix.at - previous.at;
  if (elapsed <= 0 || elapsed > SPEED_ESTIMATE_MAX_GAP_MS) return null;
  return distanceMeters(previous, fix) / (elapsed / 1000);
}

/**
 * Clasifica el movimiento según la velocidad (US-7.1).
 *
 * @pre Ninguna.
 * @post `'unknown'` sin velocidad; `'still'` por debajo de `STILL_MAX_SPEED_MPS`;
 *       `'vehicle'` desde `VEHICLE_MIN_SPEED_MPS`; si no, `'walking'`.
 */
export function classifyMotion(speed: number | null): MotionMode {
  if (speed === null) return 'unknown';
  if (speed < STILL_MAX_SPEED_MPS) return 'still';
  return speed >= VEHICLE_MIN_SPEED_MPS ? 'vehicle' : 'walking';
}
