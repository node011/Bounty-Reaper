ALTER TABLE `web_credential` ADD `username` text;
--> statement-breakpoint
ALTER TABLE `web_credential` ADD `password` text;
--> statement-breakpoint
ALTER TABLE `web_credential` ADD `valid` integer DEFAULT true;
--> statement-breakpoint
