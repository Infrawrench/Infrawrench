"use server";

import { desc, eq, and, gte, lte, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { auditLogs, users } from "@/db/schema";
import { requireAuth } from "@/auth/session";

export interface AuditLogEntry {
  id: string;
  userId: string | null;
  apiKeyId: string | null;
  action: string;
  entityType: string;
  entityId: string;
  metadata: unknown;
  ipAddress: string | null;
  createdAt: Date;
  userName: string | null;
  userEmail: string | null;
}

export interface AuditLogFilters {
  action?: string;
  entityType?: string;
  userId?: string;
  from?: string;
  to?: string;
}

export async function listAuditLogs(input: {
  page: number;
  pageSize: number;
  filters?: AuditLogFilters;
}): Promise<{ entries: AuditLogEntry[]; total: number }> {
  const session = await requireAuth();
  const { page, pageSize, filters } = input;

  const conditions = [eq(auditLogs.organizationId, session.organizationId)];

  if (filters?.action) {
    conditions.push(eq(auditLogs.action, filters.action));
  }
  if (filters?.entityType) {
    conditions.push(eq(auditLogs.entityType, filters.entityType));
  }
  if (filters?.userId) {
    conditions.push(eq(auditLogs.userId, filters.userId));
  }
  if (filters?.from) {
    conditions.push(gte(auditLogs.createdAt, new Date(filters.from)));
  }
  if (filters?.to) {
    conditions.push(lte(auditLogs.createdAt, new Date(filters.to)));
  }

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
    })
    .from(auditLogs)
    .leftJoin(users, eq(auditLogs.userId, users.id))
    .where(where)
    .orderBy(desc(auditLogs.createdAt))
    .limit(pageSize)
    .offset((page - 1) * pageSize);

  return { entries, total: countResult?.count ?? 0 };
}
