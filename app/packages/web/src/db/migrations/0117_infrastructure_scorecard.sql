CREATE TABLE "scorecard_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"day" text NOT NULL,
	"score" integer NOT NULL,
	"grade" text NOT NULL,
	"pillars" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "scorecard_snapshots_score_range" CHECK ("scorecard_snapshots"."score" BETWEEN 0 AND 100)
);
--> statement-breakpoint
ALTER TABLE "scorecard_snapshots" ADD CONSTRAINT "scorecard_snapshots_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "scorecard_snapshots_org_day_unique" ON "scorecard_snapshots" USING btree ("organization_id","day");--> statement-breakpoint
CREATE INDEX "scorecard_snapshots_org_day_idx" ON "scorecard_snapshots" USING btree ("organization_id","day");
