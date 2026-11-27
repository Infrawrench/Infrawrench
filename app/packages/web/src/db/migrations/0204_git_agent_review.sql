CREATE TABLE "git_agent_links" (
	"pull_request_id" text PRIMARY KEY NOT NULL,
	"repository_id" text NOT NULL,
	"kind" text NOT NULL,
	"display_name" text NOT NULL,
	"external_refs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"t3_environment_id" text,
	"connected_by_user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "git_branch_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"repository_id" text NOT NULL,
	"branch" text NOT NULL,
	"lineage" integer NOT NULL,
	"number" integer NOT NULL,
	"tip_oid" text NOT NULL,
	"base_oid" text,
	"target_ref" text,
	"previous_oid" text,
	"forced" boolean DEFAULT false NOT NULL,
	"pusher_user_id" text,
	"pusher_kind" text,
	"agent" jsonb,
	"pull_request_id" text,
	"commits_count" integer,
	"additions" integer,
	"deletions" integer,
	"changed_files" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"prune_after" timestamp
);
--> statement-breakpoint
CREATE TABLE "git_instructions" (
	"id" text PRIMARY KEY NOT NULL,
	"repository_id" text NOT NULL,
	"pull_request_id" text NOT NULL,
	"source" text NOT NULL,
	"review_comment_id" text,
	"finding_id" text,
	"body" text NOT NULL,
	"created_by_user_id" text,
	"status" text DEFAULT 'queued' NOT NULL,
	"delivered_via" text,
	"delivered_at" timestamp,
	"answered_in_version_id" text,
	"answered_in_version_number" integer,
	"answered_at" timestamp,
	"dismissed_by_user_id" text,
	"dismissed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "git_merge_overrides" (
	"id" text PRIMARY KEY NOT NULL,
	"repository_id" text NOT NULL,
	"pull_request_id" text NOT NULL,
	"user_id" text,
	"reason" text NOT NULL,
	"finding_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"head_oid" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "git_review_findings" (
	"id" text PRIMARY KEY NOT NULL,
	"repository_id" text NOT NULL,
	"pull_request_id" text NOT NULL,
	"run_id" text,
	"version_id" text,
	"version_number" integer NOT NULL,
	"last_seen_version_number" integer NOT NULL,
	"reviewer_kind" text NOT NULL,
	"fingerprint" text NOT NULL,
	"path" text,
	"side" text DEFAULT 'RIGHT' NOT NULL,
	"start_line" integer,
	"end_line" integer,
	"commit_oid" text NOT NULL,
	"severity" text NOT NULL,
	"title" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"fixed_in_version_number" integer,
	"dismissed_by_user_id" text,
	"dismissed_at" timestamp,
	"dismissal_reason" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "git_review_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"repository_id" text NOT NULL,
	"pull_request_id" text NOT NULL,
	"version_id" text,
	"version_number" integer NOT NULL,
	"head_oid" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"reviewer_kinds" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"trigger" text DEFAULT 'push' NOT NULL,
	"requested_by_user_id" text,
	"model" text,
	"input_tokens" bigint DEFAULT 0 NOT NULL,
	"output_tokens" bigint DEFAULT 0 NOT NULL,
	"cost_micros" bigint DEFAULT 0 NOT NULL,
	"error" text,
	"started_at" timestamp,
	"finished_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "git_review_settings" (
	"repository_id" text PRIMARY KEY NOT NULL,
	"auto_open_branch_pages" boolean DEFAULT true NOT NULL,
	"review_agents_enabled" boolean DEFAULT false NOT NULL,
	"reviewer_kinds" jsonb DEFAULT '["general"]'::jsonb NOT NULL,
	"must_fix_blocks_merge" boolean DEFAULT true NOT NULL,
	"updated_by_user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "git_t3_environments" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"label" text NOT NULL,
	"base_url" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"oauth_client_id" text,
	"oauth_metadata" jsonb,
	"credentials_ciphertext" text,
	"credentials_iv" text,
	"oauth_state" text,
	"oauth_state_expires_at" timestamp,
	"token_expires_at" timestamp,
	"scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_error" text,
	"last_used_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "git_trace_entries" (
	"id" text PRIMARY KEY NOT NULL,
	"repository_id" text NOT NULL,
	"branch" text NOT NULL,
	"version_id" text,
	"kind" text NOT NULL,
	"body" text NOT NULL,
	"anchors" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"evidence" jsonb,
	"author_user_id" text,
	"agent" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "git_version_reviews" (
	"pull_request_id" text NOT NULL,
	"user_id" text NOT NULL,
	"version_id" text,
	"lineage" integer NOT NULL,
	"version_number" integer NOT NULL,
	"tip_oid" text NOT NULL,
	"reviewed_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "git_version_reviews_pull_request_id_user_id_pk" PRIMARY KEY("pull_request_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "git_review_comments" ADD COLUMN "version_number" integer;--> statement-breakpoint
ALTER TABLE "git_review_comments" ADD COLUMN "answered_in_version" integer;--> statement-breakpoint
ALTER TABLE "git_users" ADD COLUMN "review_mode" text DEFAULT 'agent' NOT NULL;--> statement-breakpoint
ALTER TABLE "git_agent_links" ADD CONSTRAINT "git_agent_links_pull_request_id_git_pull_requests_issue_id_fk" FOREIGN KEY ("pull_request_id") REFERENCES "public"."git_pull_requests"("issue_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_agent_links" ADD CONSTRAINT "git_agent_links_repository_id_git_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."git_repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_agent_links" ADD CONSTRAINT "git_agent_links_t3_environment_id_git_t3_environments_id_fk" FOREIGN KEY ("t3_environment_id") REFERENCES "public"."git_t3_environments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_agent_links" ADD CONSTRAINT "git_agent_links_connected_by_user_id_users_id_fk" FOREIGN KEY ("connected_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_branch_versions" ADD CONSTRAINT "git_branch_versions_repository_id_git_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."git_repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_branch_versions" ADD CONSTRAINT "git_branch_versions_pusher_user_id_users_id_fk" FOREIGN KEY ("pusher_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_branch_versions" ADD CONSTRAINT "git_branch_versions_pull_request_id_git_pull_requests_issue_id_fk" FOREIGN KEY ("pull_request_id") REFERENCES "public"."git_pull_requests"("issue_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_instructions" ADD CONSTRAINT "git_instructions_repository_id_git_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."git_repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_instructions" ADD CONSTRAINT "git_instructions_pull_request_id_git_pull_requests_issue_id_fk" FOREIGN KEY ("pull_request_id") REFERENCES "public"."git_pull_requests"("issue_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_instructions" ADD CONSTRAINT "git_instructions_review_comment_id_git_review_comments_id_fk" FOREIGN KEY ("review_comment_id") REFERENCES "public"."git_review_comments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_instructions" ADD CONSTRAINT "git_instructions_finding_id_git_review_findings_id_fk" FOREIGN KEY ("finding_id") REFERENCES "public"."git_review_findings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_instructions" ADD CONSTRAINT "git_instructions_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_instructions" ADD CONSTRAINT "git_instructions_answered_in_version_id_git_branch_versions_id_fk" FOREIGN KEY ("answered_in_version_id") REFERENCES "public"."git_branch_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_instructions" ADD CONSTRAINT "git_instructions_dismissed_by_user_id_users_id_fk" FOREIGN KEY ("dismissed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_merge_overrides" ADD CONSTRAINT "git_merge_overrides_repository_id_git_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."git_repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_merge_overrides" ADD CONSTRAINT "git_merge_overrides_pull_request_id_git_pull_requests_issue_id_fk" FOREIGN KEY ("pull_request_id") REFERENCES "public"."git_pull_requests"("issue_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_merge_overrides" ADD CONSTRAINT "git_merge_overrides_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_review_findings" ADD CONSTRAINT "git_review_findings_repository_id_git_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."git_repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_review_findings" ADD CONSTRAINT "git_review_findings_pull_request_id_git_pull_requests_issue_id_fk" FOREIGN KEY ("pull_request_id") REFERENCES "public"."git_pull_requests"("issue_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_review_findings" ADD CONSTRAINT "git_review_findings_run_id_git_review_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."git_review_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_review_findings" ADD CONSTRAINT "git_review_findings_version_id_git_branch_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."git_branch_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_review_findings" ADD CONSTRAINT "git_review_findings_dismissed_by_user_id_users_id_fk" FOREIGN KEY ("dismissed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_review_runs" ADD CONSTRAINT "git_review_runs_repository_id_git_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."git_repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_review_runs" ADD CONSTRAINT "git_review_runs_pull_request_id_git_pull_requests_issue_id_fk" FOREIGN KEY ("pull_request_id") REFERENCES "public"."git_pull_requests"("issue_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_review_runs" ADD CONSTRAINT "git_review_runs_version_id_git_branch_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."git_branch_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_review_runs" ADD CONSTRAINT "git_review_runs_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_review_settings" ADD CONSTRAINT "git_review_settings_repository_id_git_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."git_repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_review_settings" ADD CONSTRAINT "git_review_settings_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_t3_environments" ADD CONSTRAINT "git_t3_environments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_trace_entries" ADD CONSTRAINT "git_trace_entries_repository_id_git_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."git_repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_trace_entries" ADD CONSTRAINT "git_trace_entries_version_id_git_branch_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."git_branch_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_trace_entries" ADD CONSTRAINT "git_trace_entries_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_version_reviews" ADD CONSTRAINT "git_version_reviews_pull_request_id_git_pull_requests_issue_id_fk" FOREIGN KEY ("pull_request_id") REFERENCES "public"."git_pull_requests"("issue_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_version_reviews" ADD CONSTRAINT "git_version_reviews_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_version_reviews" ADD CONSTRAINT "git_version_reviews_version_id_git_branch_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."git_branch_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "git_agent_links_repository_idx" ON "git_agent_links" USING btree ("repository_id");--> statement-breakpoint
CREATE UNIQUE INDEX "git_branch_versions_number_idx" ON "git_branch_versions" USING btree ("repository_id","branch","lineage","number");--> statement-breakpoint
CREATE INDEX "git_branch_versions_pull_idx" ON "git_branch_versions" USING btree ("pull_request_id","number");--> statement-breakpoint
CREATE INDEX "git_branch_versions_prune_idx" ON "git_branch_versions" USING btree ("prune_after") WHERE "git_branch_versions"."prune_after" is not null;--> statement-breakpoint
CREATE INDEX "git_instructions_pull_status_idx" ON "git_instructions" USING btree ("pull_request_id","status");--> statement-breakpoint
CREATE INDEX "git_merge_overrides_pull_idx" ON "git_merge_overrides" USING btree ("pull_request_id","created_at");--> statement-breakpoint
CREATE INDEX "git_review_findings_pull_status_idx" ON "git_review_findings" USING btree ("pull_request_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "git_review_findings_fingerprint_idx" ON "git_review_findings" USING btree ("pull_request_id","fingerprint");--> statement-breakpoint
CREATE INDEX "git_review_runs_pull_idx" ON "git_review_runs" USING btree ("pull_request_id","created_at");--> statement-breakpoint
CREATE INDEX "git_review_runs_active_idx" ON "git_review_runs" USING btree ("status","created_at") WHERE "git_review_runs"."status" in ('queued', 'running');--> statement-breakpoint
CREATE UNIQUE INDEX "git_t3_environments_user_url_idx" ON "git_t3_environments" USING btree ("user_id","base_url");--> statement-breakpoint
CREATE UNIQUE INDEX "git_t3_environments_state_idx" ON "git_t3_environments" USING btree ("oauth_state") WHERE "git_t3_environments"."oauth_state" is not null;--> statement-breakpoint
CREATE INDEX "git_trace_entries_version_idx" ON "git_trace_entries" USING btree ("version_id","created_at");--> statement-breakpoint
CREATE INDEX "git_trace_entries_pending_idx" ON "git_trace_entries" USING btree ("repository_id","branch","created_at") WHERE "git_trace_entries"."version_id" is null;--> statement-breakpoint
CREATE INDEX "git_version_reviews_user_idx" ON "git_version_reviews" USING btree ("user_id");