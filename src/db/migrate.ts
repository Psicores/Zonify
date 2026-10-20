import { migrate } from 'drizzle-orm/expo-sqlite/migrator';

import migrations from '../../drizzle/migrations';
import { db } from './client';

// Promesa compartida por todo el runtime de JS: la interfaz y las tareas de
// fondo (geocercas, botones de avisos, caché de POIs) pueden arrancar a la vez.
let migrated: Promise<void> | null = null;

/**
 * Aplica las migraciones pendientes una sola vez por runtime de JS.
 *
 * @pre Ninguna.
 * @post Las migraciones están aplicadas. Las llamadas mientras una está en curso,
 *       o después de que terminó bien, devuelven la misma promesa sin volver a
 *       migrar. Si falla, la siguiente llamada lo reintenta.
 * @throws El error de la migración (que se deshace entera, en una transacción).
 */
export function ensureMigrated(): Promise<void> {
  migrated ??= migrate(db, migrations).catch((e: unknown) => {
    migrated = null;
    throw e;
  });
  return migrated;
}
