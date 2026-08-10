-- Usage rows for `infra.ai(...)` calls made from workflows, plus the shared
-- in-flight spend reservation table used by both workflows and AI chat.
--
-- The AI-chat equivalent of workflow_ai_usage is `chat_usage`; this is its own
-- table because chat rows reference a conversation/message, which a workflow
-- run doesn't have. The org's monthly AI spend cap sums BOTH usage tables
-- (billing/ai-usage.ts), so a workflow and a chat turn draw from the same budget.
--
-- `workflow_id`/`run_id` are deliberately not foreign keys: these are billing
-- records, and deleting a workflow (or pruning its runs) must not delete the
-- spend it caused.
--
-- `ai_spend_reservations` holds estimated cost while a provider call is in
-- flight (chat or workflow). Concurrent callers take an org advisory lock,
-- purge expired rows, and insert here so they see each other's hold on the
-- shared pool. `expires_at` is refreshed while the call is still running; a
-- crashed process stops refreshing and the row ages out so it cannot
-- permanently block an org.

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
--> statement-breakpoint
CREATE TABLE "ai_spend_reservations" (
  "id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "estimated_cost_micros" integer NOT NULL,
  "expires_at" timestamp NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "ai_spend_reservations_org_expires_idx" ON "ai_spend_reservations" ("organization_id", "expires_at");
