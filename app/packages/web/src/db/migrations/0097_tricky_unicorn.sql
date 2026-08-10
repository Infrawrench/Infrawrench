CREATE TABLE "managed_accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"contact_name" text,
	"contact_email" text,
	"billing_address" text,
	"billing_currency" text NOT NULL,
	"cost_basis" text DEFAULT 'amortized' NOT NULL,
	"apply_billing_rules" boolean DEFAULT true NOT NULL,
	"notes" text,
	"cost_centre_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"account_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by_user_id" text,
	"deleted_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "managed_invoices" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"managed_account_id" text NOT NULL,
	"managed_account_name" text NOT NULL,
	"number" text,
	"status" text NOT NULL,
	"period_from" date NOT NULL,
	"period_to" date NOT NULL,
	"currency" text NOT NULL,
	"notes" text,
	"lines" jsonb,
	"totals" jsonb,
	"derivation" jsonb,
	"computed_at" timestamp,
	"issued_at" timestamp,
	"approved_by_user_id" text,
	"sent_at" timestamp,
	"sent_by_user_id" text,
	"voided_at" timestamp,
	"voided_by_user_id" text,
	"void_reason" text,
	"supersedes_invoice_id" text,
	"superseded_by_invoice_id" text,
	"created_by_user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "managed_accounts" ADD CONSTRAINT "managed_accounts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_accounts" ADD CONSTRAINT "managed_accounts_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_invoices" ADD CONSTRAINT "managed_invoices_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_invoices" ADD CONSTRAINT "managed_invoices_managed_account_id_managed_accounts_id_fk" FOREIGN KEY ("managed_account_id") REFERENCES "public"."managed_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_invoices" ADD CONSTRAINT "managed_invoices_approved_by_user_id_users_id_fk" FOREIGN KEY ("approved_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_invoices" ADD CONSTRAINT "managed_invoices_sent_by_user_id_users_id_fk" FOREIGN KEY ("sent_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_invoices" ADD CONSTRAINT "managed_invoices_voided_by_user_id_users_id_fk" FOREIGN KEY ("voided_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_invoices" ADD CONSTRAINT "managed_invoices_supersedes_invoice_id_managed_invoices_id_fk" FOREIGN KEY ("supersedes_invoice_id") REFERENCES "public"."managed_invoices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_invoices" ADD CONSTRAINT "managed_invoices_superseded_by_invoice_id_managed_invoices_id_fk" FOREIGN KEY ("superseded_by_invoice_id") REFERENCES "public"."managed_invoices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_invoices" ADD CONSTRAINT "managed_invoices_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "managed_accounts_org_idx" ON "managed_accounts" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "managed_accounts_org_name_unique" ON "managed_accounts" USING btree ("organization_id","name") WHERE deleted_at is null;--> statement-breakpoint
CREATE INDEX "managed_invoices_org_idx" ON "managed_invoices" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "managed_invoices_account_idx" ON "managed_invoices" USING btree ("managed_account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "managed_invoices_org_number_unique" ON "managed_invoices" USING btree ("organization_id","number") WHERE number is not null;