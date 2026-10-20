/**
 * Estado de un permiso, reducido a lo que necesita el onboarding.
 * - `denied`: rechazado, pero la app puede volver a pedirlo.
 * - `blocked`: rechazado y solo se puede cambiar desde los Ajustes del sistema.
 */
export type PermissionAccess = 'granted' | 'undetermined' | 'denied' | 'blocked';

/** Fabricante conocido por cerrar apps en background, con su guía en dontkillmyapp.com. */
export interface AggressiveVendor {
  name: string;
  slug: string;
}

export interface BatteryStatus {
  /** Android: la app está sujeta a la optimización de batería (Doze / App Standby). */
  optimized: boolean;
  /** Android: el ahorro de energía del sistema está activado. */
  powerSaver: boolean;
  vendor: AggressiveVendor | null;
}

export interface PermissionSnapshot {
  foreground: PermissionAccess;
  /** Ubicación precisa: sin ella el sistema no dispara geocercas. */
  precise: boolean;
  background: PermissionAccess;
  notifications: PermissionAccess;
  battery: BatteryStatus;
}

export type PermissionGroup = 'location' | 'notifications' | 'battery';

/**
 * Para qué se piden permisos en este momento (US-3.1):
 * - `location`: el mapa, que solo necesita la ubicación mientras se usa la app.
 * - `alerts`: avisar con la app cerrada (ubicación todo el tiempo y precisa,
 *   notificaciones y, en Android, batería sin restricciones).
 */
export type PermissionDemand = 'location' | 'alerts';

/** Tiempo durante el que «Ahora no» deja de pedir un grupo de permisos (US-3.1). */
export const PERMISSION_SKIP_GRACE_MS = 7 * 24 * 60 * 60_000;

/** Hasta cuándo está pospuesto cada grupo, en ms desde epoch. Se guarda en `app_settings`. */
export type PermissionSkips = Partial<Record<PermissionGroup, number>>;

/** Lo que el usuario ya hizo y no se puede deducir del sistema. */
export interface FlowProgress {
  backgroundRequested: boolean;
  notificationsRequested: boolean;
  /** Grupos pospuestos con «Ahora no» y todavía dentro del plazo de gracia. */
  skipped: readonly PermissionGroup[];
}

export type OnboardingStep =
  | 'intro'
  | 'foreground-blocked'
  | 'precise-required'
  | 'background'
  | 'background-denied'
  | 'notifications'
  | 'notifications-denied'
  | 'battery'
  | 'done';

export const INITIAL_PROGRESS: FlowProgress = {
  backgroundRequested: false,
  notificationsRequested: false,
  skipped: [],
};

const VENDORS: Record<string, AggressiveVendor> = {
  xiaomi: { name: 'Xiaomi', slug: 'xiaomi' },
  redmi: { name: 'Xiaomi', slug: 'xiaomi' },
  poco: { name: 'Xiaomi', slug: 'xiaomi' },
  samsung: { name: 'Samsung', slug: 'samsung' },
  oneplus: { name: 'OnePlus', slug: 'oneplus' },
  huawei: { name: 'Huawei', slug: 'huawei' },
  honor: { name: 'Honor', slug: 'huawei' },
  oppo: { name: 'Oppo', slug: 'oppo' },
  realme: { name: 'realme', slug: 'realme' },
  vivo: { name: 'Vivo', slug: 'vivo' },
  meizu: { name: 'Meizu', slug: 'meizu' },
  asus: { name: 'Asus', slug: 'asus' },
  wiko: { name: 'Wiko', slug: 'wiko' },
  tecno: { name: 'Tecno', slug: 'tecno' },
  motorola: { name: 'Motorola', slug: 'motorola' },
  lenovo: { name: 'Lenovo', slug: 'lenovo' },
  sony: { name: 'Sony', slug: 'sony' },
  nokia: { name: 'Nokia', slug: 'hmd-global' },
  'hmd global': { name: 'Nokia', slug: 'hmd-global' },
};

/**
 * Busca si un fabricante es conocido por restringir procesos en background
 * más allá de lo que hace Android.
 *
 * @pre Ninguna.
 * @post Devuelve el fabricante con su guía si `manufacturer` coincide (sin
 *       distinguir mayúsculas ni espacios en los extremos) con uno conocido;
 *       si no, o si es `null`, devuelve `null`.
 */
export function findAggressiveVendor(manufacturer: string | null): AggressiveVendor | null {
  if (!manufacturer) return null;
  return VENDORS[manufacturer.trim().toLowerCase()] ?? null;
}

/**
 * Indica si el sistema está limitando la ejecución en background.
 *
 * @pre Ninguna.
 * @post Devuelve `true` si la app está optimizada o el ahorro de energía está
 *       activo. El fabricante no cuenta: sus restricciones no son detectables.
 */
export function isBatteryRestricted(battery: BatteryStatus): boolean {
  return battery.optimized || battery.powerSaver;
}

/**
 * Grupos de permisos que hacen falta para un pedido.
 *
 * @pre Ninguna.
 * @post `location` → solo ubicación; `alerts` → ubicación, notificaciones y batería.
 */
export function groupsFor(demand: PermissionDemand): PermissionGroup[] {
  return demand === 'location' ? ['location'] : ['location', 'notifications', 'battery'];
}

/**
 * Grupos que siguen pospuestos.
 *
 * @pre Ninguna.
 * @post Devuelve los grupos de `skips` cuyo plazo termina después de `now`.
 */
export function activeSkips(skips: PermissionSkips, now: number): PermissionGroup[] {
  return (Object.keys(skips) as PermissionGroup[]).filter((group) => (skips[group] ?? 0) > now);
}

/**
 * Pospone un grupo («Ahora no»).
 *
 * @pre Ninguna.
 * @post Devuelve `skips` con `group` pospuesto hasta `now + PERMISSION_SKIP_GRACE_MS`;
 *       los demás grupos no cambian.
 */
export function skipGroup(skips: PermissionSkips, group: PermissionGroup, now: number): PermissionSkips {
  return { ...skips, [group]: now + PERMISSION_SKIP_GRACE_MS };
}

/**
 * Quita la posposición de algunos grupos (el usuario pidió activar algo).
 *
 * @pre Ninguna.
 * @post Devuelve `skips` sin los grupos de `groups`.
 */
export function clearSkips(skips: PermissionSkips, groups: readonly PermissionGroup[]): PermissionSkips {
  return Object.fromEntries(
    Object.entries(skips).filter(([group]) => !groups.includes(group as PermissionGroup)),
  ) as PermissionSkips;
}

/**
 * Primer permiso que le falta a un pedido, sin mirar las posposiciones. El orden
 * es ubicación en primer plano, precisa, en background, notificaciones y batería.
 *
 * @pre `snapshot` refleja el estado actual del sistema.
 * @post Para `location` solo mira la ubicación en primer plano. Un permiso ya
 *       pedido y no concedido lleva a su estado explicativo en lugar de volver
 *       a pedirlo. `'done'` si no falta nada.
 */
function missingStep(snapshot: PermissionSnapshot, progress: FlowProgress, demand: PermissionDemand): OnboardingStep {
  if (snapshot.foreground === 'blocked') return 'foreground-blocked';
  if (snapshot.foreground !== 'granted') return 'intro';
  if (demand === 'location') return 'done';
  if (!snapshot.precise) return 'precise-required';
  if (snapshot.background !== 'granted') {
    return progress.backgroundRequested || snapshot.background === 'blocked' ? 'background-denied' : 'background';
  }
  if (snapshot.notifications !== 'granted') {
    return progress.notificationsRequested || snapshot.notifications === 'blocked'
      ? 'notifications-denied'
      : 'notifications';
  }
  if (isBatteryRestricted(snapshot.battery)) return 'battery';
  return 'done';
}

/**
 * Decide qué paso de permisos mostrar para un pedido (US-3.1).
 *
 * @pre `snapshot` refleja el estado actual del sistema.
 * @post Sin pedido devuelve `'done'`. Si no, el primer permiso que le falta
 *       (`missingStep`); si su grupo está pospuesto devuelve `'done'`: sin ese
 *       permiso los siguientes no sirven (sin ubicación todo el tiempo no hay
 *       avisos que mostrar), así que tampoco se piden.
 */
export function resolveStep(
  snapshot: PermissionSnapshot,
  progress: FlowProgress,
  demand: PermissionDemand | null,
): OnboardingStep {
  if (demand === null) return 'done';
  const step = missingStep(snapshot, progress, demand);
  return step !== 'done' && progress.skipped.includes(groupOf(step)) ? 'done' : step;
}

/**
 * Grupo al que pertenece un paso, para mostrar el progreso.
 *
 * @pre `step` no es `'done'`.
 * @post Devuelve el grupo de permisos que resuelve `step`.
 */
export function groupOf(step: Exclude<OnboardingStep, 'done'>): PermissionGroup {
  if (step === 'battery') return 'battery';
  if (step === 'notifications' || step === 'notifications-denied') return 'notifications';
  return 'location';
}
