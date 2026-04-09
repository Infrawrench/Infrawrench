ALTER TABLE "ssh_keys" RENAME COLUMN "created_by_user_id" TO "user_id";--> statement-breakpoint
ALTER TABLE "ssh_keys" DROP CONSTRAINT "ssh_keys_created_by_user_id_users_id_fk";
--> statement-breakpoint
DROP INDEX "ssh_keys_org_name_unique";--> statement-breakpoint
ALTER TABLE "ssh_keys" ADD COLUMN "encrypted_private_key" text;--> statement-breakpoint
ALTER TABLE "ssh_keys" ADD COLUMN "private_key_iv" text;--> statement-breakpoint
ALTER TABLE "ssh_keys" ADD CONSTRAINT "ssh_keys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ssh_keys_user_idx" ON "ssh_keys" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ssh_keys_user_name_unique" ON "ssh_keys" USING btree ("user_id","name");