/**
 * Ephemeral environments — row access and wire assembly for templates,
 * instances and the org's TTL rails.
 *
 * Every judgement about *what* a template means lives in
 * `@infrawrench/client-core` (`environments.ts`) and is shared with the editor
 * UIs; this module only reads and writes rows, so the server and the form
 * cannot disagree about what a valid template is.
 */
import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  ENVIRONMENT_LIMITS,
  normalizeEnvironmentSettings,
  validateTemplate,
  type EnvironmentInstance,
  type EnvironmentInstanceListResponse,
  type EnvironmentInstanceMember,
  type EnvironmentInstanceStatus,
  type EnvironmentMemberStatus,
  type EnvironmentSettings,
  type EnvironmentTemplate,
  type EnvironmentTemplateInput,
  type EnvironmentTemplateListResponse,
  type EnvironmentTemplateMember,
  type MemberFailureRecord,
} from "@infrawrench/client-core";
import { db } from "../db/client";
import {
  environmentInstanceMembers,
  environmentInstances,
  environmentSettings,
  environmentTemplates,
} from "../db/schema";

/** Thrown for caller mistakes the API maps to 400/403/404/409/423. */
export class EnvironmentInputError extends Error {
  constructor(
    message: string,
    public readonly status: 400 | 403 | 404 | 409 | 423 = 400,
  ) {
    super(message);
    this.name = "EnvironmentInputError";
  }
}

/** Postgres unique-index conflict (23505), possibly wrapped by the ORM. */
function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  while (current instanceof Error) {
    if ((current as { code?: unknown }).code === "23505") return true;
    current = current.cause;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/**
 * The org's TTL rails. Absent until someone changes them — a missing row
 * normalizes into the shipped defaults rather than being seeded, so a new org
 * has working guardrails without a migration having to invent them.
 */
export async function getEnvironmentSettings(organizationId: string): Promise<EnvironmentSettings> {
  const [row] = await db
    .select()
    .from(environmentSettings)
    .where(eq(environmentSettings.organizationId, organizationId))
    .limit(1);
  return normalizeEnvironmentSettings(row ?? null);
}

export async function setEnvironmentSettings(
  organizationId: string,
  input: Partial<EnvironmentSettings>,
  updatedByUserId?: string,
): Promise<EnvironmentSettings> {
  const settings = normalizeEnvironmentSettings(input);
  await db
    .insert(environmentSettings)
    .values({
      organizationId,
      maxTtlHours: settings.maxTtlHours,
      defaultTtlHours: settings.defaultTtlHours,
      updatedByUserId: updatedByUserId ?? null,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: environmentSettings.organizationId,
      set: {
        maxTtlHours: settings.maxTtlHours,
        defaultTtlHours: settings.defaultTtlHours,
        updatedByUserId: updatedByUserId ?? null,
        updatedAt: new Date(),
      },
    });
  return settings;
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

interface TemplateRow {
  id: string;
  organizationId: string;
  name: string;
  description: string | null;
  parameters: EnvironmentTemplate["parameters"];
  members: EnvironmentTemplateMember[];
  createdAt: Date;
  updatedAt: Date;
}

function templateToWire(row: TemplateRow, activeInstanceCount: number): EnvironmentTemplate {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    parameters: row.parameters ?? [],
    members: row.members ?? [],
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    activeInstanceCount,
  };
}

const LIVE_STATUSES: EnvironmentInstanceStatus[] = [
  "creating",
  "active",
  "partial",
  "tearing-down",
];

async function liveInstanceCounts(
  organizationId: string,
  templateIds: string[],
): Promise<Map<string, number>> {
  if (templateIds.length === 0) return new Map();
  const rows = await db
    .select({ templateId: environmentInstances.templateId })
    .from(environmentInstances)
    .where(
      and(
        eq(environmentInstances.organizationId, organizationId),
        inArray(environmentInstances.templateId, templateIds),
        inArray(environmentInstances.status, LIVE_STATUSES),
      ),
    );
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (!row.templateId) continue;
    counts.set(row.templateId, (counts.get(row.templateId) ?? 0) + 1);
  }
  return counts;
}

export async function listEnvironmentTemplates(
  organizationId: string,
): Promise<EnvironmentTemplateListResponse> {
  const rows = (await db
    .select()
    .from(environmentTemplates)
    .where(eq(environmentTemplates.organizationId, organizationId))
    .orderBy(environmentTemplates.name)) as TemplateRow[];
  const counts = await liveInstanceCounts(
    organizationId,
    rows.map((r) => r.id),
  );
  return { templates: rows.map((row) => templateToWire(row, counts.get(row.id) ?? 0)) };
}

export async function getEnvironmentTemplate(
  organizationId: string,
  templateId: string,
): Promise<EnvironmentTemplate | null> {
  const [row] = (await db
    .select()
    .from(environmentTemplates)
    .where(
      and(
        eq(environmentTemplates.organizationId, organizationId),
        eq(environmentTemplates.id, templateId),
      ),
    )
    .limit(1)) as TemplateRow[];
  if (!row) return null;
  const counts = await liveInstanceCounts(organizationId, [row.id]);
  return templateToWire(row, counts.get(row.id) ?? 0);
}

export async function createEnvironmentTemplateRecord(
  organizationId: string,
  input: EnvironmentTemplateInput,
  createdByUserId?: string,
): Promise<EnvironmentTemplate> {
  const problem = validateTemplate(input);
  if (problem) throw new EnvironmentInputError(problem);

  const now = new Date();
  const id = randomUUID();
  try {
    await db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${`environment_templates:${organizationId}`}))`,
      );
      const existing = await tx
        .select({ id: environmentTemplates.id })
        .from(environmentTemplates)
        .where(eq(environmentTemplates.organizationId, organizationId));
      if (existing.length >= ENVIRONMENT_LIMITS.maxTemplatesPerOrg) {
        throw new EnvironmentInputError(
          `Organizations are limited to ${ENVIRONMENT_LIMITS.maxTemplatesPerOrg} environment templates`,
        );
      }
      await tx.insert(environmentTemplates).values({
        id,
        organizationId,
        name: input.name.trim(),
        description: input.description?.trim() || null,
        parameters: input.parameters,
        members: input.members,
        createdByUserId: createdByUserId ?? null,
        createdAt: now,
        updatedAt: now,
      });
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new EnvironmentInputError("A template with that name already exists", 409);
    }
    throw error;
  }
  return (await getEnvironmentTemplate(organizationId, id))!;
}

export async function updateEnvironmentTemplateRecord(
  organizationId: string,
  templateId: string,
  input: EnvironmentTemplateInput,
): Promise<EnvironmentTemplate> {
  const problem = validateTemplate(input);
  if (problem) throw new EnvironmentInputError(problem);
  const existing = await getEnvironmentTemplate(organizationId, templateId);
  if (!existing) throw new EnvironmentInputError("Template not found", 404);

  try {
    await db
      .update(environmentTemplates)
      .set({
        name: input.name.trim(),
        description: input.description?.trim() || null,
        parameters: input.parameters,
        members: input.members,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(environmentTemplates.organizationId, organizationId),
          eq(environmentTemplates.id, templateId),
        ),
      );
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new EnvironmentInputError("A template with that name already exists", 409);
    }
    throw error;
  }
  return (await getEnvironmentTemplate(organizationId, templateId))!;
}

/**
 * Delete a template. Live instances are deliberately **not** blocked and not
 * torn down — they own real resources with their own TTL, and the template is
 * only where they came from. `environment_instances.template_id` is set null
 * by the FK; the denormalized `template_name` is what the surface reads.
 */
export async function deleteEnvironmentTemplateRecord(
  organizationId: string,
  templateId: string,
): Promise<EnvironmentTemplate> {
  const existing = await getEnvironmentTemplate(organizationId, templateId);
  if (!existing) throw new EnvironmentInputError("Template not found", 404);
  await db
    .delete(environmentTemplates)
    .where(
      and(
        eq(environmentTemplates.organizationId, organizationId),
        eq(environmentTemplates.id, templateId),
      ),
    );
  return existing;
}

// ---------------------------------------------------------------------------
// Instances
// ---------------------------------------------------------------------------

export interface InstanceRow {
  id: string;
  organizationId: string;
  templateId: string | null;
  templateName: string;
  name: string;
  namePrefix: string;
  parameters: Record<string, string>;
  status: EnvironmentInstanceStatus;
  expiresAt: Date;
  note: string | null;
  error: string | null;
  createdByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
}

export interface InstanceMemberRow {
  id: string;
  instanceId: string;
  organizationId: string;
  memberKey: string;
  pluginId: string;
  resourceTypeId: string;
  accountId: string;
  resourceId: string | null;
  externalId: string | null;
  displayName: string;
  status: EnvironmentMemberStatus;
  error: string | null;
  leaseId: string | null;
  position: number;
}

function memberToWire(row: InstanceMemberRow): EnvironmentInstanceMember {
  return {
    id: row.id,
    memberKey: row.memberKey,
    pluginId: row.pluginId,
    resourceTypeId: row.resourceTypeId,
    accountId: row.accountId,
    resourceId: row.resourceId,
    externalId: row.externalId,
    displayName: row.displayName,
    status: row.status,
    error: row.error,
    leaseId: row.leaseId,
    position: row.position,
  };
}

function instanceToWire(row: InstanceRow, members: InstanceMemberRow[]): EnvironmentInstance {
  return {
    id: row.id,
    templateId: row.templateId,
    templateName: row.templateName,
    name: row.name,
    namePrefix: row.namePrefix,
    parameters: row.parameters ?? {},
    status: row.status,
    expiresAt: row.expiresAt.toISOString(),
    error: row.error,
    members: members.sort((a, b) => a.position - b.position).map(memberToWire),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
  };
}

export async function getInstanceRow(
  organizationId: string,
  instanceId: string,
): Promise<InstanceRow | null> {
  const [row] = (await db
    .select()
    .from(environmentInstances)
    .where(
      and(
        eq(environmentInstances.organizationId, organizationId),
        eq(environmentInstances.id, instanceId),
      ),
    )
    .limit(1)) as InstanceRow[];
  return row ?? null;
}

export async function getInstanceMemberRows(instanceId: string): Promise<InstanceMemberRow[]> {
  return (await db
    .select()
    .from(environmentInstanceMembers)
    .where(eq(environmentInstanceMembers.instanceId, instanceId))
    .orderBy(environmentInstanceMembers.position)) as InstanceMemberRow[];
}

export async function listEnvironmentInstances(
  organizationId: string,
): Promise<EnvironmentInstanceListResponse> {
  const rows = (await db
    .select()
    .from(environmentInstances)
    .where(eq(environmentInstances.organizationId, organizationId))
    .orderBy(desc(environmentInstances.createdAt))) as InstanceRow[];
  if (rows.length === 0) return { instances: [] };
  const memberRows = (await db
    .select()
    .from(environmentInstanceMembers)
    .where(
      inArray(
        environmentInstanceMembers.instanceId,
        rows.map((r) => r.id),
      ),
    )) as InstanceMemberRow[];
  const byInstance = new Map<string, InstanceMemberRow[]>();
  for (const member of memberRows) {
    const list = byInstance.get(member.instanceId);
    if (list) list.push(member);
    else byInstance.set(member.instanceId, [member]);
  }
  return { instances: rows.map((row) => instanceToWire(row, byInstance.get(row.id) ?? [])) };
}

export async function getEnvironmentInstance(
  organizationId: string,
  instanceId: string,
): Promise<EnvironmentInstance | null> {
  const row = await getInstanceRow(organizationId, instanceId);
  if (!row) return null;
  return instanceToWire(row, await getInstanceMemberRows(row.id));
}

/** How many instances still own cloud resources — the per-org spend rail. */
export async function countLiveInstances(organizationId: string): Promise<number> {
  const rows = await db
    .select({ id: environmentInstances.id })
    .from(environmentInstances)
    .where(
      and(
        eq(environmentInstances.organizationId, organizationId),
        inArray(environmentInstances.status, LIVE_STATUSES),
      ),
    );
  return rows.length;
}

export interface InsertInstanceInput {
  organizationId: string;
  templateId: string;
  templateName: string;
  name: string;
  namePrefix: string;
  parameters: Record<string, string>;
  expiresAt: Date;
  note?: string | null;
  createdByUserId?: string | undefined;
  members: {
    memberKey: string;
    pluginId: string;
    resourceTypeId: string;
    accountId: string;
    displayName: string;
  }[];
}

/**
 * Write the instance and **every** member row up front, all `pending`, in one
 * transaction — before a single provider call goes out.
 *
 * This is the ordering the whole feature rests on. If the plan is recorded
 * first, then a create that succeeds and a process that dies immediately
 * afterwards still leaves a row naming the member, its account and its
 * position, which is enough to find and tear down. Recording afterwards would
 * make the window "the entire run".
 */
export async function insertInstanceWithMembers(input: InsertInstanceInput): Promise<InstanceRow> {
  const now = new Date();
  const instanceId = randomUUID();
  await db.transaction(async (tx) => {
    await tx.insert(environmentInstances).values({
      id: instanceId,
      organizationId: input.organizationId,
      templateId: input.templateId,
      templateName: input.templateName,
      name: input.name,
      namePrefix: input.namePrefix,
      parameters: input.parameters,
      status: "creating",
      expiresAt: input.expiresAt,
      note: input.note ?? null,
      error: null,
      createdByUserId: input.createdByUserId ?? null,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    });
    if (input.members.length > 0) {
      await tx.insert(environmentInstanceMembers).values(
        input.members.map((member, index) => ({
          id: randomUUID(),
          instanceId,
          organizationId: input.organizationId,
          memberKey: member.memberKey,
          pluginId: member.pluginId,
          resourceTypeId: member.resourceTypeId,
          accountId: member.accountId,
          resourceId: null,
          externalId: null,
          displayName: member.displayName,
          status: "pending" as const,
          error: null,
          leaseId: null,
          position: index,
          createdAt: now,
          updatedAt: now,
        })),
      );
    }
  });
  return (await getInstanceRow(input.organizationId, instanceId))!;
}

/** Record a member as created. Called immediately after the plugin returns. */
export async function markMemberCreated(
  instanceId: string,
  memberKey: string,
  created: { resourceId: string; externalId: string | null; displayName: string },
): Promise<void> {
  await db
    .update(environmentInstanceMembers)
    .set({
      resourceId: created.resourceId,
      externalId: created.externalId,
      displayName: created.displayName,
      status: "created",
      error: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(environmentInstanceMembers.instanceId, instanceId),
        eq(environmentInstanceMembers.memberKey, memberKey),
      ),
    );
}

export async function markMemberLease(
  instanceId: string,
  memberKey: string,
  leaseId: string | null,
): Promise<void> {
  await db
    .update(environmentInstanceMembers)
    .set({ leaseId, updatedAt: new Date() })
    .where(
      and(
        eq(environmentInstanceMembers.instanceId, instanceId),
        eq(environmentInstanceMembers.memberKey, memberKey),
      ),
    );
}

/**
 * Record a member failure — and, when the provider already handed a resource
 * back, its id, in the **same** statement.
 *
 * Splitting these was a way to lose a running resource: if the create
 * succeeded and the confirming write failed, a failure record without the id
 * left teardown with a member it believed had created nothing.
 */
export async function markMemberFailed(
  instanceId: string,
  memberKey: string,
  record: MemberFailureRecord,
): Promise<void> {
  await db
    .update(environmentInstanceMembers)
    .set({
      status: "failed",
      error: record.error,
      ...(record.resourceId !== undefined
        ? {
            resourceId: record.resourceId,
            externalId: record.externalId ?? null,
            ...(record.displayName !== undefined ? { displayName: record.displayName } : {}),
          }
        : {}),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(environmentInstanceMembers.instanceId, instanceId),
        eq(environmentInstanceMembers.memberKey, memberKey),
      ),
    );
}

/** Attach a provider-side id discovered during teardown verification. */
export async function markMemberResourceId(
  instanceId: string,
  memberKey: string,
  found: { resourceId: string; externalId: string | null },
): Promise<void> {
  await db
    .update(environmentInstanceMembers)
    .set({
      resourceId: found.resourceId,
      externalId: found.externalId,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(environmentInstanceMembers.instanceId, instanceId),
        eq(environmentInstanceMembers.memberKey, memberKey),
      ),
    );
}

export async function markMemberStatus(
  instanceId: string,
  memberKey: string,
  status: EnvironmentMemberStatus,
  error?: string | null,
): Promise<void> {
  await db
    .update(environmentInstanceMembers)
    .set({ status, error: error ?? null, updatedAt: new Date() })
    .where(
      and(
        eq(environmentInstanceMembers.instanceId, instanceId),
        eq(environmentInstanceMembers.memberKey, memberKey),
      ),
    );
}

export async function setInstanceStatus(
  instanceId: string,
  status: EnvironmentInstanceStatus,
  patch: { error?: string | null; completedAt?: Date | null } = {},
): Promise<void> {
  await db
    .update(environmentInstances)
    .set({
      status,
      ...(patch.error !== undefined ? { error: patch.error } : {}),
      ...(patch.completedAt !== undefined ? { completedAt: patch.completedAt } : {}),
      updatedAt: new Date(),
    })
    .where(eq(environmentInstances.id, instanceId));
}

export async function deleteEnvironmentInstanceRecord(
  organizationId: string,
  instanceId: string,
): Promise<InstanceRow> {
  const row = await getInstanceRow(organizationId, instanceId);
  if (!row) throw new EnvironmentInputError("Environment not found", 404);
  if (LIVE_STATUSES.includes(row.status)) {
    throw new EnvironmentInputError(
      "Tear this environment down before forgetting it — its resources are still running",
      409,
    );
  }
  await db.delete(environmentInstances).where(eq(environmentInstances.id, instanceId));
  return row;
}

export { instanceToWire, LIVE_STATUSES };
