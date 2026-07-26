CREATE TABLE "msteams_webhooks" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"label" text NOT NULL,
	"encrypted_url" text NOT NULL,
	"url_iv" text NOT NULL,
	"url_digest" text NOT NULL,
	"url_host" text NOT NULL,
	"url_hint" text NOT NULL,
	"sync_incidents" boolean DEFAULT true NOT NULL,
	"budget_alerts" boolean DEFAULT true NOT NULL,
	"workflow_pages" boolean DEFAULT true NOT NULL,
	"created_by_user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "msteams_webhooks" ADD CONSTRAINT "msteams_webhooks_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "msteams_webhooks_org_idx" ON "msteams_webhooks" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "msteams_webhooks_org_digest_unique" ON "msteams_webhooks" USING btree ("organization_id","url_digest");