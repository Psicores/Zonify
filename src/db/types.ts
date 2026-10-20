import type { BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core';

import type * as schema from './schema';

/**
 * Conexión a la base, independiente del driver. Los repositorios dependen de
 * este tipo y no de expo-sqlite, para que la capa de datos no quede atada a
 * React Native.
 */
export type AppDatabase = BaseSQLiteDatabase<'sync', unknown, typeof schema>;
