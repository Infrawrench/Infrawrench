ALTER TABLE "accounts" ADD COLUMN "requires_gateway" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "gateway_reason" text;