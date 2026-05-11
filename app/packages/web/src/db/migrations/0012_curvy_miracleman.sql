CREATE TABLE "ssh_host_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"host" text NOT NULL,
	"port" integer NOT NULL,
	"fingerprint" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ssh_host_keys" ADD CONSTRAINT "ssh_host_keys_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ssh_host_keys_org_host_port_unique" ON "ssh_host_keys" USING btree ("organization_id","host","port");