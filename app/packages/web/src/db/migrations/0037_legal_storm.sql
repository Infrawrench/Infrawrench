ALTER TABLE "chat_conversations" DROP CONSTRAINT "chat_conversations_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "chat_conversations" ALTER COLUMN "user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_conversations" ADD CONSTRAINT "chat_conversations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;