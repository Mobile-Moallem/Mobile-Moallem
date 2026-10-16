CREATE TABLE `hymn_projects` (
	`hymn_id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`season` text NOT NULL,
	`service` text NOT NULL,
	`owner_email` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`timings_json` text DEFAULT '[]' NOT NULL,
	`hazzat_timings_json` text DEFAULT '[]' NOT NULL,
	`hazzat_line_timings_json` text DEFAULT '[]' NOT NULL,
	`recording_url` text,
	`recording_key` text,
	`notation_html` text,
	`notation_key` text,
	`updated_at` integer NOT NULL,
	`completed_at` integer
);
--> statement-breakpoint
CREATE INDEX `idx_hymn_projects_owner_updated` ON `hymn_projects` (`owner_email`,`updated_at`);--> statement-breakpoint
CREATE INDEX `idx_hymn_projects_status` ON `hymn_projects` (`status`);