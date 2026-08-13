CREATE TABLE "chat_pending_secret_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"conversation_id" text NOT NULL,
	"message_id" text NOT NULL,
	"tool_use_id" text NOT NULL,
	"secret_id" text,
	"name" text NOT NULL,
	"title" text,
	"description" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"resolved_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chat_pending_secret_requests" ADD CONSTRAINT "chat_pending_secret_requests_conversation_id_chat_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."chat_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_pending_secret_requests" ADD CONSTRAINT "chat_pending_secret_requests_message_id_chat_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."chat_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chat_pending_secret_requests_conversation_idx" ON "chat_pending_secret_requests" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "chat_pending_secret_requests_message_idx" ON "chat_pending_secret_requests" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "chat_pending_secret_requests_status_idx" ON "chat_pending_secret_requests" USING btree ("status");
