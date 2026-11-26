ALTER TABLE "git_terraform_runs" DROP CONSTRAINT "git_terraform_runs_status_valid";--> statement-breakpoint
ALTER TABLE "ci_runs" ADD COLUMN "terraform_run_id" text;--> statement-breakpoint
ALTER TABLE "git_terraform_runs" ADD COLUMN "cost_priced_at" timestamp;--> statement-breakpoint
ALTER TABLE "git_terraform_workspaces" ADD COLUMN "linked_state_version_id" text;--> statement-breakpoint
ALTER TABLE "git_terraform_workspaces" ADD COLUMN "linked_at" timestamp;--> statement-breakpoint
ALTER TABLE "git_terraform_runs" ADD CONSTRAINT "git_terraform_runs_status_valid" CHECK ("git_terraform_runs"."status" IN ('queued', 'running', 'planned', 'awaiting_approval', 'applied', 'failed', 'cancelled', 'superseded', 'skipped'));