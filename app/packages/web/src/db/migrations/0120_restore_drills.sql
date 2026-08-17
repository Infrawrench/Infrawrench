CREATE TABLE "restore_drills" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"resource_id" text NOT NULL,
	"performed_at" timestamp NOT NULL,
	"outcome" text NOT NULL,
	"rto_minutes" integer,
	"restored_from" text,
	"notes" text,
	"performed_by_user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "restore_drills_outcome_known" CHECK ("restore_drills"."outcome" IN ('verified', 'restored-unverified', 'failed', 'blocked')),
	CONSTRAINT "restore_drills_rto_positive" CHECK ("restore_drills"."rto_minutes" IS NULL OR "restore_drills"."rto_minutes" >= 0),
	CONSTRAINT "restore_drills_blocked_has_no_rto" CHECK ("restore_drills"."outcome" <> 'blocked' OR "restore_drills"."rto_minutes" IS NULL)
);
--> statement-breakpoint
ALTER TABLE "restore_drills" ADD CONSTRAINT "restore_drills_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "restore_drills" ADD CONSTRAINT "restore_drills_performed_by_user_id_users_id_fk" FOREIGN KEY ("performed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "restore_drills_org_resource_idx" ON "restore_drills" USING btree ("organization_id","resource_id","performed_at");--> statement-breakpoint
CREATE INDEX "restore_drills_org_performed_idx" ON "restore_drills" USING btree ("organization_id","performed_at");
