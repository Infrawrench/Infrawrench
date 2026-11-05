CREATE TABLE "revnu_checkout_handoffs" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"stripe_checkout_session_id" text NOT NULL,
	"created_by_user_id" text,
	"anonymous_id" text,
	"consent_state" text,
	"paid_at" timestamp,
	"report_payload" jsonb,
	"report_attempts" integer DEFAULT 0 NOT NULL,
	"next_report_at" timestamp,
	"reported_at" timestamp,
	"report_abandoned_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "revnu_checkout_handoffs" ADD CONSTRAINT "revnu_checkout_handoffs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "revnu_checkout_handoffs_session_unique" ON "revnu_checkout_handoffs" USING btree ("stripe_checkout_session_id");--> statement-breakpoint
CREATE INDEX "revnu_checkout_handoffs_org_anon_idx" ON "revnu_checkout_handoffs" USING btree ("organization_id","anonymous_id");--> statement-breakpoint
CREATE INDEX "revnu_checkout_handoffs_due_idx" ON "revnu_checkout_handoffs" USING btree ("next_report_at") WHERE report_payload IS NOT NULL;