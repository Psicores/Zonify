/** Etiqueta de OpenStreetMap `clave=valor` que identifica locales de un rubro. */
export interface OsmTag {
  key: 'amenity' | 'shop' | 'leisure';
  value: string;
}

export interface CatalogCategory {
  /** Identificador estable; es la clave con que se guarda en `categories.slug`. */
  slug: string;
  name: string;
  /** Emoji que se muestra en los chips (decorativo: el nombre va como etiqueta accesible). */
  icon: string;
  color: string;
  tags: readonly OsmTag[];
}

/**
 * Rubros base (US-4.1). Cambiar un `slug` rompe la relación con las tareas ya
 * guardadas: para renombrar un rubro se cambia `name`.
 */
export const CATEGORY_CATALOG: readonly CatalogCategory[] = [
  {
    slug: 'pharmacy',
    name: 'Farmacia',
    icon: '💊',
    color: '#16a34a',
    tags: [{ key: 'amenity', value: 'pharmacy' }],
  },
  {
    slug: 'pets',
    name: 'Mascotas / Veterinaria',
    icon: '🐾',
    color: '#ea580c',
    tags: [
      { key: 'shop', value: 'pet' },
      { key: 'amenity', value: 'veterinary' },
    ],
  },
  {
    slug: 'grocery',
    name: 'Supermercado / Almacén',
    icon: '🛒',
    color: '#2563eb',
    tags: [
      { key: 'shop', value: 'supermarket' },
      { key: 'shop', value: 'convenience' },
    ],
  },
  {
    slug: 'gym',
    name: 'Gimnasio',
    icon: '🏋️',
    color: '#9333ea',
    tags: [{ key: 'leisure', value: 'fitness_centre' }],
  },
  {
    slug: 'cinema',
    name: 'Cine',
    icon: '🎬',
    color: '#db2777',
    tags: [{ key: 'amenity', value: 'cinema' }],
  },
];

const BY_SLUG = new Map(CATEGORY_CATALOG.map((category) => [category.slug, category]));

/**
 * Busca un rubro del catálogo.
 *
 * @pre Ninguna.
 * @post Devuelve el rubro con ese `slug`, o `undefined` si no está en el catálogo.
 */
export function catalogCategory(slug: string | null | undefined): CatalogCategory | undefined {
  return slug ? BY_SLUG.get(slug) : undefined;
}

/**
 * Rubros del catálogo a los que pertenece un elemento de OpenStreetMap.
 *
 * @pre Ninguna (las etiquetas vienen de la red).
 * @post Devuelve los `slug` de todos los rubros con alguna etiqueta presente en
 *       `tags` (un local puede ser de más de uno), en el orden del catálogo y sin
 *       repetir; vacío si no coincide ninguno.
 */
export function slugsForOsmTags(tags: Record<string, unknown> | null | undefined): string[] {
  if (!tags) return [];
  return CATEGORY_CATALOG.filter((category) =>
    category.tags.some((tag) => tags[tag.key] === tag.value),
  ).map((category) => category.slug);
}
