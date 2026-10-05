ALTER TABLE "cost_billing_rules" ADD COLUMN "managed_account_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "managed_accounts" ADD COLUMN "pricing" jsonb;