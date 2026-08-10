CREATE TABLE "slack_approval_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"kind" text NOT NULL,
	"approval_id" text NOT NULL,
	"installation_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"message_ts" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "slack_user_links" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"team_id" text NOT NULL,
	"slack_user_id" text NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "slack_approval_messages" ADD CONSTRAINT "slack_approval_messages_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_approval_messages" ADD CONSTRAINT "slack_approval_messages_installation_id_slack_installations_id_fk" FOREIGN KEY ("installation_id") REFERENCES "public"."slack_installations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_user_links" ADD CONSTRAINT "slack_user_links_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_user_links" ADD CONSTRAINT "slack_user_links_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "slack_approval_messages_approval_idx" ON "slack_approval_messages" USING btree ("kind","approval_id");--> statement-breakpoint
CREATE INDEX "slack_approval_messages_org_idx" ON "slack_approval_messages" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "slack_user_links_org_team_slack_unique" ON "slack_user_links" USING btree ("organization_id","team_id","slack_user_id");--> statement-breakpoint
CREATE INDEX "slack_user_links_team_user_idx" ON "slack_user_links" USING btree ("team_id","slack_user_id");--> statement-breakpoint
CREATE INDEX "slack_user_links_org_idx" ON "slack_user_links" USING btree ("organization_id");