-- Add login credential fields to web_credential (username/password/valid).
-- Enables credential_save → vault → hackbrowser auto-fill flow.

ALTER TABLE web_credential ADD COLUMN username TEXT;
--> statement-breakpoint
ALTER TABLE web_credential ADD COLUMN password TEXT;
--> statement-breakpoint
ALTER TABLE web_credential ADD COLUMN valid integer DEFAULT true;
