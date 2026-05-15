CREATE TABLE "bastion_vms" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"created_by_user_id" text NOT NULL,
	"name" text NOT NULL,
	"hashed_token" text NOT NULL,
	"token_prefix" text NOT NULL,
	"agent_version" text,
	"last_seen_at" timestamp,
	"status" text DEFAULT 'pending' NOT NULL,
	"revoked_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "bastion_id" text;--> statement-breakpoint
ALTER TABLE "bastion_vms" ADD CONSTRAINT "bastion_vms_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bastion_vms" ADD CONSTRAINT "bastion_vms_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bastion_vms_hashed_token_unique" ON "bastion_vms" USING btree ("hashed_token");--> statement-breakpoint
CREATE INDEX "bastion_vms_org_idx" ON "bastion_vms" USING btree ("organization_id");--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_bastion_id_bastion_vms_id_fk" FOREIGN KEY ("bastion_id") REFERENCES "public"."bastion_vms"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "accounts_bastion_idx" ON "accounts" USING btree ("bastion_id");