CREATE TABLE `app_settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `categories` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`color` text,
	`icon` text,
	`slug` text,
	`snoozed_until` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `categories_name_unique` ON `categories` (`name`);--> statement-breakpoint
CREATE UNIQUE INDEX `categories_slug_unique` ON `categories` (`slug`);--> statement-breakpoint
CREATE TABLE `geofence_triggers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`task_id` integer NOT NULL,
	`location_target_id` integer NOT NULL,
	`transition` text DEFAULT 'enter' NOT NULL,
	`dwell_seconds` integer,
	`is_active` integer DEFAULT true NOT NULL,
	`last_state` text DEFAULT 'unknown' NOT NULL,
	`last_transition_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`location_target_id`) REFERENCES `location_targets`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "geofence_triggers_transition_valid" CHECK("geofence_triggers"."transition" IN ('enter', 'exit', 'dwell')),
	CONSTRAINT "geofence_triggers_state_valid" CHECK("geofence_triggers"."last_state" IN ('unknown', 'inside', 'outside')),
	CONSTRAINT "geofence_triggers_dwell_requires_seconds" CHECK("geofence_triggers"."transition" <> 'dwell' OR COALESCE("geofence_triggers"."dwell_seconds", 0) > 0)
);
--> statement-breakpoint
CREATE INDEX `geofence_triggers_task_idx` ON `geofence_triggers` (`task_id`);--> statement-breakpoint
CREATE INDEX `geofence_triggers_location_idx` ON `geofence_triggers` (`location_target_id`);--> statement-breakpoint
CREATE INDEX `geofence_triggers_active_idx` ON `geofence_triggers` (`is_active`);--> statement-breakpoint
CREATE UNIQUE INDEX `geofence_triggers_task_location_transition_unique` ON `geofence_triggers` (`task_id`,`location_target_id`,`transition`);--> statement-breakpoint
CREATE TABLE `location_targets` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`address` text,
	`latitude` real NOT NULL,
	`longitude` real NOT NULL,
	`radius_meters` real DEFAULT 150 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "location_targets_latitude_range" CHECK("location_targets"."latitude" BETWEEN -90 AND 90),
	CONSTRAINT "location_targets_longitude_range" CHECK("location_targets"."longitude" BETWEEN -180 AND 180),
	CONSTRAINT "location_targets_radius_positive" CHECK("location_targets"."radius_meters" > 0)
);
--> statement-breakpoint
CREATE TABLE `notification_logs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`task_id` integer,
	`geofence_trigger_id` integer,
	`poi_osm_key` text,
	`transition` text NOT NULL,
	`title` text NOT NULL,
	`body` text,
	`status` text DEFAULT 'scheduled' NOT NULL,
	`silent` integer DEFAULT false NOT NULL,
	`platform_notification_id` text,
	`fired_at` integer NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`geofence_trigger_id`) REFERENCES `geofence_triggers`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "notification_logs_status_valid" CHECK("notification_logs"."status" IN ('scheduled', 'delivered', 'opened', 'dismissed', 'failed'))
);
--> statement-breakpoint
CREATE INDEX `notification_logs_task_idx` ON `notification_logs` (`task_id`);--> statement-breakpoint
CREATE INDEX `notification_logs_fired_at_idx` ON `notification_logs` (`fired_at`);--> statement-breakpoint
CREATE TABLE `poi_areas` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`center_latitude` real NOT NULL,
	`center_longitude` real NOT NULL,
	`radius_meters` real NOT NULL,
	`catalog_signature` text NOT NULL,
	`poi_count` integer NOT NULL,
	`fetched_at` integer NOT NULL,
	CONSTRAINT "poi_areas_radius_positive" CHECK("poi_areas"."radius_meters" > 0)
);
--> statement-breakpoint
CREATE INDEX `poi_areas_fetched_at_idx` ON `poi_areas` (`fetched_at`);--> statement-breakpoint
CREATE TABLE `pois` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`osm_key` text NOT NULL,
	`category_id` integer NOT NULL,
	`name` text,
	`address` text,
	`latitude` real NOT NULL,
	`longitude` real NOT NULL,
	`fetched_at` integer NOT NULL,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "pois_latitude_range" CHECK("pois"."latitude" BETWEEN -90 AND 90),
	CONSTRAINT "pois_longitude_range" CHECK("pois"."longitude" BETWEEN -180 AND 180)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pois_osm_category_unique` ON `pois` (`osm_key`,`category_id`);--> statement-breakpoint
CREATE INDEX `pois_category_latitude_idx` ON `pois` (`category_id`,`latitude`);--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`title` text NOT NULL,
	`notes` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`category_id` integer,
	`due_at` integer,
	`completed_at` integer,
	`alert_start_minute` integer,
	`alert_end_minute` integer,
	`alert_days` integer,
	`snoozed_until` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "tasks_status_valid" CHECK("tasks"."status" IN ('pending', 'completed', 'archived'))
);
--> statement-breakpoint
CREATE INDEX `tasks_status_idx` ON `tasks` (`status`);--> statement-breakpoint
CREATE INDEX `tasks_category_idx` ON `tasks` (`category_id`);