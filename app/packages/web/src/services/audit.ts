import { v4 as uuid } from "uuid";
import { db } from "@/db/client";
import { auditLogs } from "@/db/schema";

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
 */
export async function logAudit(params: AuditParams): Promise<void> {
  try {
    await db.insert(auditLogs).values({
      id: uuid(),
      organizationId: params.organizationId,
      userId: params.userId ?? null,
      apiKeyId: params.apiKeyId ?? null,
      action: params.action,
      entityType: params.entityType,
      entityId: params.entityId,
      metadata: params.metadata ?? null,
      ipAddress: params.ipAddress ?? null,
    });
  } catch (e) {
    console.error("[audit] Failed to log event:", e);
  }
}
