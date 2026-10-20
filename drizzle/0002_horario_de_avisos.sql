ALTER TABLE `notification_logs` ADD `silent` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `tasks` ADD `alert_start_minute` integer;--> statement-breakpoint
ALTER TABLE `tasks` ADD `alert_end_minute` integer;--> statement-breakpoint
ALTER TABLE `tasks` ADD `alert_days` integer;