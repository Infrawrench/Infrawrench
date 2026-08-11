import { v4 as uuid } from "uuid";
import { db } from "@/db/client";
import { auditLogs } from "@/db/schema";
import { currentAuditPrincipal } from "./audit-context";

interface AuditParams {
  organizationId: string;
  userId?: string | undefined;
  apiKeyId?: string | undefined;
  action: string;
  entityType: string;
  entityId: string;
  metadata?: Record<string, unknown> | undefined;
  ipAddress?: string | undefined;
}

/**
 * Log an audit event. Fire-and-forget — errors are logged but not thrown.
 *
 * `apiKeyId` falls back to the credential the current request authenticated
 * with (see `services/audit-context.ts`), so a write made through an `iwk_` key
 * names that key even though the call site only knows the acting user. An
 * explicit `apiKeyId` always wins.
 *
 * Returns whether the row was actually inserted. Almost every caller ignores it
 * and should: they record a change to Infrawrench's own database, so an audit
 * insert that fails failed alongside the thing it was describing. It exists for
 * the handful of callers that record an **irreversible side effect on somebody
 * else's system** — a revert's provider write is the first — where the mutation
 * outlives the failure and "we could not say who did this" is a fact worth
 * surfacing rather than swallowing.
 *
 * It is deliberately still a boolean rather than a throw: an audit failure must
 * never be the reason a mutation that already happened is reported as failed.
 */
export async function logAudit(params: AuditParams): Promise<boolean> {
  try {
    await db.insert(auditLogs).values({
      id: uuid(),
      organizationId: params.organizationId,
      userId: params.userId ?? null,
      apiKeyId: params.apiKeyId ?? currentAuditPrincipal()?.apiKeyId ?? null,
      action: params.action,
      entityType: params.entityType,
      entityId: params.entityId,
      metadata: params.metadata ?? null,
      ipAddress: params.ipAddress ?? null,
    });
    return true;
  } catch (e) {
    console.error("[audit] Failed to log event:", e);
    return false;
  }
}
