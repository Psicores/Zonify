import * as BackgroundTask from 'expo-background-task';
import * as TaskManager from 'expo-task-manager';
import { useEffect, useMemo, useRef } from 'react';
import { AppState } from 'react-native';

import { db } from '../db/client';
import { createRepositories } from '../db/repositories';
import { POI_SYNC_TASK_NAME } from './background';
import { runPoiSync } from './service';

// El sistema decide cuándo correrla; esto es solo el mínimo entre ejecuciones.
const BACKGROUND_INTERVAL_MINUTES = 6 * 60;

/**
 * Mantiene el caché de POIs (US-4.3). No dibuja nada.
 *
 * @pre Se monta con las migraciones aplicadas y después del onboarding de permisos.
 * @post Registra la tarea periódica `POI_SYNC_TASK_NAME` si no lo estaba, y
 *       llama a `runPoiSync` al montarse y cada vez que la app vuelve a primer
 *       plano, de a una por vez (si ya hay una en curso, no lanza otra). Los
 *       fallos se informan en la consola.
 */
export function PoiSync() {
  const repos = useMemo(() => createRepositories(db), []);
  const running = useRef(false);

  useEffect(() => {
    /**
     * Ejecuta una sincronización si no hay otra en curso.
     *
     * @pre Ninguna.
     * @post Corre `runPoiSync` una vez, o nada si ya había una en curso.
     */
    const runOnce = () => {
      if (running.current) return;
      running.current = true;
      runPoiSync(repos)
        .then((outcome) => {
          if (__DEV__) console.log('[pois] sync', outcome);
        })
        .catch((e: unknown) => console.warn('[pois] no se pudo actualizar el caché:', e))
        .finally(() => {
          running.current = false;
        });
    };

    TaskManager.isTaskRegisteredAsync(POI_SYNC_TASK_NAME)
      .then((registered) =>
        registered
          ? undefined
          : BackgroundTask.registerTaskAsync(POI_SYNC_TASK_NAME, {
              minimumInterval: BACKGROUND_INTERVAL_MINUTES,
            }),
      )
      .catch((e: unknown) => console.warn('[pois] no se pudo programar la tarea de fondo:', e));

    runOnce();
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') runOnce();
    });
    return () => subscription.remove();
  }, [repos]);

  return null;
}
