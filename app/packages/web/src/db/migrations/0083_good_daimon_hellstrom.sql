CREATE TABLE "org_currency_settings" (
	"organization_id" text PRIMARY KEY NOT NULL,
	"display_currency" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "org_exchange_rates" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"from_currency" text NOT NULL,
	"to_currency" text NOT NULL,
	"rate" numeric(20, 10) NOT NULL,
	"effective_from" date NOT NULL,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "org_currency_settings" ADD CONSTRAINT "org_currency_settings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_exchange_rates" ADD CONSTRAINT "org_exchange_rates_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_exchange_rates" ADD CONSTRAINT "org_exchange_rates_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "org_exchange_rates_org_pair_day_unique" ON "org_exchange_rates" USING btree ("organization_id","from_currency","to_currency","effective_from");--> statement-breakpoint
CREATE INDEX "org_exchange_rates_org_idx" ON "org_exchange_rates" USING btree ("organization_id");