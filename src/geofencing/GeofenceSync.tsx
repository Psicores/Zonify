import { useLiveQuery } from 'drizzle-orm/expo-sqlite';
import { useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';

import { db } from '../db/client';
import { createRepositories } from '../db/repositories';
import { syncGeofences } from './service';

/**
 * Mantiene registradas en el sistema operativo las geocercas de los triggers
 * armados (US-3.2). No dibuja nada.
 *
 * @pre Se monta con las migraciones aplicadas y después del onboarding de permisos.
 * @post Llama a `syncGeofences` al montarse, cada vez que cambian las tareas
 *       pendientes o los triggers (alta, baja, completar, archivar) y cada vez
 *       que la app vuelve a primer plano (el permiso pudo cambiar en Ajustes).
 *       Las sincronizaciones se ejecutan de a una, en orden; un fallo se informa
 *       en la consola y no frena las siguientes.
 */
export function GeofenceSync() {
  const repos = useMemo(() => createRepositories(db), []);
  // Las dos consultas solo sirven para enterarse de los cambios: `listArmed`
  // escucha `geofence_triggers` y la de tareas, `tasks`.
  const pendingQuery = useMemo(() => repos.tasks.list({ status: 'pending' }), [repos]);
  const armedQuery = useMemo(() => repos.geofenceTriggers.listArmed(), [repos]);
  const { data: pending } = useLiveQuery(pendingQuery);
  const { data: armed } = useLiveQuery(armedQuery);
  const [foregroundCount, setForegroundCount] = useState(0);
  const queue = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') setForegroundCount((n) => n + 1);
    });
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    queue.current = queue.current
      .then(() => syncGeofences(repos))
      .then((result) => {
        if (__DEV__) console.log('[geofence] sync', result);
      })
      .catch((e: unknown) => console.warn('[geofence] no se pudieron registrar las geocercas:', e));
  }, [repos, pending, armed, foregroundCount]);

  return null;
}
