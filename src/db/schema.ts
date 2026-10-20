import { relations, sql } from 'drizzle-orm';
import {
  type AnySQLiteColumn,
  check,
  index,
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

// Las marcas de tiempo se generan en JS (no con DEFAULT de SQL) para que el
// comportamiento no dependa de la versión de SQLite del dispositivo.
const timestamps = {
  createdAt: integer('created_at', { mode: 'timestamp_ms' })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
    .notNull()
    .$defaultFn(() => new Date())
    .$onUpdateFn(() => new Date()),
};

export const TASK_STATUSES = ['pending', 'completed', 'archived'] as const;
export const GEOFENCE_TRANSITIONS = ['enter', 'exit', 'dwell'] as const;
export const GEOFENCE_STATES = ['unknown', 'inside', 'outside'] as const;
export const NOTIFICATION_STATUSES = ['scheduled', 'delivered', 'opened', 'dismissed', 'failed'] as const;

/**
 * Construye la expresión de un CHECK que restringe una columna a un conjunto de
 * valores. Los enums de texto de Drizzle solo se validan en TypeScript; esto los
 * replica en la base.
 *
 * @pre `values` no está vacío y ningún valor contiene comillas simples (son
 *      constantes del código, nunca entrada del usuario: se insertan sin escapar).
 * @post Devuelve `<column> IN ('v1', 'v2', ...)` listo para usar en `check()`.
 */
const oneOf = (column: AnySQLiteColumn, values: readonly string[]) =>
  sql`${column} IN (${sql.raw(values.map((v) => `'${v}'`).join(', '))})`;

export type TaskStatus = (typeof TASK_STATUSES)[number];
export type GeofenceTransition = (typeof GEOFENCE_TRANSITIONS)[number];
export type GeofenceState = (typeof GEOFENCE_STATES)[number];
export type NotificationStatus = (typeof NOTIFICATION_STATUSES)[number];

export const categories = sqliteTable(
  'categories',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull(),
    color: text('color'),
    icon: text('icon'),
    // Rubro del catálogo (src/categories/catalog.ts); null en categorías propias del usuario.
    slug: text('slug'),
    // Hasta cuándo no avisa ningún local del rubro (al posponer una tarea, US-6.2).
    snoozedUntil: integer('snoozed_until', { mode: 'timestamp_ms' }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('categories_name_unique').on(t.name),
    uniqueIndex('categories_slug_unique').on(t.slug),
  ],
);

export const locationTargets = sqliteTable(
  'location_targets',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull(),
    address: text('address'),
    latitude: real('latitude').notNull(),
    longitude: real('longitude').notNull(),
    radiusMeters: real('radius_meters').notNull().default(150),
    ...timestamps,
  },
  (t) => [
    check('location_targets_latitude_range', sql`${t.latitude} BETWEEN -90 AND 90`),
    check('location_targets_longitude_range', sql`${t.longitude} BETWEEN -180 AND 180`),
    check('location_targets_radius_positive', sql`${t.radiusMeters} > 0`),
  ],
);

export const tasks = sqliteTable(
  'tasks',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    title: text('title').notNull(),
    notes: text('notes'),
    status: text('status', { enum: TASK_STATUSES }).notNull().default('pending'),
    categoryId: integer('category_id').references(() => categories.id, { onDelete: 'set null' }),
    dueAt: integer('due_at', { mode: 'timestamp_ms' }),
    completedAt: integer('completed_at', { mode: 'timestamp_ms' }),
    // Ventana en la que los avisos suenan (US-5.2); fuera de ella llegan en
    // silencio. Minutos del día, ambos o ninguno; la franja puede cruzar la
    // medianoche. Los rangos se validan en el repositorio y no con CHECK: SQLite
    // no agrega CHECK a una tabla existente y reconstruir `tasks` dentro de la
    // transacción de migración dispararía los ON DELETE CASCADE.
    alertStartMinute: integer('alert_start_minute'),
    alertEndMinute: integer('alert_end_minute'),
    // Días permitidos: bit 0 = lunes … bit 6 = domingo; null = todos.
    alertDays: integer('alert_days'),
    // Pospuesta desde una notificación: no avisa hasta esta fecha (US-6.2).
    snoozedUntil: integer('snoozed_until', { mode: 'timestamp_ms' }),
    ...timestamps,
  },
  (t) => [
    index('tasks_status_idx').on(t.status),
    index('tasks_category_idx').on(t.categoryId),
    check('tasks_status_valid', oneOf(t.status, TASK_STATUSES)),
  ],
);

// Une una tarea con un lugar y guarda el último estado conocido de esa geocerca.
export const geofenceTriggers = sqliteTable(
  'geofence_triggers',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    taskId: integer('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    locationTargetId: integer('location_target_id')
      .notNull()
      .references(() => locationTargets.id, { onDelete: 'cascade' }),
    transition: text('transition', { enum: GEOFENCE_TRANSITIONS }).notNull().default('enter'),
    dwellSeconds: integer('dwell_seconds'),
    isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
    lastState: text('last_state', { enum: GEOFENCE_STATES }).notNull().default('unknown'),
    lastTransitionAt: integer('last_transition_at', { mode: 'timestamp_ms' }),
    ...timestamps,
  },
  (t) => [
    index('geofence_triggers_task_idx').on(t.taskId),
    index('geofence_triggers_location_idx').on(t.locationTargetId),
    index('geofence_triggers_active_idx').on(t.isActive),
    uniqueIndex('geofence_triggers_task_location_transition_unique').on(
      t.taskId,
      t.locationTargetId,
      t.transition,
    ),
    check('geofence_triggers_transition_valid', oneOf(t.transition, GEOFENCE_TRANSITIONS)),
    check('geofence_triggers_state_valid', oneOf(t.lastState, GEOFENCE_STATES)),
    check(
      'geofence_triggers_dwell_requires_seconds',
      sql`${t.transition} <> 'dwell' OR COALESCE(${t.dwellSeconds}, 0) > 0`,
    ),
  ],
);

// Caché local de locales de OpenStreetMap por rubro (US-4.3). Un mismo local
// puede figurar en más de un rubro: hay una fila por (local, rubro).
export const pois = sqliteTable(
  'pois',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    // Tipo y id del elemento de OSM, p. ej. `n474553860` o `w53860890`.
    osmKey: text('osm_key').notNull(),
    categoryId: integer('category_id')
      .notNull()
      .references(() => categories.id, { onDelete: 'cascade' }),
    name: text('name'),
    address: text('address'),
    latitude: real('latitude').notNull(),
    longitude: real('longitude').notNull(),
    fetchedAt: integer('fetched_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [
    uniqueIndex('pois_osm_category_unique').on(t.osmKey, t.categoryId),
    index('pois_category_latitude_idx').on(t.categoryId, t.latitude),
    check('pois_latitude_range', sql`${t.latitude} BETWEEN -90 AND 90`),
    check('pois_longitude_range', sql`${t.longitude} BETWEEN -180 AND 180`),
  ],
);

// Zonas circulares ya descargadas al caché de POIs.
export const poiAreas = sqliteTable(
  'poi_areas',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    centerLatitude: real('center_latitude').notNull(),
    centerLongitude: real('center_longitude').notNull(),
    radiusMeters: real('radius_meters').notNull(),
    // Resumen de las etiquetas del catálogo usadas; si el catálogo cambia, la zona se vuelve a bajar.
    catalogSignature: text('catalog_signature').notNull(),
    poiCount: integer('poi_count').notNull(),
    fetchedAt: integer('fetched_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [
    index('poi_areas_fetched_at_idx').on(t.fetchedAt),
    check('poi_areas_radius_positive', sql`${t.radiusMeters} > 0`),
  ],
);

// Ajustes de la app como pares clave/valor (texto JSON), p. ej. el enfriamiento
// por local o la última posición usada para planificar geocercas.
export const appSettings = sqliteTable('app_settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  ...timestamps,
});

// El historial sobrevive al borrado de la tarea o del trigger (FK set null).
export const notificationLogs = sqliteTable(
  'notification_logs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    taskId: integer('task_id').references(() => tasks.id, { onDelete: 'set null' }),
    geofenceTriggerId: integer('geofence_trigger_id').references(() => geofenceTriggers.id, {
      onDelete: 'set null',
    }),
    // Local de rubro que disparó el aviso (`pois.osm_key`), para su enfriamiento (US-6.2).
    // Sin FK: el historial sobrevive aunque el local salga del caché.
    poiOsmKey: text('poi_osm_key'),
    transition: text('transition', { enum: GEOFENCE_TRANSITIONS }).notNull(),
    title: text('title').notNull(),
    body: text('body'),
    status: text('status', { enum: NOTIFICATION_STATUSES }).notNull().default('scheduled'),
    // `true` si salió sin sonido ni vibración por estar fuera del horario de la tarea.
    silent: integer('silent', { mode: 'boolean' }).notNull().default(false),
    platformNotificationId: text('platform_notification_id'),
    firedAt: integer('fired_at', { mode: 'timestamp_ms' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    index('notification_logs_task_idx').on(t.taskId),
    index('notification_logs_fired_at_idx').on(t.firedAt),
    check('notification_logs_status_valid', oneOf(t.status, NOTIFICATION_STATUSES)),
  ],
);

export const categoriesRelations = relations(categories, ({ many }) => ({
  tasks: many(tasks),
  pois: many(pois),
}));

export const poisRelations = relations(pois, ({ one }) => ({
  category: one(categories, { fields: [pois.categoryId], references: [categories.id] }),
}));

export const tasksRelations = relations(tasks, ({ one, many }) => ({
  category: one(categories, { fields: [tasks.categoryId], references: [categories.id] }),
  geofenceTriggers: many(geofenceTriggers),
  notificationLogs: many(notificationLogs),
}));

export const locationTargetsRelations = relations(locationTargets, ({ many }) => ({
  geofenceTriggers: many(geofenceTriggers),
}));

export const geofenceTriggersRelations = relations(geofenceTriggers, ({ one, many }) => ({
  task: one(tasks, { fields: [geofenceTriggers.taskId], references: [tasks.id] }),
  locationTarget: one(locationTargets, {
    fields: [geofenceTriggers.locationTargetId],
    references: [locationTargets.id],
  }),
  notificationLogs: many(notificationLogs),
}));

export const notificationLogsRelations = relations(notificationLogs, ({ one }) => ({
  task: one(tasks, { fields: [notificationLogs.taskId], references: [tasks.id] }),
  geofenceTrigger: one(geofenceTriggers, {
    fields: [notificationLogs.geofenceTriggerId],
    references: [geofenceTriggers.id],
  }),
}));

export type Category = typeof categories.$inferSelect;
export type NewCategory = typeof categories.$inferInsert;
export type LocationTarget = typeof locationTargets.$inferSelect;
export type NewLocationTarget = typeof locationTargets.$inferInsert;
export type Task = typeof tasks.$inferSelect;
export type NewTask = typeof tasks.$inferInsert;
export type GeofenceTrigger = typeof geofenceTriggers.$inferSelect;
export type NewGeofenceTrigger = typeof geofenceTriggers.$inferInsert;
export type Poi = typeof pois.$inferSelect;
export type NewPoi = typeof pois.$inferInsert;
export type PoiArea = typeof poiAreas.$inferSelect;
export type NewPoiArea = typeof poiAreas.$inferInsert;
export type AppSetting = typeof appSettings.$inferSelect;
export type NotificationLog = typeof notificationLogs.$inferSelect;
export type NewNotificationLog = typeof notificationLogs.$inferInsert;
