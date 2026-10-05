CREATE TABLE "fx_rate_feed_state" (
	"source" text PRIMARY KEY NOT NULL,
	"next_fetch_at" timestamp DEFAULT now() NOT NULL,
	"backfilled_at" timestamp,
	"last_success_at" timestamp,
	"last_attempt_at" timestamp,
	"last_error" text,
	"latest_rate_date" date,
	"earliest_rate_date" date,
	"currencies" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fx_reference_rates" (
	"source" text NOT NULL,
	"rate_date" date NOT NULL,
	"currency" text NOT NULL,
	"per_eur" numeric(20, 10) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "fx_reference_rates_source_rate_date_currency_pk" PRIMARY KEY("source","rate_date","currency")
);
--> statement-breakpoint
ALTER TABLE "org_currency_settings" ADD COLUMN "auto_rates" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "org_currency_settings" ADD COLUMN "rate_basis" text DEFAULT 'daily' NOT NULL;--> statement-breakpoint
ALTER TABLE "org_exchange_rates" ADD COLUMN "effective_to" date;--> statement-breakpoint
ALTER TABLE "org_currency_settings" ADD CONSTRAINT "org_currency_settings_rate_basis_check" CHECK ("org_currency_settings"."rate_basis" IN ('daily', 'month_end'));