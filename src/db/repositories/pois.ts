import { and, between, desc, eq, inArray, lt, sql } from 'drizzle-orm';

import type { Bounds } from '../../places/geo';
import { poiAreas, pois, type NewPoiArea, type Poi, type PoiArea } from '../schema';
import type { AppDatabase } from '../types';

export type PoiInput = Omit<Poi, 'id' | 'fetchedAt'>;

/**
 * Crea el repositorio del caché de POIs por rubro (US-4.3).
 *
 * @pre `db` tiene las migraciones aplicadas y `PRAGMA foreign_keys = ON`.
 * @post Devuelve operaciones sobre `pois` y `poi_areas` que usan siempre `db`.
 */
export function createPoiRepository(db: AppDatabase) {
  return {
    /**
     * Guarda el resultado de descargar una zona, en una sola transacción.
     *
     * @pre `area.fetchedAt` es el momento de la descarga; cada `categoryId` de
     *      `items` existe; `bounds` es el rectángulo que se consultó.
     * @post Los locales de `items` quedan guardados o actualizados (conservan su
     *       `id` si ya estaban); los locales de esos rubros dentro de `bounds`
     *       que no volvieron en esta descarga se borran (cerraron o cambiaron de
     *       rubro); se registra la zona. Devuelve la zona guardada. Si algo falla,
     *       no cambia nada.
     * @throws Error de SQLite (FOREIGN KEY o CHECK) si no se cumple la precondición.
     */
    saveArea(area: Omit<NewPoiArea, 'id'>, bounds: Bounds, categoryIds: number[], items: PoiInput[]): PoiArea {
      const [west, south, east, north] = bounds;
      return db.transaction((tx) => {
        for (const item of items) {
          tx.insert(pois)
            .values({ ...item, fetchedAt: area.fetchedAt })
            .onConflictDoUpdate({
              target: [pois.osmKey, pois.categoryId],
              set: {
                name: item.name,
                address: item.address,
                latitude: item.latitude,
                longitude: item.longitude,
                fetchedAt: area.fetchedAt,
              },
            })
            .run();
        }
        if (categoryIds.length > 0) {
          tx.delete(pois)
            .where(
              and(
                inArray(pois.categoryId, categoryIds),
                between(pois.latitude, south, north),
                between(pois.longitude, west, east),
                lt(pois.fetchedAt, area.fetchedAt),
              ),
            )
            .run();
        }
        return tx.insert(poiAreas).values(area).returning().get();
      });
    },

    /**
     * Lista las zonas descargadas.
     *
     * @pre Ninguna.
     * @post Devuelve todas las zonas, de la descargada más recientemente a la más antigua.
     */
    listAreas() {
      return db.select().from(poiAreas).orderBy(desc(poiAreas.fetchedAt), desc(poiAreas.id));
    },

    /**
     * Lista los locales de ciertos rubros dentro de un rectángulo.
     *
     * @pre `bounds` no cruza el antimeridiano.
     * @post Devuelve los locales cuyo rubro está en `categoryIds` y cuyas
     *       coordenadas caen en `bounds` (bordes incluidos); vacío si
     *       `categoryIds` está vacío.
     */
    async listInBounds(bounds: Bounds, categoryIds: readonly number[]): Promise<Poi[]> {
      if (categoryIds.length === 0) return [];
      const [west, south, east, north] = bounds;
      return db
        .select()
        .from(pois)
        .where(
          and(
            inArray(pois.categoryId, [...categoryIds]),
            between(pois.latitude, south, north),
            between(pois.longitude, west, east),
          ),
        );
    },

    /**
     * Busca un local y todas sus filas de rubro (un local puede tener varias).
     *
     * @pre Ninguna.
     * @post Devuelve las filas con el mismo `osmKey` que la fila `id` (incluida
     *       ella), o vacío si `id` no existe.
     */
    async listSameOsmElement(id: number): Promise<Poi[]> {
      return db
        .select()
        .from(pois)
        .where(eq(pois.osmKey, sql`(SELECT ${pois.osmKey} FROM ${pois} WHERE ${pois.id} = ${id})`));
    },

    /**
     * Borra lo descargado antes de una fecha.
     *
     * @pre Ninguna.
     * @post No quedan zonas ni locales con `fetchedAt` anterior a `before`.
     */
    prune(before: Date): void {
      db.transaction((tx) => {
        tx.delete(poiAreas).where(lt(poiAreas.fetchedAt, before)).run();
        tx.delete(pois).where(lt(pois.fetchedAt, before)).run();
      });
    },
  };
}
