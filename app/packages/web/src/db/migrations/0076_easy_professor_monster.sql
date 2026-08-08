CREATE TABLE "account_credit_balances" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"account_id" text NOT NULL,
	"pot_key" text NOT NULL,
	"label" text NOT NULL,
	"remaining" double precision NOT NULL,
	"currency" text NOT NULL,
	"granted" double precision,
	"credit_expires_at" timestamp,
	"observed_at" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "account_credit_polls" (
	"account_id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"last_polled_at" timestamp,
	"next_poll_at" timestamp,
	"failure_count" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"last_error_help_label" text,
	"last_error_help_url" text
);
--> statement-breakpoint
CREATE TABLE "account_credit_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"account_id" text NOT NULL,
	"pot_key" text NOT NULL,
	"remaining" double precision NOT NULL,
	"currency" text NOT NULL,
	"observed_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "account_credit_balances" ADD CONSTRAINT "account_credit_balances_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_credit_balances" ADD CONSTRAINT "account_credit_balances_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_credit_polls" ADD CONSTRAINT "account_credit_polls_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_credit_polls" ADD CONSTRAINT "account_credit_polls_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_credit_snapshots" ADD CONSTRAINT "account_credit_snapshots_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_credit_snapshots" ADD CONSTRAINT "account_credit_snapshots_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "account_credit_balances_account_pot_unique" ON "account_credit_balances" USING btree ("account_id","pot_key");--> statement-breakpoint
CREATE INDEX "account_credit_balances_org_idx" ON "account_credit_balances" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "account_credit_polls_due_idx" ON "account_credit_polls" USING btree ("next_poll_at");--> statement-breakpoint
CREATE INDEX "account_credit_polls_org_idx" ON "account_credit_polls" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "account_credit_snapshots_account_pot_observed_idx" ON "account_credit_snapshots" USING btree ("account_id","pot_key","observed_at");--> statement-breakpoint
CREATE INDEX "account_credit_snapshots_org_observed_idx" ON "account_credit_snapshots" USING btree ("organization_id","observed_at");