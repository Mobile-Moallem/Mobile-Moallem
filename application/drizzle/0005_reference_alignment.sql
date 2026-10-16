CREATE TABLE `reference_alignment_drafts` (
  `id` text PRIMARY KEY NOT NULL,
  `hymn_id` text NOT NULL,
  `section` text NOT NULL,
  `payload_json` text DEFAULT '{}' NOT NULL,
  `revision` integer DEFAULT 1 NOT NULL,
  `status` text DEFAULT 'review' NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_reference_alignment_hymn_updated` ON `reference_alignment_drafts` (`hymn_id`,`updated_at`);
