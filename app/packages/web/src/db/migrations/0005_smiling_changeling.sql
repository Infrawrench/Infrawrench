ALTER TABLE "ssh_keys" ADD COLUMN "is_imported" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "ssh_keys" ADD COLUMN "fingerprint" text;