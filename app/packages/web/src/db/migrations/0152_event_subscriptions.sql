CREATE TABLE "event_deliveries" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"subscription_id" text NOT NULL,
	"event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"idempotency_key" text,
	"payload" jsonb NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp,
	"last_attempt_at" timestamp,
	"delivered_at" timestamp,
	"response_status" integer,
	"response_excerpt" text,
	"error" text,
	"attempts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"is_test" boolean DEFAULT false NOT NULL,
	"redelivery_of" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "event_subscriptions" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"destination_kind" text NOT NULL,
	"url" text,
	"publish_account_id" text,
	"publish_resource_type_id" text,
	"publish_resource_id" text,
	"destination_label" text DEFAULT '' NOT NULL,
	"encrypted_secret" text,
	"secret_iv" text,
	"secret_hint" text,
	"previous_encrypted_secret" text,
	"previous_secret_iv" text,
	"previous_secret_expires_at" timestamp,
	"event_types" text[] DEFAULT '{}'::text[] NOT NULL,
	"min_severity" text,
	"account_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"environments" text[] DEFAULT '{}'::text[] NOT NULL,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"failing_since" timestamp,
	"last_success_at" timestamp,
	"last_failure_at" timestamp,
	"disabled_reason" text,
	"disabled_at" timestamp,
	"created_by_user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "event_deliveries" ADD CONSTRAINT "event_deliveries_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_deliveries" ADD CONSTRAINT "event_deliveries_subscription_id_event_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."event_subscriptions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_subscriptions" ADD CONSTRAINT "event_subscriptions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_subscriptions" ADD CONSTRAINT "event_subscriptions_publish_account_id_accounts_id_fk" FOREIGN KEY ("publish_account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_subscriptions" ADD CONSTRAINT "event_subscriptions_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "event_deliveries_idempotency_unique" ON "event_deliveries" USING btree ("subscription_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "event_deliveries_due_idx" ON "event_deliveries" USING btree ("next_attempt_at");--> statement-breakpoint
CREATE INDEX "event_deliveries_subscription_idx" ON "event_deliveries" USING btree ("subscription_id","created_at");--> statement-breakpoint
CREATE INDEX "event_deliveries_org_idx" ON "event_deliveries" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "event_subscriptions_org_idx" ON "event_subscriptions" USING btree ("organization_id");