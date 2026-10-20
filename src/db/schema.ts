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
    ...timestamps,
  },
  (t) => [uniqueIndex('categories_name_unique').on(t.name)],
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

// El historial sobrevive al borrado de la tarea o del trigger (FK set null).
export const notificationLogs = sqliteTable(
  'notification_logs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    taskId: integer('task_id').references(() => tasks.id, { onDelete: 'set null' }),
    geofenceTriggerId: integer('geofence_trigger_id').references(() => geofenceTriggers.id, {
      onDelete: 'set null',
    }),
    transition: text('transition', { enum: GEOFENCE_TRANSITIONS }).notNull(),
    title: text('title').notNull(),
    body: text('body'),
    status: text('status', { enum: NOTIFICATION_STATUSES }).notNull().default('scheduled'),
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
export type NotificationLog = typeof notificationLogs.$inferSelect;
export type NewNotificationLog = typeof notificationLogs.$inferInsert;
