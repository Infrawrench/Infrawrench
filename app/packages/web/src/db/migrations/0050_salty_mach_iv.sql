CREATE TABLE "change_freezes" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"reason" text,
	"starts_at" timestamp DEFAULT now() NOT NULL,
	"ends_at" timestamp,
	"active" boolean DEFAULT true NOT NULL,
	"created_by_user_id" text,
	"ended_by_user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "change_freezes" ADD CONSTRAINT "change_freezes_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_freezes" ADD CONSTRAINT "change_freezes_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_freezes" ADD CONSTRAINT "change_freezes_ended_by_user_id_users_id_fk" FOREIGN KEY ("ended_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "change_freezes_org_idx" ON "change_freezes" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "change_freezes_org_active_idx" ON "change_freezes" USING btree ("organization_id","active");