CREATE TABLE `operation_ledger` (
	`id` text PRIMARY KEY,
	`session_id` text NOT NULL,
	`type` text NOT NULL,
	`data` text NOT NULL,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	CONSTRAINT `operation_ledger_session_id_session_id_fk` FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `operation_ledger_session_idx` ON `operation_ledger` (`session_id`);
--> statement-breakpoint
CREATE INDEX `operation_ledger_type_idx` ON `operation_ledger` (`type`);
