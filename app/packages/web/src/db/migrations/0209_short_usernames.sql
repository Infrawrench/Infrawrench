CREATE TABLE "git_username_holds" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"slug_lower" text NOT NULL,
	"user_id" text NOT NULL,
	"workspace_organization_id" text,
	"return_path" text NOT NULL,
	"stripe_checkout_session_id" text,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "git_username_purchases" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text,
	"slug" text NOT NULL,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"stripe_checkout_session_id" text NOT NULL,
	"stripe_payment_intent_id" text,
	"amount_paid_cents" integer,
	"currency" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "git_username_holds" ADD CONSTRAINT "git_username_holds_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_username_holds" ADD CONSTRAINT "git_username_holds_workspace_organization_id_organizations_id_fk" FOREIGN KEY ("workspace_organization_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_username_purchases" ADD CONSTRAINT "git_username_purchases_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "git_username_holds_slug_idx" ON "git_username_holds" USING btree ("slug_lower");--> statement-breakpoint
CREATE UNIQUE INDEX "git_username_holds_user_idx" ON "git_username_holds" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "git_username_purchases_session_idx" ON "git_username_purchases" USING btree ("stripe_checkout_session_id");--> statement-breakpoint
CREATE INDEX "git_username_purchases_user_idx" ON "git_username_purchases" USING btree ("user_id","created_at");