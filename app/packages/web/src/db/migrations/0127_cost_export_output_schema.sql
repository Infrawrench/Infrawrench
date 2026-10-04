ALTER TABLE "report_notifications" ALTER COLUMN "cost_report_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "cost_exports" ADD COLUMN "output_schema" text DEFAULT 'native' NOT NULL;