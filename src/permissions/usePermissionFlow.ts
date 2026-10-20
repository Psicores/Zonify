import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';

import type { Repositories } from '../db/repositories';
import { getPermissionSkips, setPermissionSkips } from '../settings/appSettings';
import {
  activeSkips,
  clearSkips,
  groupOf,
  groupsFor,
  INITIAL_PROGRESS,
  resolveStep,
  skipGroup,
  type FlowProgress,
  type OnboardingStep,
  type PermissionDemand,
  type PermissionGroup,
  type PermissionSkips,
  type PermissionSnapshot,
} from './model';
import {
  readPermissionSnapshot,
  requestBackgroundLocation,
  requestForegroundLocation,
  requestNotifications,
} from './service';

export interface RequirePermissionOptions {
  /** El usuario tocó un botón para activar el permiso: se ignora «Ahora no». */
  force?: boolean;
}

export interface PermissionFlow {
  /** `null` mientras se lee el estado inicial. */
  snapshot: PermissionSnapshot | null;
  /** Pedido abierto, o `null` si no se está pidiendo nada. */
  demand: PermissionDemand | null;
  /** Paso del pedido abierto; `'done'` sin pedido. `null` mientras se lee el estado. */
  step: OnboardingStep | null;
  /** `true` mientras hay un pedido abierto al que le falta algún paso. */
  prompting: boolean;
  busy: boolean;
  error: string | null;
  requestForeground: () => void;
  requestBackground: () => void;
  requestNotifications: () => void;
  /** Abre una pantalla de Ajustes; al volver, el refresh por AppState relee el estado. */
  openSettings: (open: () => Promise<void>) => void;
  /** «Ahora no»: pospone el grupo `PERMISSION_SKIP_GRACE_MS` y lo guarda. */
  skip: (group: PermissionGroup) => void;
  /**
   * Abre un pedido si le falta algún permiso que no esté pospuesto (o, con
   * `force`, aunque esté pospuesto). Devuelve `true` si lo abrió.
   */
  askFor: (demand: PermissionDemand, options?: RequirePermissionOptions) => boolean;
  /** Cierra el pedido abierto; si quedaba un paso sin resolver, cuenta como «Ahora no». */
  release: () => void;
}

/**
 * Estado de los permisos y del pedido abierto (US-3.1). Vuelve a leer los
 * permisos cada vez que la app pasa a primer plano, así detecta lo que el
 * usuario cambió en Ajustes.
 *
 * @pre Se usa dentro de un componente de React montado en la app nativa, con
 *      las migraciones aplicadas.
 * @post `step` es el paso del pedido abierto según el último estado leído y las
 *       posposiciones guardadas en `app_settings`, que sobreviven a cerrar la
 *       app. Mientras una solicitud está en curso `busy` es `true`; si falla,
 *       `error` tiene el mensaje.
 */
export function usePermissionFlow(repos: Repositories): PermissionFlow {
  const [snapshot, setSnapshot] = useState<PermissionSnapshot | null>(null);
  const [progress, setProgress] = useState<FlowProgress>(INITIAL_PROGRESS);
  const [demand, setDemand] = useState<PermissionDemand | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Posposiciones guardadas, con sus plazos; `progress.skipped` son las vigentes.
  const skips = useRef<PermissionSkips>({});
  // Descarta lecturas viejas que terminan después de una más nueva.
  const readId = useRef(0);
  // Marcas de progreso que esperan a publicarse junto con una lectura. En iOS el
  // diálogo nativo dispara un refresh por AppState que puede reemplazar al de la
  // solicitud, y la marca no se tiene que perder.
  const pendingMark = useRef<Partial<FlowProgress>>({});

  /**
   * Guarda las posposiciones.
   *
   * @pre Ninguna.
   * @post `skips` queda con `next` y se pide guardarlo; un fallo se informa en la consola.
   */
  const persistSkips = useCallback(
    (next: PermissionSkips) => {
      skips.current = next;
      setPermissionSkips(repos, next).catch((e: unknown) =>
        console.warn('[permisos] no se pudo guardar «Ahora no»:', e),
      );
    },
    [repos],
  );

  /**
   * Lee el estado del sistema y lo publica si sigue siendo la lectura más reciente.
   *
   * @pre Ninguna.
   * @post `mark` queda pendiente hasta que alguna lectura se publique. Si no hubo
   *       otra lectura posterior, `snapshot` queda actualizado y `progress` con
   *       las marcas pendientes y las posposiciones vigentes, en el mismo render;
   *       si falla, `error` tiene el mensaje.
   */
  const refresh = useCallback(async (mark?: Partial<FlowProgress>) => {
    if (mark) Object.assign(pendingMark.current, mark);
    const id = ++readId.current;
    try {
      const next = await readPermissionSnapshot();
      if (id !== readId.current) return;
      const applied = pendingMark.current;
      pendingMark.current = {};
      const skipped = activeSkips(skips.current, Date.now());
      setProgress((p) => ({ ...p, ...applied, skipped }));
      setSnapshot(next);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    getPermissionSkips(repos)
      .then((saved) => {
        skips.current = saved;
      })
      .catch(() => undefined)
      .finally(() => refresh());
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') refresh();
    });
    return () => subscription.remove();
  }, [repos, refresh]);

  /**
   * Ejecuta una solicitud de permiso y relee el estado al terminar.
   *
   * @pre No hay otra solicitud en curso.
   * @post `busy` vuelve a `false`; el estado y `mark` se aplican juntos, para
   *       no mostrar un paso intermedio con datos viejos.
   */
  const run = useCallback(
    (request: () => Promise<void>, mark?: Partial<FlowProgress>) => {
      setBusy(true);
      request()
        .then(() => refresh(mark))
        .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
        .finally(() => setBusy(false));
    },
    [refresh],
  );

  /**
   * Abre una pantalla del sistema sin bloquear la interfaz.
   *
   * @pre Ninguna.
   * @post Se pidió abrir la pantalla; si falla, `error` tiene el mensaje.
   */
  const openSettings = useCallback((open: () => Promise<void>) => {
    open().catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  /**
   * «Ahora no» para un grupo.
   *
   * @pre Ninguna.
   * @post `group` queda pospuesto `PERMISSION_SKIP_GRACE_MS`, guardado en
   *       `app_settings` y en `progress.skipped`; el pedido abierto se cierra
   *       porque `resolveStep` devuelve `'done'`.
   */
  const skip = useCallback(
    (group: PermissionGroup) => {
      persistSkips(skipGroup(skips.current, group, Date.now()));
      setProgress((p) => (p.skipped.includes(group) ? p : { ...p, skipped: [...p.skipped, group] }));
    },
    [persistSkips],
  );

  /**
   * Abre un pedido de permisos.
   *
   * @pre Ninguna.
   * @post Sin estado leído todavía devuelve `false` (al leerlo cambia la
   *       identidad de esta función, así que quien la llama desde un efecto
   *       vuelve a intentarlo). Con `force`, primero quita las posposiciones de
   *       los grupos del pedido. Si `resolveStep` devuelve `'done'` con las
   *       posposiciones vigentes ahora, devuelve `false` sin cambiar nada; si
   *       no, deja abierto el pedido (un pedido `alerts` abierto no baja a
   *       `location`, que es parte de él) y devuelve `true`.
   */
  const askFor = useCallback(
    (wanted: PermissionDemand, options?: RequirePermissionOptions): boolean => {
      if (!snapshot) return false;
      if (options?.force) persistSkips(clearSkips(skips.current, groupsFor(wanted)));
      const skipped = activeSkips(skips.current, Date.now());
      setProgress((p) => (sameGroups(p.skipped, skipped) ? p : { ...p, skipped }));
      if (resolveStep(snapshot, { ...progress, skipped }, wanted) === 'done') return false;
      setDemand((open) => (open === 'alerts' ? open : wanted));
      return true;
    },
    [snapshot, progress, persistSkips],
  );

  const step = snapshot && resolveStep(snapshot, progress, demand);
  // Último paso publicado, para que `release` sepa si el pedido quedó a medias.
  const lastStep = useRef<OnboardingStep | null>(null);
  useEffect(() => {
    lastStep.current = step;
  }, [step]);

  /**
   * Cierra el pedido abierto.
   *
   * @pre Ninguna.
   * @post Si al pedido le faltaba un paso (el usuario lo cerró con «atrás»),
   *       su grupo queda pospuesto como con «Ahora no». `demand = null`.
   */
  const release = useCallback(() => {
    const pending = lastStep.current;
    if (pending && pending !== 'done') skip(groupOf(pending));
    setDemand(null);
  }, [skip]);

  return useMemo(
    () => ({
      snapshot,
      demand,
      step,
      prompting: demand !== null && step !== null && step !== 'done',
      busy,
      error,
      requestForeground: () => run(requestForegroundLocation),
      requestBackground: () => run(requestBackgroundLocation, { backgroundRequested: true }),
      requestNotifications: () => run(requestNotifications, { notificationsRequested: true }),
      openSettings,
      skip,
      askFor,
      release,
    }),
    [snapshot, demand, step, busy, error, run, openSettings, skip, askFor, release],
  );
}

/**
 * Indica si dos listas tienen los mismos grupos.
 *
 * @pre Ninguna.
 * @post `true` si cada grupo de una está en la otra y tienen el mismo largo.
 */
function sameGroups(a: readonly PermissionGroup[], b: readonly PermissionGroup[]): boolean {
  return a.length === b.length && a.every((group) => b.includes(group));
}
