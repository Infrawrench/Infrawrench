/**
 * Audit log: `/api/org/:orgId/audit-logs`, the handler.
 */
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { desc, eq, and, gte, lte, sql } from "drizzle-orm";
import { db } from "../../../db/client";
import { apiKeys, auditLogs, users } from "../../../db/schema";
import { makeDomain } from "../../domain";
import { legacy } from "../../legacy";
import { OrgPrincipal } from "../../principal";
import { respond } from "../../response";
import { AuditApi, AuditResponse } from "./api";

interface AuditFilters {
  readonly page?: string | undefined;
  readonly pageSize?: string | undefined;
  readonly action?: string | undefined;
  readonly entityType?: string | undefined;
  readonly userId?: string | undefined;
  readonly apiKeyId?: string | undefined;
  readonly from?: string | undefined;
  readonly to?: string | undefined;
}

async function listAuditEntries(organizationId: string, query: AuditFilters) {
  const page = parseInt(query.page ?? "1", 10);
  const pageSize = parseInt(query.pageSize ?? "25", 10);
  const { action, entityType, userId, from, to } = query;
  // "Which key did this?": the question an operator asks after a credential
  // leaks. Filtering by owner is not a substitute: a person and every key they
  // minted share a `userId`.
  const apiKeyId = query.apiKeyId;

  const conditions = [eq(auditLogs.organizationId, organizationId)];
  if (action) conditions.push(eq(auditLogs.action, action));
  if (entityType) conditions.push(eq(auditLogs.entityType, entityType));
  if (userId) conditions.push(eq(auditLogs.userId, userId));
  if (apiKeyId) conditions.push(eq(auditLogs.apiKeyId, apiKeyId));
  if (from) conditions.push(gte(auditLogs.createdAt, new Date(from)));
  if (to) conditions.push(lte(auditLogs.createdAt, new Date(to)));

  const where = and(...conditions);

  const [countResult] = await db
    .select({ count: sql<number>`count(*)` })
    .from(auditLogs)
    .where(where);

  const entries = await db
    .select({
      id: auditLogs.id,
      userId: auditLogs.userId,
      apiKeyId: auditLogs.apiKeyId,
      action: auditLogs.action,
      entityType: auditLogs.entityType,
      entityId: auditLogs.entityId,
      metadata: auditLogs.metadata,
      ipAddress: auditLogs.ipAddress,
      createdAt: auditLogs.createdAt,
      userName: users.displayName,
      userEmail: users.email,
      // A key id alone answers "which key" only if you can still look it up;
      // a revoked key is gone from the UI long before the audit row ages out.
      // Carry the name and prefix so the entry stays readable on its own.
      apiKeyName: apiKeys.name,
      apiKeyPrefix: apiKeys.prefix,
    })
    .from(auditLogs)
    .leftJoin(users, eq(auditLogs.userId, users.id))
    .leftJoin(apiKeys, eq(auditLogs.apiKeyId, apiKeys.id))
    .where(where)
    .orderBy(desc(auditLogs.createdAt))
    .limit(pageSize)
    .offset((page - 1) * pageSize);

  return { entries, total: countResult?.count ?? 0 };
}

const AuditHandlers = HttpApiBuilder.group(AuditApi, "audit", (handlers) =>
  handlers.handle("list", ({ query }) =>
    Effect.gen(function* () {
      const { organizationId } = yield* OrgPrincipal;
      const result = yield* legacy(() => listAuditEntries(organizationId, query));
      return yield* respond(AuditResponse)(result);
    }),
  ),
);

export const auditDomain = makeDomain("audit", AuditApi, AuditHandlers);
