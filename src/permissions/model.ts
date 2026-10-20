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

/** Lo que el usuario ya hizo en esta sesión y no se puede deducir del sistema. */
export interface FlowProgress {
  backgroundRequested: boolean;
  notificationsRequested: boolean;
  /** Grupos que el usuario decidió posponer. */
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
 * Decide qué paso del onboarding mostrar. El orden es ubicación en primer plano,
 * ubicación precisa, ubicación en background, notificaciones y batería.
 *
 * @pre `snapshot` refleja el estado actual del sistema.
 * @post Devuelve el primer paso pendiente de un grupo no pospuesto, o `'done'`
 *       si no queda ninguno. Un permiso ya pedido en la sesión y no concedido
 *       lleva a su estado explicativo en lugar de volver a pedirlo.
 */
export function resolveStep(snapshot: PermissionSnapshot, progress: FlowProgress): OnboardingStep {
  if (!progress.skipped.includes('location')) {
    if (snapshot.foreground === 'blocked') return 'foreground-blocked';
    if (snapshot.foreground !== 'granted') return 'intro';
    if (!snapshot.precise) return 'precise-required';
    if (snapshot.background !== 'granted') {
      return progress.backgroundRequested || snapshot.background === 'blocked'
        ? 'background-denied'
        : 'background';
    }
  }

  if (!progress.skipped.includes('notifications') && snapshot.notifications !== 'granted') {
    return progress.notificationsRequested || snapshot.notifications === 'blocked'
      ? 'notifications-denied'
      : 'notifications';
  }

  if (!progress.skipped.includes('battery') && isBatteryRestricted(snapshot.battery)) {
    return 'battery';
  }

  return 'done';
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
