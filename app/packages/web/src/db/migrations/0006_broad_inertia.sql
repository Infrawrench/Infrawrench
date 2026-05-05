CREATE TABLE "ssh_tunnel_configs" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"ssh_host" text NOT NULL,
	"ssh_port" integer DEFAULT 22 NOT NULL,
	"ssh_user" text DEFAULT 'root' NOT NULL,
	"remote_host" text DEFAULT '127.0.0.1' NOT NULL,
	"remote_port" integer NOT NULL,
	"encrypted_private_key" text NOT NULL,
	"private_key_iv" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ssh_tunnel_configs" ADD CONSTRAINT "ssh_tunnel_configs_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ssh_tunnel_configs" ADD CONSTRAINT "ssh_tunnel_configs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ssh_tunnel_configs_account_unique" ON "ssh_tunnel_configs" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "ssh_tunnel_configs_org_idx" ON "ssh_tunnel_configs" USING btree ("organization_id");