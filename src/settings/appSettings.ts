import type { Repositories } from '../db/repositories';
import type { Coordinates } from '../places/geo';

/** Opciones de enfriamiento por local que ofrece la pantalla de ajustes, en horas. */
export const POI_COOLDOWN_OPTIONS = [6, 12, 24] as const;
/** Enfriamiento por defecto de un local o lugar después de avisar (US-6.2). */
export const DEFAULT_POI_COOLDOWN_HOURS = 12;
/** Tiempo que «Posponer» silencia la tarea y su rubro (US-6.2). */
export const SNOOZE_MS = 2 * 60 * 60_000;

const POI_COOLDOWN_KEY = 'notifications.poiCooldownHours';
const LAST_FIX_KEY = 'motion.lastPlanningFix';

/** Posición con la que se planificaron las geocercas por última vez. */
export interface PlanningFix extends Coordinates {
  /** Momento de la posición, en ms desde epoch. */
  at: number;
}

/**
 * Lee el enfriamiento por local configurado.
 *
 * @pre Las migraciones están aplicadas.
 * @post Devuelve las horas guardadas si son un número positivo; si no (o si no
 *       hay nada guardado), `DEFAULT_POI_COOLDOWN_HOURS`.
 */
export async function getPoiCooldownHours(repos: Repositories): Promise<number> {
  const hours = Number(await repos.settings.get(POI_COOLDOWN_KEY));
  return Number.isFinite(hours) && hours > 0 ? hours : DEFAULT_POI_COOLDOWN_HOURS;
}

/**
 * Guarda el enfriamiento por local.
 *
 * @pre `hours` > 0.
 * @post `getPoiCooldownHours` devuelve `hours`.
 * @throws `RangeError` si `hours` no es un número positivo, sin guardar nada.
 */
export async function setPoiCooldownHours(repos: Repositories, hours: number): Promise<void> {
  if (!Number.isFinite(hours) || hours <= 0) throw new RangeError('El enfriamiento tiene que ser positivo');
  await repos.settings.set(POI_COOLDOWN_KEY, String(hours));
}

/**
 * Lee la última posición usada para planificar.
 *
 * @pre Las migraciones están aplicadas.
 * @post Devuelve la posición guardada, o `null` si no hay o está mal formada.
 */
export async function getLastPlanningFix(repos: Repositories): Promise<PlanningFix | null> {
  try {
    const raw = await repos.settings.get(LAST_FIX_KEY);
    const fix = raw ? (JSON.parse(raw) as Partial<PlanningFix>) : null;
    if (typeof fix?.latitude !== 'number' || typeof fix.longitude !== 'number' || typeof fix.at !== 'number') {
      return null;
    }
    return { latitude: fix.latitude, longitude: fix.longitude, at: fix.at };
  } catch {
    return null;
  }
}

/**
 * Guarda la última posición usada para planificar.
 *
 * @pre Ninguna.
 * @post `getLastPlanningFix` devuelve `fix`.
 */
export async function setLastPlanningFix(repos: Repositories, fix: PlanningFix): Promise<void> {
  await repos.settings.set(LAST_FIX_KEY, JSON.stringify(fix));
}
