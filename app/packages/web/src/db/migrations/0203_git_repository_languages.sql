ALTER TABLE "git_repositories" ADD COLUMN "languages" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "git_repositories" ADD COLUMN "languages_commit" text;