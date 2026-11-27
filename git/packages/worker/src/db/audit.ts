/**
 * The app's audit log, for the few things done on the forge that the app
 * records when they are done there. One row in `audit_logs`, in the shape of
 * the app's `logAudit` (web `services/audit.ts`), which the Worker cannot
 * import: an organisation's audit page reads these rows whoever wrote them, so
 * the action and entity names are the app's.
 */
import { auditLogs } from "@infrawrench/server-core/db/schema";
import { db, newId } from "./client";

export interface AuditEntry {
  readonly organizationId: string;
  readonly userId: string;
  readonly action: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly metadata: Record<string, unknown>;
}

/** Rejects when the row cannot be written: pass it to `cx.background`, which logs that. */
export const recordAudit = async (entry: AuditEntry): Promise<void> => {
  await db.insert(auditLogs).values({ id: newId(), ...entry });
};
