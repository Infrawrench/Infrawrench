CREATE TABLE "posture_dismissals" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"resource_id" text NOT NULL,
	"rule_id" text NOT NULL,
	"reason" text,
	"dismissed_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "posture_dismissals" ADD CONSTRAINT "posture_dismissals_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posture_dismissals" ADD CONSTRAINT "posture_dismissals_dismissed_by_users_id_fk" FOREIGN KEY ("dismissed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "posture_dismissals_org_idx" ON "posture_dismissals" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "posture_dismissals_finding_idx" ON "posture_dismissals" USING btree ("organization_id","resource_id","rule_id");