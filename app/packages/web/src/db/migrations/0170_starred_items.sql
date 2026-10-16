CREATE TABLE "starred_items" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"object_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "starred_items" ADD CONSTRAINT "starred_items_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "starred_items" ADD CONSTRAINT "starred_items_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "starred_items_member_object_unique" ON "starred_items" USING btree ("organization_id","user_id","kind","object_id");--> statement-breakpoint
CREATE INDEX "starred_items_member_idx" ON "starred_items" USING btree ("organization_id","user_id","created_at");