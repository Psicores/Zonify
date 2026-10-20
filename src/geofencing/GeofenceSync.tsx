import { useLiveQuery } from 'drizzle-orm/expo-sqlite';
import { useEffect, useMemo, useState } from 'react';
import { AppState } from 'react-native';

import { db } from '../db/client';
import { createRepositories } from '../db/repositories';
import { usePermissions } from '../permissions/PermissionsProvider';
import { geofenceWatchKey } from './model';
import { syncGeofences } from './service';

// Espera desde el último cambio antes de sincronizar: absorbe ráfagas, como
// completar varias tareas seguidas o la carga inicial de las consultas.
const SYNC_DEBOUNCE_MS = 1500;

/**
 * Mantiene registradas en el sistema operativo las geocercas de lugares
 * propios y de locales por rubro (US-3.2, US-4.2). No dibuja nada.
 *
 * @pre Se monta con las migraciones aplicadas, dentro de `PermissionsProvider`.
 * @post Llama a `syncGeofences` `SYNC_DEBOUNCE_MS` después de montarse, de que
 *       cambie `geofenceWatchKey` (alta, baja, completar o archivar tareas,
 *       cambio de rubro o de lugar, zona nueva del caché de POIs), de que cambie
 *       el permiso de ubicación en segundo plano o de que la app vuelva a
 *       primer plano (el permiso pudo cambiar en Ajustes); varios
 *       cambios seguidos dan una sola sincronización. Cambiar un título, el
 *       horario, posponer o registrar una transición de geocerca no sincroniza
 *       (US-2.2). Las sincronizaciones van de a una (`syncGeofences`); un fallo
 *       se informa en la consola.
 */
export function GeofenceSync() {
  const repos = useMemo(() => createRepositories(db), []);
  // Las consultas solo sirven para enterarse de los cambios: `listArmed`
  // escucha `geofence_triggers`, la de tareas `tasks` y la de zonas
  // `poi_areas` (se bajaron locales nuevos para los rubros).
  const pendingQuery = useMemo(() => repos.tasks.list({ status: 'pending' }), [repos]);
  const armedQuery = useMemo(() => repos.geofenceTriggers.listArmed(), [repos]);
  const areasQuery = useMemo(() => repos.pois.listAreas(), [repos]);
  const { data: pending } = useLiveQuery(pendingQuery);
  const { data: armed } = useLiveQuery(armedQuery);
  const { data: areas } = useLiveQuery(areasQuery);
  const [foregroundCount, setForegroundCount] = useState(0);
  const watchKey = geofenceWatchKey(pending, armed, areas);
  // Un diálogo dentro de la app (iOS, Android 10) no pasa por Ajustes ni por AppState.
  const background = usePermissions().snapshot?.background;

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') setForegroundCount((n) => n + 1);
    });
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => {
      syncGeofences(repos)
        .then((result) => {
          if (__DEV__) console.log('[geofence] sync', result);
        })
        .catch((e: unknown) => console.warn('[geofence] no se pudieron registrar las geocercas:', e));
    }, SYNC_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [repos, watchKey, foregroundCount, background]);

  return null;
}
