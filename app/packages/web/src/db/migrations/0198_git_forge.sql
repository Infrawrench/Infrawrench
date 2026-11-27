CREATE TABLE "git_access_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"prefix" text NOT NULL,
	"hashed_token" text NOT NULL,
	"scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"expires_at" timestamp,
	"last_used_at" timestamp,
	"revoked_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "git_collaborators" (
	"id" text PRIMARY KEY NOT NULL,
	"repository_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text NOT NULL,
	"added_by_user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "git_comments" (
	"id" text PRIMARY KEY NOT NULL,
	"issue_id" text NOT NULL,
	"repository_id" text NOT NULL,
	"author_user_id" text,
	"body" text NOT NULL,
	"edited_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "git_commit_statuses" (
	"id" text PRIMARY KEY NOT NULL,
	"repository_id" text NOT NULL,
	"sha" text NOT NULL,
	"context" text NOT NULL,
	"state" text NOT NULL,
	"description" text,
	"target_url" text,
	"creator_user_id" text,
	"ci_run_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "git_deploy_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"repository_id" text NOT NULL,
	"title" text NOT NULL,
	"algorithm" text NOT NULL,
	"public_key" text NOT NULL,
	"fingerprint" text NOT NULL,
	"read_only" boolean DEFAULT true NOT NULL,
	"added_by_user_id" text,
	"last_used_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "git_issue_assignees" (
	"issue_id" text NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "git_issue_assignees_issue_id_user_id_pk" PRIMARY KEY("issue_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "git_issue_labels" (
	"issue_id" text NOT NULL,
	"label_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "git_issue_labels_issue_id_label_id_pk" PRIMARY KEY("issue_id","label_id")
);
--> statement-breakpoint
CREATE TABLE "git_issues" (
	"id" text PRIMARY KEY NOT NULL,
	"repository_id" text NOT NULL,
	"number" integer NOT NULL,
	"is_pull_request" boolean DEFAULT false NOT NULL,
	"title" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"body_edited_at" timestamp,
	"state" text DEFAULT 'open' NOT NULL,
	"state_reason" text,
	"author_user_id" text,
	"milestone_id" text,
	"locked" boolean DEFAULT false NOT NULL,
	"lock_reason" text,
	"comments_count" integer DEFAULT 0 NOT NULL,
	"closed_by_user_id" text,
	"closed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "git_labels" (
	"id" text PRIMARY KEY NOT NULL,
	"repository_id" text NOT NULL,
	"name" text NOT NULL,
	"name_lower" text NOT NULL,
	"color" text NOT NULL,
	"description" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "git_milestones" (
	"id" text PRIMARY KEY NOT NULL,
	"repository_id" text NOT NULL,
	"number" integer NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"state" text DEFAULT 'open' NOT NULL,
	"due_on" date,
	"open_count" integer DEFAULT 0 NOT NULL,
	"closed_count" integer DEFAULT 0 NOT NULL,
	"closed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "git_namespaces" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"slug_lower" text NOT NULL,
	"kind" text NOT NULL,
	"user_id" text,
	"organization_id" text,
	"display_name" text,
	"description" text,
	"avatar_url" text,
	"website_url" text,
	"location" text,
	"claimed_by_user_id" text,
	"renamed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "git_namespaces_owner_check" CHECK (("git_namespaces"."kind" = 'user' AND "git_namespaces"."user_id" IS NOT NULL AND "git_namespaces"."organization_id" IS NULL) OR ("git_namespaces"."kind" = 'org' AND "git_namespaces"."organization_id" IS NOT NULL AND "git_namespaces"."user_id" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "git_protected_branches" (
	"id" text PRIMARY KEY NOT NULL,
	"repository_id" text NOT NULL,
	"pattern" text NOT NULL,
	"require_pull_request" boolean DEFAULT false NOT NULL,
	"required_approvals" integer DEFAULT 0 NOT NULL,
	"dismiss_stale_approvals" boolean DEFAULT false NOT NULL,
	"required_status_contexts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"allow_force_push" boolean DEFAULT false NOT NULL,
	"allow_deletion" boolean DEFAULT false NOT NULL,
	"restrict_pushers" boolean DEFAULT false NOT NULL,
	"pusher_user_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"enforce_admins" boolean DEFAULT false NOT NULL,
	"created_by_user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "git_pull_requests" (
	"issue_id" text PRIMARY KEY NOT NULL,
	"repository_id" text NOT NULL,
	"base_ref" text NOT NULL,
	"head_repository_id" text,
	"head_ref" text NOT NULL,
	"head_oid" text NOT NULL,
	"base_oid" text NOT NULL,
	"merge_base_oid" text,
	"head_ref_exists" boolean DEFAULT true NOT NULL,
	"draft" boolean DEFAULT false NOT NULL,
	"mergeable_state" text DEFAULT 'unknown' NOT NULL,
	"mergeable_head_oid" text,
	"mergeable_base_oid" text,
	"conflict_files" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"commits_count" integer DEFAULT 0 NOT NULL,
	"additions" integer DEFAULT 0 NOT NULL,
	"deletions" integer DEFAULT 0 NOT NULL,
	"changed_files" integer DEFAULT 0 NOT NULL,
	"merged_at" timestamp,
	"merged_by_user_id" text,
	"merge_commit_oid" text,
	"merge_method" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "git_repositories" (
	"id" text PRIMARY KEY NOT NULL,
	"namespace_id" text NOT NULL,
	"name" text NOT NULL,
	"name_lower" text NOT NULL,
	"description" text,
	"homepage_url" text,
	"topics" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"visibility" text DEFAULT 'private' NOT NULL,
	"default_branch" text DEFAULT 'main' NOT NULL,
	"fork_of_id" text,
	"is_fork" boolean DEFAULT false NOT NULL,
	"archived" boolean DEFAULT false NOT NULL,
	"archived_at" timestamp,
	"is_empty" boolean DEFAULT true NOT NULL,
	"has_issues" boolean DEFAULT true NOT NULL,
	"has_pull_requests" boolean DEFAULT true NOT NULL,
	"allow_merge_commit" boolean DEFAULT true NOT NULL,
	"allow_squash" boolean DEFAULT true NOT NULL,
	"allow_rebase" boolean DEFAULT true NOT NULL,
	"default_merge_method" text DEFAULT 'merge' NOT NULL,
	"delete_branch_on_merge" boolean DEFAULT false NOT NULL,
	"primary_language" text,
	"size_bytes" bigint DEFAULT 0 NOT NULL,
	"pushed_at" timestamp,
	"stars_count" integer DEFAULT 0 NOT NULL,
	"forks_count" integer DEFAULT 0 NOT NULL,
	"open_issues_count" integer DEFAULT 0 NOT NULL,
	"open_pull_requests_count" integer DEFAULT 0 NOT NULL,
	"branches_count" integer DEFAULT 0 NOT NULL,
	"tags_count" integer DEFAULT 0 NOT NULL,
	"next_number" integer DEFAULT 1 NOT NULL,
	"next_milestone_number" integer DEFAULT 1 NOT NULL,
	"created_by_user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "git_review_comments" (
	"id" text PRIMARY KEY NOT NULL,
	"pull_request_id" text NOT NULL,
	"review_id" text NOT NULL,
	"repository_id" text NOT NULL,
	"author_user_id" text,
	"in_reply_to_id" text,
	"body" text NOT NULL,
	"path" text NOT NULL,
	"side" text DEFAULT 'RIGHT' NOT NULL,
	"line" integer,
	"start_line" integer,
	"start_side" text,
	"commit_oid" text NOT NULL,
	"original_commit_oid" text NOT NULL,
	"original_line" integer NOT NULL,
	"original_start_line" integer,
	"diff_hunk" text,
	"outdated" boolean DEFAULT false NOT NULL,
	"resolved_at" timestamp,
	"resolved_by_user_id" text,
	"edited_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "git_reviews" (
	"id" text PRIMARY KEY NOT NULL,
	"pull_request_id" text NOT NULL,
	"repository_id" text NOT NULL,
	"author_user_id" text,
	"state" text DEFAULT 'pending' NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"commit_oid" text NOT NULL,
	"submitted_at" timestamp,
	"dismissed_state" text,
	"dismissed_by_user_id" text,
	"dismissed_at" timestamp,
	"dismissal_reason" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "git_stars" (
	"user_id" text NOT NULL,
	"repository_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "git_stars_user_id_repository_id_pk" PRIMARY KEY("user_id","repository_id")
);
--> statement-breakpoint
CREATE TABLE "git_timeline_events" (
	"id" text PRIMARY KEY NOT NULL,
	"issue_id" text NOT NULL,
	"repository_id" text NOT NULL,
	"actor_user_id" text,
	"type" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "git_user_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"title" text NOT NULL,
	"algorithm" text NOT NULL,
	"public_key" text NOT NULL,
	"fingerprint" text NOT NULL,
	"last_used_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "git_users" (
	"user_id" text PRIMARY KEY NOT NULL,
	"suggested_slug" text,
	"onboarded_at" timestamp,
	"avatar_url" text,
	"last_seen_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "git_access_tokens" ADD CONSTRAINT "git_access_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_collaborators" ADD CONSTRAINT "git_collaborators_repository_id_git_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."git_repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_collaborators" ADD CONSTRAINT "git_collaborators_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_collaborators" ADD CONSTRAINT "git_collaborators_added_by_user_id_users_id_fk" FOREIGN KEY ("added_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_comments" ADD CONSTRAINT "git_comments_issue_id_git_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."git_issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_comments" ADD CONSTRAINT "git_comments_repository_id_git_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."git_repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_comments" ADD CONSTRAINT "git_comments_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_commit_statuses" ADD CONSTRAINT "git_commit_statuses_repository_id_git_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."git_repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_commit_statuses" ADD CONSTRAINT "git_commit_statuses_creator_user_id_users_id_fk" FOREIGN KEY ("creator_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_deploy_keys" ADD CONSTRAINT "git_deploy_keys_repository_id_git_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."git_repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_deploy_keys" ADD CONSTRAINT "git_deploy_keys_added_by_user_id_users_id_fk" FOREIGN KEY ("added_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_issue_assignees" ADD CONSTRAINT "git_issue_assignees_issue_id_git_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."git_issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_issue_assignees" ADD CONSTRAINT "git_issue_assignees_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_issue_labels" ADD CONSTRAINT "git_issue_labels_issue_id_git_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."git_issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_issue_labels" ADD CONSTRAINT "git_issue_labels_label_id_git_labels_id_fk" FOREIGN KEY ("label_id") REFERENCES "public"."git_labels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_issues" ADD CONSTRAINT "git_issues_repository_id_git_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."git_repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_issues" ADD CONSTRAINT "git_issues_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_issues" ADD CONSTRAINT "git_issues_milestone_id_git_milestones_id_fk" FOREIGN KEY ("milestone_id") REFERENCES "public"."git_milestones"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_issues" ADD CONSTRAINT "git_issues_closed_by_user_id_users_id_fk" FOREIGN KEY ("closed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_labels" ADD CONSTRAINT "git_labels_repository_id_git_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."git_repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_milestones" ADD CONSTRAINT "git_milestones_repository_id_git_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."git_repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_namespaces" ADD CONSTRAINT "git_namespaces_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_namespaces" ADD CONSTRAINT "git_namespaces_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_namespaces" ADD CONSTRAINT "git_namespaces_claimed_by_user_id_users_id_fk" FOREIGN KEY ("claimed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_protected_branches" ADD CONSTRAINT "git_protected_branches_repository_id_git_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."git_repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_protected_branches" ADD CONSTRAINT "git_protected_branches_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_pull_requests" ADD CONSTRAINT "git_pull_requests_issue_id_git_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."git_issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_pull_requests" ADD CONSTRAINT "git_pull_requests_repository_id_git_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."git_repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_pull_requests" ADD CONSTRAINT "git_pull_requests_head_repository_id_git_repositories_id_fk" FOREIGN KEY ("head_repository_id") REFERENCES "public"."git_repositories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_pull_requests" ADD CONSTRAINT "git_pull_requests_merged_by_user_id_users_id_fk" FOREIGN KEY ("merged_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_repositories" ADD CONSTRAINT "git_repositories_namespace_id_git_namespaces_id_fk" FOREIGN KEY ("namespace_id") REFERENCES "public"."git_namespaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_repositories" ADD CONSTRAINT "git_repositories_fork_of_id_git_repositories_id_fk" FOREIGN KEY ("fork_of_id") REFERENCES "public"."git_repositories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_repositories" ADD CONSTRAINT "git_repositories_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_review_comments" ADD CONSTRAINT "git_review_comments_pull_request_id_git_pull_requests_issue_id_fk" FOREIGN KEY ("pull_request_id") REFERENCES "public"."git_pull_requests"("issue_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_review_comments" ADD CONSTRAINT "git_review_comments_review_id_git_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."git_reviews"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_review_comments" ADD CONSTRAINT "git_review_comments_repository_id_git_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."git_repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_review_comments" ADD CONSTRAINT "git_review_comments_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_review_comments" ADD CONSTRAINT "git_review_comments_in_reply_to_id_git_review_comments_id_fk" FOREIGN KEY ("in_reply_to_id") REFERENCES "public"."git_review_comments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_review_comments" ADD CONSTRAINT "git_review_comments_resolved_by_user_id_users_id_fk" FOREIGN KEY ("resolved_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_reviews" ADD CONSTRAINT "git_reviews_pull_request_id_git_pull_requests_issue_id_fk" FOREIGN KEY ("pull_request_id") REFERENCES "public"."git_pull_requests"("issue_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_reviews" ADD CONSTRAINT "git_reviews_repository_id_git_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."git_repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_reviews" ADD CONSTRAINT "git_reviews_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_reviews" ADD CONSTRAINT "git_reviews_dismissed_by_user_id_users_id_fk" FOREIGN KEY ("dismissed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_stars" ADD CONSTRAINT "git_stars_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_stars" ADD CONSTRAINT "git_stars_repository_id_git_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."git_repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_timeline_events" ADD CONSTRAINT "git_timeline_events_issue_id_git_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."git_issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_timeline_events" ADD CONSTRAINT "git_timeline_events_repository_id_git_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."git_repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_timeline_events" ADD CONSTRAINT "git_timeline_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_user_keys" ADD CONSTRAINT "git_user_keys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_users" ADD CONSTRAINT "git_users_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "git_access_tokens_hash_idx" ON "git_access_tokens" USING btree ("hashed_token");--> statement-breakpoint
CREATE INDEX "git_access_tokens_user_idx" ON "git_access_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "git_collaborators_repo_user_idx" ON "git_collaborators" USING btree ("repository_id","user_id");--> statement-breakpoint
CREATE INDEX "git_collaborators_user_idx" ON "git_collaborators" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "git_comments_issue_idx" ON "git_comments" USING btree ("issue_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "git_commit_statuses_context_idx" ON "git_commit_statuses" USING btree ("repository_id","sha","context");--> statement-breakpoint
CREATE UNIQUE INDEX "git_deploy_keys_fingerprint_idx" ON "git_deploy_keys" USING btree ("fingerprint");--> statement-breakpoint
CREATE INDEX "git_deploy_keys_repo_idx" ON "git_deploy_keys" USING btree ("repository_id");--> statement-breakpoint
CREATE INDEX "git_issue_assignees_user_idx" ON "git_issue_assignees" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "git_issue_labels_label_idx" ON "git_issue_labels" USING btree ("label_id");--> statement-breakpoint
CREATE UNIQUE INDEX "git_issues_repo_number_idx" ON "git_issues" USING btree ("repository_id","number");--> statement-breakpoint
CREATE INDEX "git_issues_list_created_idx" ON "git_issues" USING btree ("repository_id","is_pull_request","state","created_at");--> statement-breakpoint
CREATE INDEX "git_issues_list_updated_idx" ON "git_issues" USING btree ("repository_id","is_pull_request","state","updated_at");--> statement-breakpoint
CREATE INDEX "git_issues_author_idx" ON "git_issues" USING btree ("author_user_id","created_at");--> statement-breakpoint
CREATE INDEX "git_issues_milestone_idx" ON "git_issues" USING btree ("milestone_id");--> statement-breakpoint
CREATE UNIQUE INDEX "git_labels_repo_name_idx" ON "git_labels" USING btree ("repository_id","name_lower");--> statement-breakpoint
CREATE UNIQUE INDEX "git_milestones_repo_number_idx" ON "git_milestones" USING btree ("repository_id","number");--> statement-breakpoint
CREATE INDEX "git_milestones_repo_state_idx" ON "git_milestones" USING btree ("repository_id","state","due_on");--> statement-breakpoint
CREATE UNIQUE INDEX "git_namespaces_slug_idx" ON "git_namespaces" USING btree ("slug_lower");--> statement-breakpoint
CREATE UNIQUE INDEX "git_namespaces_user_idx" ON "git_namespaces" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "git_namespaces_org_idx" ON "git_namespaces" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "git_protected_branches_repo_pattern_idx" ON "git_protected_branches" USING btree ("repository_id","pattern");--> statement-breakpoint
CREATE INDEX "git_pull_requests_head_idx" ON "git_pull_requests" USING btree ("head_repository_id","head_ref");--> statement-breakpoint
CREATE INDEX "git_pull_requests_base_idx" ON "git_pull_requests" USING btree ("repository_id","base_ref");--> statement-breakpoint
CREATE INDEX "git_pull_requests_merge_commit_idx" ON "git_pull_requests" USING btree ("repository_id","merge_commit_oid");--> statement-breakpoint
CREATE UNIQUE INDEX "git_repositories_name_idx" ON "git_repositories" USING btree ("namespace_id","name_lower");--> statement-breakpoint
CREATE INDEX "git_repositories_namespace_pushed_idx" ON "git_repositories" USING btree ("namespace_id","pushed_at");--> statement-breakpoint
CREATE INDEX "git_repositories_visibility_stars_idx" ON "git_repositories" USING btree ("visibility","stars_count");--> statement-breakpoint
CREATE INDEX "git_repositories_visibility_pushed_idx" ON "git_repositories" USING btree ("visibility","pushed_at");--> statement-breakpoint
CREATE INDEX "git_repositories_fork_of_idx" ON "git_repositories" USING btree ("fork_of_id");--> statement-breakpoint
CREATE INDEX "git_review_comments_pull_path_idx" ON "git_review_comments" USING btree ("pull_request_id","path");--> statement-breakpoint
CREATE INDEX "git_review_comments_review_idx" ON "git_review_comments" USING btree ("review_id");--> statement-breakpoint
CREATE INDEX "git_review_comments_reply_idx" ON "git_review_comments" USING btree ("in_reply_to_id");--> statement-breakpoint
CREATE INDEX "git_reviews_pull_idx" ON "git_reviews" USING btree ("pull_request_id","submitted_at");--> statement-breakpoint
CREATE UNIQUE INDEX "git_reviews_pending_idx" ON "git_reviews" USING btree ("pull_request_id","author_user_id") WHERE "git_reviews"."state" = 'pending';--> statement-breakpoint
CREATE INDEX "git_stars_user_idx" ON "git_stars" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "git_stars_repo_idx" ON "git_stars" USING btree ("repository_id","created_at");--> statement-breakpoint
CREATE INDEX "git_timeline_events_issue_idx" ON "git_timeline_events" USING btree ("issue_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "git_user_keys_fingerprint_idx" ON "git_user_keys" USING btree ("fingerprint");--> statement-breakpoint
CREATE INDEX "git_user_keys_user_idx" ON "git_user_keys" USING btree ("user_id");