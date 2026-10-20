CREATE TABLE `app_settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `categories` ADD `snoozed_until` integer;--> statement-breakpoint
ALTER TABLE `notification_logs` ADD `poi_osm_key` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `snoozed_until` integer;