CREATE TABLE "leaked_secret_scans" (
	"account_id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"next_scan_at" timestamp DEFAULT now() NOT NULL,
	"last_scanned_at" timestamp,
	"last_error" text,
	"last_count" integer,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "leaked_secrets" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"scanner_account_id" text NOT NULL,
	"scanner_plugin_id" text NOT NULL,
	"external_ref" text NOT NULL,
	"token_type" text NOT NULL,
	"token_type_label" text,
	"owner_plugin_id" text,
	"token_format_id" text,
	"fingerprint" text,
	"secret_hint" text,
	"repository" text,
	"path" text,
	"line" integer,
	"commit_sha" text,
	"upstream_url" text,
	"upstream_state" text DEFAULT 'open' NOT NULL,
	"upstream_resolution" text,
	"validity" text,
	"publicly_leaked" boolean DEFAULT false NOT NULL,
	"detected_at" timestamp NOT NULL,
	"first_seen_at" timestamp DEFAULT now() NOT NULL,
	"last_seen_at" timestamp DEFAULT now() NOT NULL,
	"match_kind" text DEFAULT 'none' NOT NULL,
	"match_confidence" text DEFAULT 'none' NOT NULL,
	"matched_account_id" text,
	"matched_plugin_id" text,
	"matched_resource_id" text,
	"matched_resource_type_id" text,
	"matched_field_key" text,
	"candidate_account_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"rotated_at" timestamp,
	"rotated_by_user_id" text,
	"rotation_method" text,
	"dismissed_reason" text,
	"dismissed_comment" text,
	"dismissed_at" timestamp,
	"dismissed_by_user_id" text,
	"upstream_resolved_at" timestamp,
	"upstream_resolve_error" text,
	"notified_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "leaked_secret_scans" ADD CONSTRAINT "leaked_secret_scans_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leaked_secret_scans" ADD CONSTRAINT "leaked_secret_scans_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leaked_secrets" ADD CONSTRAINT "leaked_secrets_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leaked_secrets" ADD CONSTRAINT "leaked_secrets_scanner_account_id_accounts_id_fk" FOREIGN KEY ("scanner_account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leaked_secrets" ADD CONSTRAINT "leaked_secrets_matched_account_id_accounts_id_fk" FOREIGN KEY ("matched_account_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leaked_secrets" ADD CONSTRAINT "leaked_secrets_rotated_by_user_id_users_id_fk" FOREIGN KEY ("rotated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leaked_secrets" ADD CONSTRAINT "leaked_secrets_dismissed_by_user_id_users_id_fk" FOREIGN KEY ("dismissed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "leaked_secret_scans_due_idx" ON "leaked_secret_scans" USING btree ("next_scan_at");--> statement-breakpoint
CREATE UNIQUE INDEX "leaked_secrets_finding_unique" ON "leaked_secrets" USING btree ("scanner_account_id","external_ref");--> statement-breakpoint
CREATE INDEX "leaked_secrets_org_status_idx" ON "leaked_secrets" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "leaked_secrets_matched_account_idx" ON "leaked_secrets" USING btree ("matched_account_id");