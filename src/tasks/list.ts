import type { Category, GeofenceTrigger, LocationTarget, Task } from '../db/schema';
import { distanceMeters, type Coordinates } from '../places/geo';

export type TaskTab = 'active' | 'nearby' | 'completed';

/** Pestañas de la pantalla principal, en el orden en que se muestran. */
export const TASK_TABS: readonly { key: TaskTab; label: string }[] = [
  { key: 'active', label: 'Activas' },
  { key: 'nearby', label: 'Cercanas hoy' },
  { key: 'completed', label: 'Completadas' },
];

/** Cómo está anclada una tarea: a un lugar concreto, a un rubro o a nada. */
export type AnchorKind = 'place' | 'category' | 'general';

const ANCHOR_ORDER: readonly AnchorKind[] = ['place', 'category', 'general'];

export const ANCHOR_SECTION_TITLES: Record<AnchorKind, string> = {
  place: 'Por lugar',
  category: 'Por rubro',
  general: 'Generales',
};

export type TaskAction = 'complete' | 'archive' | 'reopen';

export const TASK_ACTION_LABELS: Record<TaskAction, string> = {
  complete: 'Completar',
  archive: 'Archivar',
  reopen: 'Reactivar',
};

export const TASK_ACTION_DONE_MESSAGES: Record<TaskAction, string> = {
  complete: 'Tarea completada',
  archive: 'Tarea archivada',
  reopen: 'Tarea reactivada',
};

/** Acción de cada sentido de deslizamiento según la pestaña. */
export const SWIPE_ACTIONS: Record<TaskTab, { right: TaskAction; left: TaskAction }> = {
  active: { right: 'complete', left: 'archive' },
  nearby: { right: 'complete', left: 'archive' },
  completed: { right: 'reopen', left: 'archive' },
};

/**
 * Distancia máxima a un lugar para que su tarea cuente como cercana. Si la geocerca
 * del lugar es más grande, se usa su radio.
 */
export const NEARBY_DISTANCE_METERS = 1000;

export interface PlaceAnchor {
  trigger: GeofenceTrigger;
  locationTarget: LocationTarget;
}

export interface TaskListItem {
  task: Task;
  anchor: AnchorKind;
  /** Lugares con trigger activo, sin repetir; vacío si la tarea no tiene. */
  places: LocationTarget[];
  /** `true` si el sistema reportó que el usuario está dentro de alguna de sus geocercas. */
  insideAnyPlace: boolean;
  category: Category | null;
}

export interface TaskSection {
  key: string;
  /** `null` cuando la pestaña muestra una lista sin agrupar. */
  title: string | null;
  data: TaskListItem[];
}

/**
 * Une cada tarea con sus lugares y su rubro y decide su anclaje.
 *
 * @pre `placeAnchors` contiene solo triggers activos; `categories` puede no incluir
 *      todas las categorías referenciadas (se tratan como sin rubro).
 * @post Devuelve un elemento por tarea, en el mismo orden que `tasks`. El anclaje es
 *       `'place'` si tiene algún lugar (aunque también tenga rubro), si no
 *       `'category'` si su rubro existe, y si no `'general'`.
 */
export function buildTaskListItems(
  tasks: readonly Task[],
  placeAnchors: readonly PlaceAnchor[],
  categories: readonly Category[],
): TaskListItem[] {
  const anchorsByTask = new Map<number, PlaceAnchor[]>();
  for (const anchor of placeAnchors) {
    const list = anchorsByTask.get(anchor.trigger.taskId);
    if (list) list.push(anchor);
    else anchorsByTask.set(anchor.trigger.taskId, [anchor]);
  }
  const categoriesById = new Map(categories.map((c) => [c.id, c]));

  return tasks.map((task) => {
    const anchors = anchorsByTask.get(task.id) ?? [];
    // Una tarea puede tener varios triggers (entrar y salir) sobre el mismo lugar.
    const places = [...new Map(anchors.map((a) => [a.locationTarget.id, a.locationTarget])).values()];
    const category = task.categoryId === null ? null : (categoriesById.get(task.categoryId) ?? null);
    const anchor: AnchorKind = places.length > 0 ? 'place' : category ? 'category' : 'general';
    return {
      task,
      anchor,
      places,
      insideAnyPlace: anchors.some((a) => a.trigger.lastState === 'inside'),
      category,
    };
  });
}

/**
 * Distancia al lugar más próximo de una tarea.
 *
 * @pre Ninguna.
 * @post Devuelve los metros hasta el lugar más cercano de `item`, o `null` si no
 *       hay posición o la tarea no tiene lugares.
 */
export function nearestPlaceDistance(item: TaskListItem, position: Coordinates | null): number | null {
  if (!position || item.places.length === 0) return null;
  return Math.min(...item.places.map((place) => distanceMeters(position, place)));
}

/**
 * Indica si una tarea va en «Cercanas hoy».
 *
 * @pre Ninguna.
 * @post Devuelve `true` si la tarea está pendiente, está anclada a algún lugar y,
 *       o el usuario está dentro de una de sus geocercas, o la posición actual
 *       está a `NEARBY_DISTANCE_METERS` (o al radio de la geocerca, si es mayor)
 *       de alguno de sus lugares. Las tareas por rubro no cuentan: no tienen
 *       coordenadas.
 */
export function isNearby(item: TaskListItem, position: Coordinates | null): boolean {
  if (item.task.status !== 'pending' || item.anchor !== 'place') return false;
  if (item.insideAnyPlace) return true;
  if (!position) return false;
  return item.places.some(
    (place) => distanceMeters(position, place) <= Math.max(NEARBY_DISTANCE_METERS, place.radiusMeters),
  );
}

/**
 * Elige y ordena las tareas que muestra una pestaña.
 *
 * @pre Ninguna.
 * @post `'active'`: las pendientes, en el orden recibido. `'nearby'`: las que
 *       cumplen `isNearby`, de la más cercana a la más lejana (las que solo se
 *       saben dentro de la geocerca, sin distancia, al principio). `'completed'`:
 *       las completadas, de la completada más recientemente a la más antigua.
 *       Nunca incluye archivadas. No modifica `items`.
 */
export function selectTab(
  items: readonly TaskListItem[],
  tab: TaskTab,
  position: Coordinates | null,
): TaskListItem[] {
  switch (tab) {
    case 'active':
      return items.filter((item) => item.task.status === 'pending');
    case 'nearby':
      return items
        .filter((item) => isNearby(item, position))
        .map((item) => ({ item, distance: nearestPlaceDistance(item, position) ?? -1 }))
        .sort((a, b) => a.distance - b.distance)
        .map(({ item }) => item);
    case 'completed':
      return items
        .filter((item) => item.task.status === 'completed')
        .sort((a, b) => (b.task.completedAt?.getTime() ?? 0) - (a.task.completedAt?.getTime() ?? 0));
  }
}

/**
 * Arma las secciones de una pestaña.
 *
 * @pre `items` es el resultado de `selectTab` para `tab`.
 * @post En `'active'` agrupa por anclaje en el orden lugar → rubro → generales,
 *       sin secciones vacías y conservando el orden dentro de cada una. En las
 *       demás pestañas devuelve una única sección sin título (ninguna si `items`
 *       está vacío).
 */
export function buildSections(items: readonly TaskListItem[], tab: TaskTab): TaskSection[] {
  if (items.length === 0) return [];
  if (tab !== 'active') return [{ key: tab, title: null, data: [...items] }];

  return ANCHOR_ORDER.map((kind) => ({
    key: kind,
    title: ANCHOR_SECTION_TITLES[kind],
    data: items.filter((item) => item.anchor === kind),
  })).filter((section) => section.data.length > 0);
}

/**
 * Texto corto con una distancia.
 *
 * @pre `meters` ≥ 0.
 * @post Devuelve «a N m» (redondeado a decenas) si el redondeo queda por debajo
 *       de 1 km y «a N,N km» en otro caso.
 */
export function formatDistance(meters: number): string {
  const rounded = Math.round(meters / 10) * 10;
  if (rounded < 1000) return `a ${rounded} m`;
  return `a ${(meters / 1000).toFixed(1).replace('.', ',')} km`;
}
