CREATE TABLE "replica_session_owners" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"owner_address" text NOT NULL,
	"claimed_at" timestamp DEFAULT now() NOT NULL,
	"heartbeat_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "replica_session_owners_heartbeat_idx" ON "replica_session_owners" USING btree ("heartbeat_at");--> statement-breakpoint
CREATE INDEX "replica_session_owners_owner_idx" ON "replica_session_owners" USING btree ("owner_address");
