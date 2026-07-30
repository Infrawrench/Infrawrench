CREATE TABLE "custom_graph_data" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"graph_id" text NOT NULL,
	"key" text NOT NULL,
	"value" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "custom_graphs" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"source" text DEFAULT '' NOT NULL,
	"created_by_user_id" text,
	"deleted_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "custom_graph_data" ADD CONSTRAINT "custom_graph_data_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_graph_data" ADD CONSTRAINT "custom_graph_data_graph_id_custom_graphs_id_fk" FOREIGN KEY ("graph_id") REFERENCES "public"."custom_graphs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_graphs" ADD CONSTRAINT "custom_graphs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "custom_graph_data_graph_key_unique" ON "custom_graph_data" USING btree ("graph_id","key");--> statement-breakpoint
CREATE INDEX "custom_graphs_org_idx" ON "custom_graphs" USING btree ("organization_id");