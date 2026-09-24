-- Engagement (rules-of-engagement) + skill-load tracking for the methodology
-- gates. CREATE statements are made idempotent by the migrator (IF NOT EXISTS);
-- coverage_note.dimension/identity columns are added by the schema reconciler.

CREATE TABLE `methodology_skill_load` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`skill_name` text NOT NULL,
	`agent` text,
	`loads` integer DEFAULT 1 NOT NULL,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	CONSTRAINT `methodology_skill_load_session_id_session_id_fk` FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `methodology_skill_load_session_idx` ON `methodology_skill_load` (`session_id`);
--> statement-breakpoint
CREATE INDEX `methodology_skill_load_lookup_idx` ON `methodology_skill_load` (`session_id`,`skill_name`);
--> statement-breakpoint
CREATE TABLE `engagement` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`authorization_ref` text NOT NULL,
	`scope` text,
	`exclusions` text,
	`rate_limits` text,
	`test_windows` text,
	`identity_types` text,
	`oob_approved` integer DEFAULT 0 NOT NULL,
	`notes` text,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	CONSTRAINT `engagement_session_id_session_id_fk` FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `engagement_session_idx` ON `engagement` (`session_id`);
