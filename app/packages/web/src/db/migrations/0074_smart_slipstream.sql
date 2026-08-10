CREATE TABLE "org_session_recording_settings" (
	"organization_id" text PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"capture_input" boolean DEFAULT false NOT NULL,
	"retention_days" integer DEFAULT 90 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ssh_session_recording_chunks" (
	"id" text PRIMARY KEY NOT NULL,
	"recording_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"seq" integer NOT NULL,
	"payload" text NOT NULL,
	"event_count" integer DEFAULT 0 NOT NULL,
	"byte_length" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ssh_session_recordings" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text,
	"user_name" text,
	"account_id" text,
	"resource_id" text,
	"host" text NOT NULL,
	"port" integer DEFAULT 22 NOT NULL,
	"username" text NOT NULL,
	"hop_count" integer DEFAULT 1 NOT NULL,
	"cols" integer DEFAULT 80 NOT NULL,
	"rows" integer DEFAULT 24 NOT NULL,
	"has_input" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'recording' NOT NULL,
	"output_bytes" integer DEFAULT 0 NOT NULL,
	"event_count" integer DEFAULT 0 NOT NULL,
	"chunk_count" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"ended_at" timestamp,
	"duration_ms" integer,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "org_session_recording_settings" ADD CONSTRAINT "org_session_recording_settings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ssh_session_recording_chunks" ADD CONSTRAINT "ssh_session_recording_chunks_recording_id_ssh_session_recordings_id_fk" FOREIGN KEY ("recording_id") REFERENCES "public"."ssh_session_recordings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ssh_session_recording_chunks" ADD CONSTRAINT "ssh_session_recording_chunks_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ssh_session_recordings" ADD CONSTRAINT "ssh_session_recordings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ssh_session_recordings" ADD CONSTRAINT "ssh_session_recordings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ssh_session_recording_chunks_recording_seq_unique" ON "ssh_session_recording_chunks" USING btree ("recording_id","seq");--> statement-breakpoint
CREATE INDEX "ssh_session_recording_chunks_org_idx" ON "ssh_session_recording_chunks" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "ssh_session_recordings_org_started_idx" ON "ssh_session_recordings" USING btree ("organization_id","started_at");--> statement-breakpoint
CREATE INDEX "ssh_session_recordings_org_user_idx" ON "ssh_session_recordings" USING btree ("organization_id","user_id");--> statement-breakpoint
CREATE INDEX "ssh_session_recordings_org_status_idx" ON "ssh_session_recordings" USING btree ("organization_id","status");