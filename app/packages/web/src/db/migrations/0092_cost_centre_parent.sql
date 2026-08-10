ALTER TABLE "cost_centres" ADD COLUMN "parent_id" text;--> statement-breakpoint
ALTER TABLE "cost_centres" ADD CONSTRAINT "cost_centres_parent_id_cost_centres_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."cost_centres"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cost_centres_parent_idx" ON "cost_centres" USING btree ("parent_id");
