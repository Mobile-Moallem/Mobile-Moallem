ALTER TABLE `hymn_projects` ADD `coptic_text` text;
--> statement-breakpoint
ALTER TABLE `hymn_projects` ADD `coptic_timings_json` text DEFAULT '[]' NOT NULL;
