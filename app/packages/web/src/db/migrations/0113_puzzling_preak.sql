-- NOTE: drizzle-kit generated this file against snapshots that predated the
-- custom 0103–0112 migrations (quota radar, shared consoles, incident mode,
-- change revert, cost-per-change, backup coverage, IaC, ephemeral
-- environments, workflow secrets, chat secret requests), so it also
-- re-emitted CREATE TABLE / ADD COLUMN for objects those files already
-- applied. Those statements are removed here — against any database that
-- ran 0103–0112 they would abort the whole migration on the first CREATE
-- TABLE. The 0113 snapshot reflects the full current schema, ending the
-- drift that caused this.

ALTER TABLE "chat_conversations" ALTER COLUMN "model" SET DEFAULT 'gemini-3.7-flash';
