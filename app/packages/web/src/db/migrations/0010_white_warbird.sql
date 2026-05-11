-- Add the hashed_token column for invitations. Existing rows are backfilled by
-- computing the SHA-256 hash of the legacy plaintext token so accept/lookup
-- continues to work after this migration. The legacy `token` column is kept
-- for now (still NOT NULL) for one release while callers transition off it;
-- a future migration will drop it once all rows are confirmed migrated.
CREATE EXTENSION IF NOT EXISTS "pgcrypto";--> statement-breakpoint
ALTER TABLE "invitations" ADD COLUMN "hashed_token" text;--> statement-breakpoint
UPDATE "invitations" SET "hashed_token" = encode(digest("token", 'sha256'), 'hex') WHERE "hashed_token" IS NULL;--> statement-breakpoint
ALTER TABLE "invitations" ALTER COLUMN "hashed_token" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "invitations_hashed_token_unique" ON "invitations" USING btree ("hashed_token");
