CREATE TABLE `alignment_suggestions` (
  `id` text PRIMARY KEY NOT NULL,
  `hymn_id` text NOT NULL,
  `section` text NOT NULL,
  `source_url` text NOT NULL,
  `status` text DEFAULT 'queued' NOT NULL,
  `payload_json` text DEFAULT '{}' NOT NULL,
  `version` integer DEFAULT 1 NOT NULL,
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_alignment_hymn_section` ON `alignment_suggestions` (`hymn_id`,`section`);
