import { and, asc, eq, inArray } from "drizzle-orm";

import { buildAad, decrypt, encrypt } from "@infrawrench/server-core/encryption";
import { assertNoWorkflowSecretNameCollisions } from "@infrawrench/workflow-runtime";

import { db } from "../db/client";
import { workflowSecretAssignments, workflowSecrets, workflows } from "../db/schema";

const DOT_IDENTIFIER = /^[$A-Z_a-z][$\w]*(?:\.[$A-Z_a-z][$\w]*)*$/;

type WorkflowSecretRow = typeof workflowSecrets.$inferSelect;

export interface WorkflowSecretMetadata {
  id: string;
  name: string;
  description: string | null;
  hasValue: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export class WorkflowSecretError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 = 400,
  ) {
    super(message);
    this.name = "WorkflowSecretError";
  }
}

function aad(id: string): string {
  return buildAad("workflowSecret", id, "value");
}

function metadata(row: WorkflowSecretRow): WorkflowSecretMetadata {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    hasValue: row.encryptedValue !== null && row.encryptedValueIv !== null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function validateWorkflowSecretName(name: string): string {
  const normalized = name.trim();
  if (normalized.length > 128 || !DOT_IDENTIFIER.test(normalized)) {
    throw new WorkflowSecretError(
      "Secret name must be at most 128 characters and a JavaScript dot identifier (for example API_TOKEN or stripe.apiKey).",
    );
  }
  return normalized;
}

async function assertWorkflowSecretNameAvailable(
  organizationId: string,
  name: string,
  excludeId?: string,
): Promise<void> {
  const rows = await db
    .select({ id: workflowSecrets.id, name: workflowSecrets.name })
    .from(workflowSecrets)
    .where(eq(workflowSecrets.organizationId, organizationId));
  const conflict = rows.find(
    (row) =>
      row.id !== excludeId &&
      (row.name === name || row.name.startsWith(`${name}.`) || name.startsWith(`${row.name}.`)),
  );
  if (conflict) {
    throw new WorkflowSecretError(
      `Workflow secret "${name}" conflicts with existing secret "${conflict.name}".`,
      409,
    );
  }
}

async function requireSecret(organizationId: string, secretId: string): Promise<WorkflowSecretRow> {
  const [row] = await db
    .select()
    .from(workflowSecrets)
    .where(
      and(eq(workflowSecrets.id, secretId), eq(workflowSecrets.organizationId, organizationId)),
    )
    .limit(1);
  if (!row) throw new WorkflowSecretError(`Workflow secret not found: ${secretId}`, 404);
  return row;
}

async function requireOwnedWorkflow(organizationId: string, workflowId: string): Promise<void> {
  const [row] = await db
    .select({ id: workflows.id })
    .from(workflows)
    .where(and(eq(workflows.id, workflowId), eq(workflows.organizationId, organizationId)))
    .limit(1);
  if (!row) throw new WorkflowSecretError(`Workflow not found: ${workflowId}`, 404);
}

function rethrowUnique(error: unknown): never {
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === "23505"
  ) {
    throw new WorkflowSecretError("A workflow secret with that name already exists.", 409);
  }
  throw error;
}

export async function listWorkflowSecrets(
  organizationId: string,
): Promise<WorkflowSecretMetadata[]> {
  const rows = await db
    .select()
    .from(workflowSecrets)
    .where(eq(workflowSecrets.organizationId, organizationId))
    .orderBy(asc(workflowSecrets.name));
  return rows.map(metadata);
}

export async function createWorkflowSecret(
  organizationId: string,
  input: { name: string; description?: string | null },
): Promise<WorkflowSecretMetadata> {
  const id = crypto.randomUUID();
  const now = new Date();
  const name = validateWorkflowSecretName(input.name);
  await assertWorkflowSecretNameAvailable(organizationId, name);
  try {
    await db.insert(workflowSecrets).values({
      id,
      organizationId,
      name,
      description: input.description?.trim() || null,
      createdAt: now,
      updatedAt: now,
    });
  } catch (error) {
    rethrowUnique(error);
  }
  return metadata(await requireSecret(organizationId, id));
}

export async function updateWorkflowSecretMetadata(
  organizationId: string,
  secretId: string,
  input: { name?: string; description?: string | null },
): Promise<WorkflowSecretMetadata> {
  await requireSecret(organizationId, secretId);
  const name = input.name === undefined ? undefined : validateWorkflowSecretName(input.name);
  if (name !== undefined) {
    await assertWorkflowSecretNameAvailable(organizationId, name, secretId);
  }
  try {
    await db
      .update(workflowSecrets)
      .set({
        ...(name !== undefined ? { name } : {}),
        ...(input.description !== undefined
          ? { description: input.description?.trim() || null }
          : {}),
        updatedAt: new Date(),
      })
      .where(
        and(eq(workflowSecrets.id, secretId), eq(workflowSecrets.organizationId, organizationId)),
      );
  } catch (error) {
    rethrowUnique(error);
  }
  return metadata(await requireSecret(organizationId, secretId));
}

/** Write-only value update; no service response ever contains the plaintext. */
export async function writeWorkflowSecretValue(
  organizationId: string,
  secretId: string,
  value: string,
): Promise<WorkflowSecretMetadata> {
  if (!value || Buffer.byteLength(value, "utf8") > 1024 * 1024) {
    throw new WorkflowSecretError("Secret value must be between 1 byte and 1 MiB.");
  }
  await requireSecret(organizationId, secretId);
  const encrypted = await encrypt(value, aad(secretId));
  await db
    .update(workflowSecrets)
    .set({
      encryptedValue: encrypted.ciphertext,
      encryptedValueIv: encrypted.iv,
      updatedAt: new Date(),
    })
    .where(
      and(eq(workflowSecrets.id, secretId), eq(workflowSecrets.organizationId, organizationId)),
    );
  return metadata(await requireSecret(organizationId, secretId));
}

export async function deleteWorkflowSecret(
  organizationId: string,
  secretId: string,
): Promise<WorkflowSecretMetadata> {
  const existing = await requireSecret(organizationId, secretId);
  await db
    .delete(workflowSecrets)
    .where(
      and(eq(workflowSecrets.id, secretId), eq(workflowSecrets.organizationId, organizationId)),
    );
  return metadata(existing);
}

export async function getWorkflowSecretAssignments(
  organizationId: string,
  workflowId: string,
): Promise<string[]> {
  await requireOwnedWorkflow(organizationId, workflowId);
  const rows = await db
    .select({ secretId: workflowSecretAssignments.secretId })
    .from(workflowSecretAssignments)
    .innerJoin(workflowSecrets, eq(workflowSecrets.id, workflowSecretAssignments.secretId))
    .where(
      and(
        eq(workflowSecretAssignments.workflowId, workflowId),
        eq(workflowSecrets.organizationId, organizationId),
      ),
    );
  return rows.map((row) => row.secretId);
}

export async function setWorkflowSecretAssignments(
  organizationId: string,
  workflowId: string,
  secretIds: string[],
): Promise<WorkflowSecretMetadata[]> {
  await requireOwnedWorkflow(organizationId, workflowId);
  const uniqueIds = await validateWorkflowSecretIds(organizationId, secretIds);

  await db.transaction(async (tx) => {
    await tx
      .delete(workflowSecretAssignments)
      .where(eq(workflowSecretAssignments.workflowId, workflowId));
    if (uniqueIds.length > 0) {
      await tx
        .insert(workflowSecretAssignments)
        .values(uniqueIds.map((secretId) => ({ workflowId, secretId })));
    }
  });
  return listAssignedWorkflowSecrets(organizationId, workflowId);
}

/** Validate and de-duplicate an assignment before mutating its workflow. */
export async function validateWorkflowSecretIds(
  organizationId: string,
  secretIds: string[],
): Promise<string[]> {
  const uniqueIds = [...new Set(secretIds)];
  if (uniqueIds.length > 0) {
    const owned = await db
      .select({ id: workflowSecrets.id, name: workflowSecrets.name })
      .from(workflowSecrets)
      .where(
        and(
          eq(workflowSecrets.organizationId, organizationId),
          inArray(workflowSecrets.id, uniqueIds),
        ),
      );
    if (owned.length !== uniqueIds.length) {
      throw new WorkflowSecretError(
        "One or more workflow secrets do not exist in this organization.",
        404,
      );
    }
    try {
      assertNoWorkflowSecretNameCollisions(owned.map((secret) => secret.name));
    } catch (error) {
      throw new WorkflowSecretError(
        error instanceof Error ? error.message : "Workflow secret names conflict.",
        409,
      );
    }
  }
  return uniqueIds;
}

export async function listAssignedWorkflowSecrets(
  organizationId: string,
  workflowId: string,
): Promise<WorkflowSecretMetadata[]> {
  await requireOwnedWorkflow(organizationId, workflowId);
  const rows = await db
    .select({ secret: workflowSecrets })
    .from(workflowSecretAssignments)
    .innerJoin(workflowSecrets, eq(workflowSecrets.id, workflowSecretAssignments.secretId))
    .where(
      and(
        eq(workflowSecretAssignments.workflowId, workflowId),
        eq(workflowSecrets.organizationId, organizationId),
      ),
    )
    .orderBy(asc(workflowSecrets.name));
  return rows.map((row) => metadata(row.secret));
}

/**
 * Internal runtime-only read. Public routes and tools intentionally do not
 * expose this function or any equivalent value-returning operation.
 */
export async function loadAssignedWorkflowSecretValues(
  organizationId: string,
  workflowId: string,
): Promise<Record<string, string>> {
  await requireOwnedWorkflow(organizationId, workflowId);
  const rows = await db
    .select({ secret: workflowSecrets })
    .from(workflowSecretAssignments)
    .innerJoin(workflowSecrets, eq(workflowSecrets.id, workflowSecretAssignments.secretId))
    .where(
      and(
        eq(workflowSecretAssignments.workflowId, workflowId),
        eq(workflowSecrets.organizationId, organizationId),
      ),
    );

  const values = await Promise.all(
    rows.map(async ({ secret }) => {
      if (!secret.encryptedValue || !secret.encryptedValueIv) return null;
      return [
        secret.name,
        await decrypt(secret.encryptedValue, secret.encryptedValueIv, aad(secret.id)),
      ] as const;
    }),
  );
  return Object.fromEntries(values.filter((entry): entry is readonly [string, string] => !!entry));
}
