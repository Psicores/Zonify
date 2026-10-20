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
ALTER TABLE `categories` ADD `slug` text;--> statement-breakpoint
CREATE UNIQUE INDEX `categories_slug_unique` ON `categories` (`slug`);