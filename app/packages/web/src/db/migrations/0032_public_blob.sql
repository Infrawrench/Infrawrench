CREATE TABLE "slack_channels" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"installation_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"channel_name" text NOT NULL,
	"is_private" boolean DEFAULT false NOT NULL,
	"sync_incidents" boolean DEFAULT true NOT NULL,
	"budget_alerts" boolean DEFAULT true NOT NULL,
	"workflow_pages" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "slack_installations" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"team_id" text NOT NULL,
	"team_name" text,
	"bot_user_id" text,
	"scopes" text,
	"encrypted_bot_token" text NOT NULL,
	"bot_token_iv" text NOT NULL,
	"installed_by_user_id" text,
	"deleted_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "slack_channels" ADD CONSTRAINT "slack_channels_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_channels" ADD CONSTRAINT "slack_channels_installation_id_slack_installations_id_fk" FOREIGN KEY ("installation_id") REFERENCES "public"."slack_installations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_installations" ADD CONSTRAINT "slack_installations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "slack_channels_org_idx" ON "slack_channels" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "slack_channels_install_channel_unique" ON "slack_channels" USING btree ("installation_id","channel_id");--> statement-breakpoint
CREATE INDEX "slack_installations_org_idx" ON "slack_installations" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "slack_installations_org_team_unique" ON "slack_installations" USING btree ("organization_id","team_id");