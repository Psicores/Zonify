import { drizzle } from 'drizzle-orm/expo-sqlite';
import { openDatabaseSync } from 'expo-sqlite';

import * as schema from './schema';

export const DATABASE_NAME = 'zonify.db';

// enableChangeListener permite que useLiveQuery de Drizzle reaccione a escrituras.
export const expoDb = openDatabaseSync(DATABASE_NAME, { enableChangeListener: true });

// SQLite desactiva las FK por conexión; WAL evita que las lecturas se bloqueen
// mientras escriben las tareas de geocercas en background.
expoDb.execSync('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

/**
 * Instancia única de Drizzle sobre la base del dispositivo.
 * Antes de usarla hay que aplicar las migraciones (lo hace `useMigrations` en `App`).
 */
export const db = drizzle(expoDb, { schema });
