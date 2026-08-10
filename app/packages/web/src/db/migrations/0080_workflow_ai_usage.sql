-- Usage rows for `infra.ai(...)` calls made from workflows.
--
-- The AI-chat equivalent is `chat_usage`; this is its own table because chat
-- rows reference a conversation/message, which a workflow run doesn't have.
-- The org's monthly AI spend cap sums BOTH tables (billing/ai-usage.ts), so a
-- workflow and a chat turn draw from the same budget.
--
-- `workflow_id`/`run_id` are deliberately not foreign keys: these are billing
-- records, and deleting a workflow (or pruning its runs) must not delete the
-- spend it caused.

--> statement-breakpoint
CREATE TABLE "workflow_ai_usage" (
  "id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "workflow_id" text NOT NULL,
  "run_id" text,
  "model" text NOT NULL,
  "input_tokens" integer NOT NULL,
  "output_tokens" integer NOT NULL,
  "cache_read_tokens" integer NOT NULL,
  "cache_write_tokens" integer NOT NULL,
  "cost_micros" integer NOT NULL,
  "stripe_usage_record_id" text,
  "created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "workflow_ai_usage_org_created_idx" ON "workflow_ai_usage" ("organization_id", "created_at");
--> statement-breakpoint
CREATE INDEX "workflow_ai_usage_unreported_idx" ON "workflow_ai_usage" ("stripe_usage_record_id");
