import { eq, sql } from "drizzle-orm";
import { db } from "@infrawrench/server-core/db/client";
import { accounts } from "@infrawrench/server-core/db/schema";
import { markAccountRequiresGateway } from "@infrawrench/server-core/runtime/account-runtime";
import type { PollAccountRow } from "./poll-account";

export type PollKind = "resources" | "costs" | "credits" | "commitments" | "quotas";

/** The lease table for the passes whose schedule lives off `accounts`. */
const LEASE_TABLES = {
  credits: "account_credit_polls",
  commitments: "account_commitment_polls",
  quotas: "account_quota_polls",
} as const;

/**
 * The edge poller reached a Node-only code path for this account (its driver
 * is a gateway-only stub there). Flag the account so the edge stops claiming
 * it, and make the interrupted pass due immediately so the gateway poller
 * redoes it on its next tick. Deliberately not a failure: no backoff, no
 * error shown on the account, no page.
 */
export async function handOffToGateway(
  account: PollAccountRow,
  kind: PollKind,
  err: unknown,
): Promise<void> {
  const reason = err instanceof Error ? err.message : String(err);
  console.log(
    `[poller] ${account.id} (${account.pluginId}) moves to the gateway (${kind}): ${reason}`,
  );
  // Also clears `next_poll_at`, so the resource poll is due at once.
  await markAccountRequiresGateway(account.id, reason);
  if (kind === "costs") {
    await db.update(accounts).set({ costNextPollAt: null }).where(eq(accounts.id, account.id));
  } else if (kind !== "resources") {
    await db.execute(
      sql`UPDATE ${sql.raw(LEASE_TABLES[kind])} SET next_poll_at = now() WHERE account_id = ${account.id}`,
    );
  }
}
