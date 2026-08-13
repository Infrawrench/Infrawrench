/**
 * Runtime-only workflow secret reads.
 *
 * Public CRUD lives in the web service, while this module is deliberately
 * server-core-local so poller and web runners can resolve the same assignment
 * snapshot without exposing plaintext through a transport.
 */
import { and, eq } from "drizzle-orm";

import type { WorkflowSecretRef } from "@infrawrench/workflow-runtime";

import { db } from "./db/client.js";
import { workflowSecretAssignments, workflowSecrets, workflows } from "./db/schema.js";
import { buildAad, decrypt } from "./encryption.js";

async function requireOwnedWorkflow(organizationId: string, workflowId: string): Promise<void> {
  const [row] = await db
    .select({ id: workflows.id })
    .from(workflows)
    .where(and(eq(workflows.id, workflowId), eq(workflows.organizationId, organizationId)))
    .limit(1);
  if (!row) throw new Error(`Workflow not found: ${workflowId}`);
}

async function assignedRows(organizationId: string, workflowId: string) {
  await requireOwnedWorkflow(organizationId, workflowId);
  return db
    .select({ secret: workflowSecrets })
    .from(workflowSecretAssignments)
    .innerJoin(workflowSecrets, eq(workflowSecrets.id, workflowSecretAssignments.secretId))
    .where(
      and(
        eq(workflowSecretAssignments.workflowId, workflowId),
        eq(workflowSecrets.organizationId, organizationId),
      ),
    );
}

export async function listWorkflowSecretRefs(
  organizationId: string,
  workflowId: string,
): Promise<WorkflowSecretRef[]> {
  const rows = await assignedRows(organizationId, workflowId);
  return rows.map(({ secret }) => ({ key: secret.id, name: secret.name }));
}

export async function loadWorkflowSecretValues(
  organizationId: string,
  workflowId: string,
): Promise<Record<string, string | null>> {
  const rows = await assignedRows(organizationId, workflowId);
  const values = await Promise.all(
    rows.map(async ({ secret }) => {
      if (!secret.encryptedValue || !secret.encryptedValueIv) {
        return [secret.name, null] as const;
      }
      const value = await decrypt(
        secret.encryptedValue,
        secret.encryptedValueIv,
        buildAad("workflowSecret", secret.id, "value"),
      );
      return [secret.name, value] as const;
    }),
  );
  return Object.fromEntries(values);
}
