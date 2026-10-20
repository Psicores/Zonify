import { and, asc, eq, isNull, or } from 'drizzle-orm';

import { categories, type Category, type NewCategory } from '../schema';
import type { AppDatabase } from '../types';

/** Datos de un rubro del catálogo que se guardan en la base. */
export interface CatalogEntry {
  slug: string;
  name: string;
  icon: string;
  color: string;
}

export type CategoryUpdate = Partial<Omit<NewCategory, 'id' | 'createdAt' | 'updatedAt'>>;

/**
 * Crea el repositorio de categorías.
 *
 * @pre `db` tiene las migraciones aplicadas y `PRAGMA foreign_keys = ON`.
 * @post Devuelve operaciones CRUD sobre `categories` que usan siempre `db`.
 */
export function createCategoryRepository(db: AppDatabase) {
  return {
    /**
     * Inserta una categoría.
     *
     * @pre `input.name` no lo usa otra categoría.
     * @post Devuelve la fila insertada con `id`, `createdAt` y `updatedAt` asignados.
     * @throws Error de SQLite (UNIQUE) si el nombre ya existe.
     */
    async create(input: NewCategory): Promise<Category> {
      const [row] = await db.insert(categories).values(input).returning();
      return row;
    },

    /**
     * Crea o actualiza en la base los rubros del catálogo, en una transacción.
     *
     * @pre Los `slug` y los `name` de `entries` no se repiten entre sí.
     * @post Por cada rubro existe una categoría con ese `slug` y con su `name`,
     *       `icon` y `color` actuales. Si había una categoría propia (sin `slug`)
     *       con el mismo nombre, se adopta en vez de crear otra, así sus tareas
     *       quedan en el rubro. Devuelve el id de la categoría de cada `slug`.
     *       Llamarla de nuevo con los mismos datos no cambia nada.
     * @throws Error de SQLite (UNIQUE) si otra categoría con otro `slug` ya usa
     *         el nombre de un rubro; en ese caso no cambia nada.
     */
    ensureCatalog(entries: readonly CatalogEntry[]): Map<string, number> {
      return db.transaction((tx) => {
        const ids = new Map<string, number>();
        for (const entry of entries) {
          const existing = tx
            .select()
            .from(categories)
            .where(
              or(
                eq(categories.slug, entry.slug),
                and(isNull(categories.slug), eq(categories.name, entry.name)),
              ),
            )
            .all();
          // Si están las dos, gana la que ya tiene el slug.
          const current = existing.find((c) => c.slug === entry.slug) ?? existing[0];
          if (!current) {
            ids.set(entry.slug, tx.insert(categories).values(entry).returning({ id: categories.id }).get().id);
            continue;
          }
          const changed =
            current.slug !== entry.slug ||
            current.name !== entry.name ||
            current.icon !== entry.icon ||
            current.color !== entry.color;
          if (changed) tx.update(categories).set(entry).where(eq(categories.id, current.id)).run();
          ids.set(entry.slug, current.id);
        }
        return ids;
      });
    },

    /**
     * Busca una categoría por id.
     *
     * @pre Ninguna.
     * @post Devuelve la categoría, o `undefined` si no existe.
     */
    getById(id: number) {
      return db.query.categories.findFirst({ where: eq(categories.id, id) });
    },

    /**
     * Lista todas las categorías.
     *
     * @pre Ninguna.
     * @post Devuelve todas las filas ordenadas por nombre ascendente (vacío si no hay).
     */
    list() {
      return db.select().from(categories).orderBy(asc(categories.name));
    },

    /**
     * Modifica una categoría.
     *
     * @pre `changes` tiene al menos un campo; si cambia `name`, no lo usa otra categoría.
     * @post Si existe, persiste los cambios, renueva `updatedAt` y devuelve la fila
     *       actualizada; si no existe, devuelve `undefined` sin modificar nada.
     * @throws Error de SQLite (UNIQUE) si el nuevo nombre ya existe.
     */
    async update(id: number, changes: CategoryUpdate): Promise<Category | undefined> {
      const [row] = await db.update(categories).set(changes).where(eq(categories.id, id)).returning();
      return row;
    },

    /**
     * Borra una categoría.
     *
     * @pre Ninguna.
     * @post La categoría ya no existe y sus tareas quedan con `categoryId = null`.
     *       No falla si el id no existía.
     */
    async remove(id: number): Promise<void> {
      await db.delete(categories).where(eq(categories.id, id));
    },
  };
}
