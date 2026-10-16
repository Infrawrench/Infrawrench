ALTER TABLE "cost_anomalies" ADD COLUMN "contributors" jsonb;--> statement-breakpoint
ALTER TABLE "cost_anomalies" ADD COLUMN "contributors_computed_at" timestamp;