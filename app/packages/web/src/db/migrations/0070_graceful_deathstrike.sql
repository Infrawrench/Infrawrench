CREATE TABLE "capacity_slots" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"stripe_checkout_session_id" text NOT NULL,
	"stripe_payment_intent_id" text,
	"amount_paid_cents" integer,
	"term_months" integer NOT NULL,
	"starts_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "capacity_slots" ADD CONSTRAINT "capacity_slots_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "capacity_slots_session_unique" ON "capacity_slots" USING btree ("stripe_checkout_session_id");--> statement-breakpoint
CREATE INDEX "capacity_slots_org_idx" ON "capacity_slots" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "capacity_slots_payment_intent_idx" ON "capacity_slots" USING btree ("stripe_payment_intent_id");