CREATE TABLE "virtual_tags" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"default_value" text,
	"rules" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"processing_state" text DEFAULT 'pending' NOT NULL,
	"next_process_at" timestamp DEFAULT now(),
	"processed_at" timestamp,
	"processing_error" text,
	"stats" jsonb,
	"created_by_user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "virtual_tags" ADD CONSTRAINT "virtual_tags_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "virtual_tags" ADD CONSTRAINT "virtual_tags_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "virtual_tags_org_idx" ON "virtual_tags" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "virtual_tags_org_key_unique" ON "virtual_tags" USING btree ("organization_id","key");--> statement-breakpoint
CREATE INDEX "virtual_tags_next_process_idx" ON "virtual_tags" USING btree ("next_process_at");