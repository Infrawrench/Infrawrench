import { Hono, type Context } from "hono";

import { requirePermission } from "../../auth/permissions";
import { logAudit } from "../../services/audit";
import {
  WorkflowSecretError,
  createWorkflowSecret,
  deleteWorkflowSecret,
  listWorkflowSecrets,
  updateWorkflowSecretMetadata,
  writeWorkflowSecretValue,
} from "../../services/workflow-secrets";

const app = new Hono();

function fail(c: Context, error: unknown) {
  if (error instanceof WorkflowSecretError) {
    return c.json({ error: error.message }, error.status);
  }
  throw error;
}

app.get("/", async (c) => {
  requirePermission(c, "secrets:read");
  return c.json(await listWorkflowSecrets(c.get("organizationId")));
});

app.post("/", async (c) => {
  requirePermission(c, "secrets:write");
  const body = (await c.req.json().catch(() => null)) as {
    name?: unknown;
    description?: unknown;
  } | null;
  if (!body || typeof body.name !== "string") {
    return c.json({ error: "Body must include a name string." }, 400);
  }
  if (
    body.description !== undefined &&
    body.description !== null &&
    typeof body.description !== "string"
  ) {
    return c.json({ error: "description must be a string or null." }, 400);
  }
  try {
    const secret = await createWorkflowSecret(c.get("organizationId"), {
      name: body.name,
      ...(body.description !== undefined ? { description: body.description as string | null } : {}),
    });
    void logAudit({
      organizationId: c.get("organizationId"),
      userId: c.get("session").userId,
      action: "workflow_secret.create",
      entityType: "workflow_secret",
      entityId: secret.id,
      metadata: { name: secret.name },
    });
    return c.json(secret, 201);
  } catch (error) {
    return fail(c, error);
  }
});

app.patch("/:id", async (c) => {
  requirePermission(c, "secrets:write");
  const body = (await c.req.json().catch(() => null)) as {
    name?: unknown;
    description?: unknown;
  } | null;
  if (!body || (body.name === undefined && body.description === undefined)) {
    return c.json({ error: "Body must include name or description." }, 400);
  }
  if (body.name !== undefined && typeof body.name !== "string") {
    return c.json({ error: "name must be a string." }, 400);
  }
  if (
    body.description !== undefined &&
    body.description !== null &&
    typeof body.description !== "string"
  ) {
    return c.json({ error: "description must be a string or null." }, 400);
  }
  try {
    const secret = await updateWorkflowSecretMetadata(c.get("organizationId"), c.req.param("id"), {
      ...(body.name !== undefined ? { name: body.name as string } : {}),
      ...(body.description !== undefined ? { description: body.description as string | null } : {}),
    });
    void logAudit({
      organizationId: c.get("organizationId"),
      userId: c.get("session").userId,
      action: "workflow_secret.update",
      entityType: "workflow_secret",
      entityId: secret.id,
      metadata: { name: secret.name, hasValue: secret.hasValue },
    });
    return c.json(secret);
  } catch (error) {
    return fail(c, error);
  }
});

app.put("/:id/value", async (c) => {
  requirePermission(c, "secrets:write");
  const body = (await c.req.json().catch(() => null)) as { value?: unknown } | null;
  if (!body || typeof body.value !== "string") {
    return c.json({ error: "Body must include a value string." }, 400);
  }
  try {
    const secret = await writeWorkflowSecretValue(
      c.get("organizationId"),
      c.req.param("id"),
      body.value,
    );
    void logAudit({
      organizationId: c.get("organizationId"),
      userId: c.get("session").userId,
      action: "workflow_secret.value_write",
      entityType: "workflow_secret",
      entityId: secret.id,
      metadata: { name: secret.name },
    });
    return c.json(secret);
  } catch (error) {
    return fail(c, error);
  }
});

app.delete("/:id", async (c) => {
  requirePermission(c, "secrets:write");
  try {
    const secret = await deleteWorkflowSecret(c.get("organizationId"), c.req.param("id"));
    void logAudit({
      organizationId: c.get("organizationId"),
      userId: c.get("session").userId,
      action: "workflow_secret.delete",
      entityType: "workflow_secret",
      entityId: secret.id,
      metadata: { name: secret.name, hadValue: secret.hasValue },
    });
    return c.json({ ok: true });
  } catch (error) {
    return fail(c, error);
  }
});

export { app as workflowSecretRoutes };
