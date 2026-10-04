ALTER TABLE "report_notifications" ALTER COLUMN "cost_report_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "report_notifications" ADD COLUMN "dashboard_id" text;--> statement-breakpoint
ALTER TABLE "report_notifications" ADD COLUMN "attach_pdf" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "report_notifications" ADD CONSTRAINT "report_notifications_dashboard_id_dashboards_id_fk" FOREIGN KEY ("dashboard_id") REFERENCES "public"."dashboards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "report_notifications_dashboard_idx" ON "report_notifications" USING btree ("dashboard_id");--> statement-breakpoint
ALTER TABLE "report_notifications" ADD CONSTRAINT "report_notifications_one_target" CHECK (num_nonnulls("report_notifications"."cost_report_id", "report_notifications"."dashboard_id") = 1);