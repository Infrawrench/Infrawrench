ALTER TABLE "cost_anomalies" ADD COLUMN "acknowledged_at" timestamp;--> statement-breakpoint
ALTER TABLE "cost_anomalies" ADD COLUMN "acknowledged_by_user_id" text;--> statement-breakpoint
ALTER TABLE "cost_anomalies" ADD COLUMN "explanation" text;--> statement-breakpoint
ALTER TABLE "cost_anomalies" ADD COLUMN "annotation_id" text;--> statement-breakpoint
ALTER TABLE "cost_anomalies" ADD CONSTRAINT "cost_anomalies_acknowledged_by_user_id_users_id_fk" FOREIGN KEY ("acknowledged_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_anomalies" ADD CONSTRAINT "cost_anomalies_annotation_id_cost_annotations_id_fk" FOREIGN KEY ("annotation_id") REFERENCES "public"."cost_annotations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cost_anomalies_annotation_unique" ON "cost_anomalies" USING btree ("annotation_id") WHERE annotation_id is not null;