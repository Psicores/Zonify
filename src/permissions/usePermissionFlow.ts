import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';

import {
  INITIAL_PROGRESS,
  resolveStep,
  type FlowProgress,
  type OnboardingStep,
  type PermissionGroup,
  type PermissionSnapshot,
} from './model';
import {
  readPermissionSnapshot,
  requestBackgroundLocation,
  requestForegroundLocation,
  requestNotifications,
} from './service';

export interface PermissionFlow {
  /** `null` mientras se lee el estado inicial. */
  step: OnboardingStep | null;
  snapshot: PermissionSnapshot | null;
  busy: boolean;
  error: string | null;
  requestForeground: () => void;
  requestBackground: () => void;
  requestNotifications: () => void;
  /** Abre una pantalla de Ajustes; al volver, el refresh por AppState relee el estado. */
  openSettings: (open: () => Promise<void>) => void;
  skip: (group: PermissionGroup) => void;
}

/**
 * Estado del onboarding de permisos. Vuelve a leer los permisos cada vez que la
 * app pasa a primer plano, así detecta lo que el usuario cambió en Ajustes.
 *
 * @pre Se usa dentro de un componente de React montado en la app nativa.
 * @post `step` es el paso que corresponde al último estado leído. Mientras una
 *       solicitud está en curso `busy` es `true`; si falla, `error` tiene el mensaje.
 */
export function usePermissionFlow(): PermissionFlow {
  const [snapshot, setSnapshot] = useState<PermissionSnapshot | null>(null);
  const [progress, setProgress] = useState<FlowProgress>(INITIAL_PROGRESS);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Descarta lecturas viejas que terminan después de una más nueva.
  const readId = useRef(0);
  // Marcas de progreso que esperan a publicarse junto con una lectura. En iOS el
  // diálogo nativo dispara un refresh por AppState que puede reemplazar al de la
  // solicitud, y la marca no se tiene que perder.
  const pendingMark = useRef<Partial<FlowProgress>>({});

  /**
   * Lee el estado del sistema y lo publica si sigue siendo la lectura más reciente.
   *
   * @pre Ninguna.
   * @post `mark` queda pendiente hasta que alguna lectura se publique. Si no hubo
   *       otra lectura posterior, `snapshot` queda actualizado y `progress` con
   *       las marcas pendientes aplicadas, en el mismo render; si falla, `error`
   *       tiene el mensaje.
   */
  const refresh = useCallback(async (mark?: Partial<FlowProgress>) => {
    if (mark) Object.assign(pendingMark.current, mark);
    const id = ++readId.current;
    try {
      const next = await readPermissionSnapshot();
      if (id !== readId.current) return;
      const applied = pendingMark.current;
      pendingMark.current = {};
      if (Object.keys(applied).length > 0) setProgress((p) => ({ ...p, ...applied }));
      setSnapshot(next);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    refresh();
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') refresh();
    });
    return () => subscription.remove();
  }, [refresh]);

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
   * Pospone un grupo de permisos hasta el próximo arranque.
   *
   * @pre Ninguna.
   * @post `group` está en `progress.skipped` y el flujo pasa al siguiente grupo.
   */
  const skip = useCallback((group: PermissionGroup) => {
    setProgress((p) => (p.skipped.includes(group) ? p : { ...p, skipped: [...p.skipped, group] }));
  }, []);

  return useMemo(
    () => ({
      step: snapshot && resolveStep(snapshot, progress),
      snapshot,
      busy,
      error,
      requestForeground: () => run(requestForegroundLocation),
      requestBackground: () => run(requestBackgroundLocation, { backgroundRequested: true }),
      requestNotifications: () => run(requestNotifications, { notificationsRequested: true }),
      openSettings,
      skip,
    }),
    [snapshot, progress, busy, error, run, openSettings, skip],
  );
}
