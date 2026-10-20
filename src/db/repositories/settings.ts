import { eq } from 'drizzle-orm';

import { appSettings } from '../schema';
import type { AppDatabase } from '../types';

/**
 * Crea el repositorio de ajustes clave/valor.
 *
 * @pre `db` tiene las migraciones aplicadas.
 * @post Devuelve operaciones sobre `app_settings` que usan siempre `db`.
 */
export function createSettingsRepository(db: AppDatabase) {
  return {
    /**
     * Lee un ajuste.
     *
     * @pre Ninguna.
     * @post Devuelve el valor guardado para `key`, o `undefined` si no hay.
     */
    async get(key: string): Promise<string | undefined> {
      const [row] = await db.select({ value: appSettings.value }).from(appSettings).where(eq(appSettings.key, key));
      return row?.value;
    },

    /**
     * Guarda un ajuste, reemplazando el valor anterior.
     *
     * @pre Ninguna.
     * @post `key` queda con `value` y `updatedAt` renovado.
     */
    async set(key: string, value: string): Promise<void> {
      await db
        .insert(appSettings)
        .values({ key, value })
        .onConflictDoUpdate({ target: appSettings.key, set: { value, updatedAt: new Date() } });
    },
  };
}
