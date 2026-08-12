CREATE TABLE "change_cost_impact_annotations" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"subject_kind" text NOT NULL,
	"subject_id" text NOT NULL,
	"cost_annotation_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "change_cost_impact_annotations" ADD CONSTRAINT "change_cost_impact_annotations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_cost_impact_annotations" ADD CONSTRAINT "change_cost_impact_annotations_cost_annotation_id_cost_annotations_id_fk" FOREIGN KEY ("cost_annotation_id") REFERENCES "public"."cost_annotations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "change_cost_impact_annotations_subject_idx" ON "change_cost_impact_annotations" USING btree ("organization_id","subject_kind","subject_id");
