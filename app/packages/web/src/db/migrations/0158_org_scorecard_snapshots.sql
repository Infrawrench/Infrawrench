CREATE TABLE "org_scorecard_snapshots" (
	"organization_id" text NOT NULL,
	"day" date NOT NULL,
	"score" integer NOT NULL,
	"grade" text NOT NULL,
	"pillars" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "org_scorecard_snapshots_organization_id_day_pk" PRIMARY KEY("organization_id","day")
);
--> statement-breakpoint
ALTER TABLE "org_scorecard_snapshots" ADD CONSTRAINT "org_scorecard_snapshots_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;