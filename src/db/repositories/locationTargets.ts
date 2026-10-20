import { asc, eq } from 'drizzle-orm';

import { locationTargets, type LocationTarget, type NewLocationTarget } from '../schema';
import type { AppDatabase } from '../types';

export type LocationTargetUpdate = Partial<Omit<NewLocationTarget, 'id' | 'createdAt' | 'updatedAt'>>;

/**
 * Crea el repositorio de lugares (centros de geocerca).
 *
 * @pre `db` tiene las migraciones aplicadas y `PRAGMA foreign_keys = ON`.
 * @post Devuelve operaciones CRUD sobre `location_targets` que usan siempre `db`.
 */
export function createLocationTargetRepository(db: AppDatabase) {
  return {
    /**
     * Inserta un lugar.
     *
     * @pre `latitude` ∈ [-90, 90], `longitude` ∈ [-180, 180] y, si se indica,
     *      `radiusMeters` > 0.
     * @post Devuelve la fila insertada; `radiusMeters` vale 150 si no se indicó.
     * @throws Error de SQLite (CHECK) si alguna coordenada o el radio están fuera de rango.
     */
    async create(input: NewLocationTarget): Promise<LocationTarget> {
      const [row] = await db.insert(locationTargets).values(input).returning();
      return row;
    },

    /**
     * Busca un lugar por id.
     *
     * @pre Ninguna.
     * @post Devuelve el lugar, o `undefined` si no existe.
     */
    getById(id: number) {
      return db.query.locationTargets.findFirst({ where: eq(locationTargets.id, id) });
    },

    /**
     * Lista todos los lugares.
     *
     * @pre Ninguna.
     * @post Devuelve todas las filas ordenadas por nombre ascendente (vacío si no hay).
     */
    list() {
      return db.select().from(locationTargets).orderBy(asc(locationTargets.name));
    },

    /**
     * Modifica un lugar.
     *
     * @pre `changes` tiene al menos un campo y respeta los mismos rangos que `create`.
     * @post Si existe, persiste los cambios, renueva `updatedAt` y devuelve la fila
     *       actualizada; si no existe, devuelve `undefined` sin modificar nada.
     * @throws Error de SQLite (CHECK) si algún valor queda fuera de rango.
     */
    async update(id: number, changes: LocationTargetUpdate): Promise<LocationTarget | undefined> {
      const [row] = await db
        .update(locationTargets)
        .set(changes)
        .where(eq(locationTargets.id, id))
        .returning();
      return row;
    },

    /**
     * Borra un lugar.
     *
     * @pre Ninguna.
     * @post El lugar ya no existe y se borran en cascada sus `geofence_triggers`.
     *       No falla si el id no existía.
     */
    async remove(id: number): Promise<void> {
      await db.delete(locationTargets).where(eq(locationTargets.id, id));
    },
  };
}
