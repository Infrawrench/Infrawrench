ALTER TABLE "managed_invoices" ADD COLUMN "delivery_status" text;--> statement-breakpoint
ALTER TABLE "managed_invoices" ADD COLUMN "delivery_recipients" jsonb;--> statement-breakpoint
ALTER TABLE "managed_invoices" ADD COLUMN "delivery_delivered" integer;--> statement-breakpoint
ALTER TABLE "managed_invoices" ADD COLUMN "delivery_attempted_at" timestamp;--> statement-breakpoint
ALTER TABLE "managed_invoices" ADD COLUMN "delivered_at" timestamp;--> statement-breakpoint
ALTER TABLE "managed_invoices" ADD COLUMN "delivery_attempt_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "managed_invoices" ADD COLUMN "delivery_error" text;