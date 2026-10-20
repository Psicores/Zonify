-- Custom SQL migration file, put your code below! --
-- Deja la base en blanco: borra tareas, lugares, avisos, caché de locales y
-- ajustes. El catálogo de rubros se vuelve a sembrar al arrancar (seedCatalog).
DELETE FROM `notification_logs`;
--> statement-breakpoint
DELETE FROM `geofence_triggers`;
--> statement-breakpoint
DELETE FROM `tasks`;
--> statement-breakpoint
DELETE FROM `location_targets`;
--> statement-breakpoint
DELETE FROM `pois`;
--> statement-breakpoint
DELETE FROM `poi_areas`;
--> statement-breakpoint
DELETE FROM `app_settings`;
--> statement-breakpoint
DELETE FROM `categories`;
--> statement-breakpoint
DELETE FROM `sqlite_sequence`;
