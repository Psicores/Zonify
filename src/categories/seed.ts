import type { Repositories } from '../db/repositories';
import { CATEGORY_CATALOG } from './catalog';

/**
 * Guarda en la base los rubros del catálogo (ver `ensureCatalog`).
 *
 * @pre Las migraciones están aplicadas.
 * @post Cada rubro de `CATEGORY_CATALOG` tiene su fila en `categories`;
 *       devuelve el id de cada `slug`.
 * @throws Igual que `ensureCatalog`.
 */
export function seedCatalog(repos: Repositories): Map<string, number> {
  return repos.categories.ensureCatalog(
    CATEGORY_CATALOG.map(({ slug, name, icon, color }) => ({ slug, name, icon, color })),
  );
}
