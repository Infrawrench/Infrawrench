ALTER TABLE "chat_conversations" ALTER COLUMN "model" SET DEFAULT 'claude-sonnet-5-5';--> statement-breakpoint
-- Chat runs on Claude Sonnet 5.5 and Opus 5.5 only. Opus 5.5 conversations
-- keep their model; every other one (Gemini, older Claude) moves to Sonnet
-- 5.5 with its history intact.
UPDATE "chat_conversations" SET "model" = 'claude-sonnet-5-5' WHERE "model" NOT IN ('claude-sonnet-5-5', 'claude-opus-5-5');
