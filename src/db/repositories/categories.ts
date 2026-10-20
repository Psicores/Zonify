import { asc, eq } from 'drizzle-orm';

import { categories, type Category, type NewCategory } from '../schema';
import type { AppDatabase } from '../types';

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
