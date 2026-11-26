DROP INDEX "git_branch_versions_prune_idx";--> statement-breakpoint
ALTER TABLE "git_branch_versions" ADD COLUMN "pruned_at" timestamp;--> statement-breakpoint
CREATE INDEX "git_review_findings_path_idx" ON "git_review_findings" USING btree ("repository_id","path") WHERE "git_review_findings"."path" is not null;--> statement-breakpoint
CREATE INDEX "git_branch_versions_prune_idx" ON "git_branch_versions" USING btree ("prune_after") WHERE "git_branch_versions"."prune_after" is not null and "git_branch_versions"."pruned_at" is null;