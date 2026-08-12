ALTER TABLE "status_pages" ADD COLUMN "custom_hostname" text;--> statement-breakpoint
ALTER TABLE "status_pages" ADD COLUMN "custom_hostname_status" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "status_pages" ADD COLUMN "cloudflare_custom_hostname_id" text;--> statement-breakpoint
ALTER TABLE "status_pages" ADD COLUMN "custom_hostname_error" text;--> statement-breakpoint
ALTER TABLE "status_pages" ADD COLUMN "custom_hostname_verification" jsonb;--> statement-breakpoint
CREATE UNIQUE INDEX "status_pages_custom_hostname_unique" ON "status_pages" USING btree ("custom_hostname");