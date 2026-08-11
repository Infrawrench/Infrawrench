import { Hono, type Context } from "hono";
import {
  EnvironmentInputError,
  createEnvironmentTemplateRecord,
  deleteEnvironmentTemplateRecord,
  getEnvironmentInstance,
  getEnvironmentSettings,
  getEnvironmentTemplate,
  listEnvironmentInstances,
  listEnvironmentTemplates,
  setEnvironmentSettings,
  updateEnvironmentTemplateRecord,
} from "@infrawrench/server-core/environments/store";
import { captureEnvironmentDraft } from "@infrawrench/server-core/environments/capture";
import {
  estimateEnvironmentInstantiation,
  forgetEnvironmentInstance,
  instantiateEnvironment,
  reconcileEnvironmentInstances,
  tearDownEnvironment,
} from "@infrawrench/server-core/environments/instantiate";
import type { EnvironmentTemplateInput } from "@infrawrench/client-core";
import { requirePermission } from "../../auth/permissions";
import { logAudit } from "../../services/audit";
import { checkChangeFreeze } from "../../services/change-freezes";
import type { AuthSession } from "../auth-middleware";

/**
 * Ephemeral environments — capture a set of resources as a parameterised
 * template, stamp copies of it out with a mandatory TTL, and tear them down.
 *
 * Permissions follow the **leases stance**, deliberately, rather than adding a
 * new permission family: reads are `resources:read` (a template is a view over
 * the org's own resources), template edits are `resources:write`, and
 * teardown is `resources:delete`. Instantiation requires `resources:write`
 * **and** `resources:delete` — every instance carries an auto-delete lease,
 * which is the same standing-deletion argument `POST /leases` makes for
 * `autoDelete: true`. The org's TTL ceiling is `org:settings:write`, because
 * it is a governance decision about spend rather than an edit to a resource.
 *
 * Instantiation and teardown both pass through the change-freeze gate: one
 * commits the organization to spend, the other deletes.
 */

declare module "hono" {
  interface ContextVariableMap {
    session: AuthSession;
  }
}

const app = new Hono();

interface ParsedBody {
  body: Record<string, unknown>;
  error?: Response;
}

async function parseObjectBody(c: Context): Promise<ParsedBody> {
  try {
    const parsed = (await c.req.json()) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { body: {}, error: c.json({ error: "Request body must be an object" }, 400) };
    }
    return { body: parsed as Record<string, unknown> };
  } catch {
    return { body: {}, error: c.json({ error: "Invalid JSON body" }, 400) };
  }
}

function environmentErrorResponse(c: Context, err: unknown) {
  if (err instanceof EnvironmentInputError) {
    return c.json({ error: err.message }, err.status);
  }
  console.error("[environments] unexpected error:", err);
  return c.json({ error: "Environment operation failed" }, 500);
}

function stringRecord(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw === "string") out[key] = raw;
    else if (typeof raw === "number" || typeof raw === "boolean") out[key] = String(raw);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

app.get("/settings", async (c) => {
  requirePermission(c, "resources:read");
  return c.json(await getEnvironmentSettings(c.get("organizationId")));
});

app.put("/settings", async (c) => {
  requirePermission(c, "org:settings:write");
  const organizationId = c.get("organizationId");
  const session = c.get("session");
  const { body, error } = await parseObjectBody(c);
  if (error) return error;
  const settings = await setEnvironmentSettings(
    organizationId,
    {
      ...(typeof body["maxTtlHours"] === "number" ? { maxTtlHours: body["maxTtlHours"] } : {}),
      ...(typeof body["defaultTtlHours"] === "number"
        ? { defaultTtlHours: body["defaultTtlHours"] }
        : {}),
    },
    session?.userId,
  );
  void logAudit({
    organizationId,
    userId: session?.userId,
    action: "environment_settings.update",
    entityType: "environment_settings",
    entityId: organizationId,
    metadata: { ...settings },
  });
  return c.json(settings);
});

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

/**
 * Preview a capture. Persists nothing — the draft is what the editor shows so
 * the user can pick which fields to vary before anything is saved.
 */
app.post("/capture", async (c) => {
  requirePermission(c, "resources:read");
  const { body, error } = await parseObjectBody(c);
  if (error) return error;
  const resourceIds = Array.isArray(body["resourceIds"])
    ? (body["resourceIds"] as unknown[]).filter((v): v is string => typeof v === "string")
    : undefined;
  try {
    return c.json(
      await captureEnvironmentDraft(c.get("organizationId"), {
        ...(resourceIds && resourceIds.length > 0 ? { resourceIds } : {}),
        ...(typeof body["accountId"] === "string" ? { accountId: body["accountId"] } : {}),
        ...(typeof body["tagKey"] === "string" ? { tagKey: body["tagKey"] } : {}),
        ...(typeof body["tagValue"] === "string" ? { tagValue: body["tagValue"] } : {}),
      }),
    );
  } catch (err) {
    return environmentErrorResponse(c, err);
  }
});

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

app.get("/templates", async (c) => {
  requirePermission(c, "resources:read");
  return c.json(await listEnvironmentTemplates(c.get("organizationId")));
});

function readTemplateInput(body: Record<string, unknown>): EnvironmentTemplateInput | string {
  if (typeof body["name"] !== "string") return "name is required";
  if (!Array.isArray(body["members"])) return "members must be an array";
  if (body["parameters"] !== undefined && !Array.isArray(body["parameters"])) {
    return "parameters must be an array";
  }
  return {
    name: body["name"],
    ...(body["description"] === undefined
      ? {}
      : { description: typeof body["description"] === "string" ? body["description"] : null }),
    parameters: (body["parameters"] ?? []) as EnvironmentTemplateInput["parameters"],
    members: body["members"] as EnvironmentTemplateInput["members"],
  };
}

app.post("/templates", async (c) => {
  requirePermission(c, "resources:write");
  const organizationId = c.get("organizationId");
  const session = c.get("session");
  const { body, error } = await parseObjectBody(c);
  if (error) return error;
  const input = readTemplateInput(body);
  if (typeof input === "string") return c.json({ error: input }, 400);
  try {
    const created = await createEnvironmentTemplateRecord(organizationId, input, session?.userId);
    void logAudit({
      organizationId,
      userId: session?.userId,
      action: "environment_template.create",
      entityType: "environment_template",
      entityId: created.id,
      metadata: { name: created.name, memberCount: created.members.length },
    });
    return c.json(created, 201);
  } catch (err) {
    return environmentErrorResponse(c, err);
  }
});

app.get("/templates/:id", async (c) => {
  requirePermission(c, "resources:read");
  const template = await getEnvironmentTemplate(c.get("organizationId"), c.req.param("id"));
  if (!template) return c.json({ error: "Template not found" }, 404);
  return c.json(template);
});

app.put("/templates/:id", async (c) => {
  requirePermission(c, "resources:write");
  const organizationId = c.get("organizationId");
  const session = c.get("session");
  const { body, error } = await parseObjectBody(c);
  if (error) return error;
  const input = readTemplateInput(body);
  if (typeof input === "string") return c.json({ error: input }, 400);
  try {
    const updated = await updateEnvironmentTemplateRecord(organizationId, c.req.param("id"), input);
    void logAudit({
      organizationId,
      userId: session?.userId,
      action: "environment_template.update",
      entityType: "environment_template",
      entityId: updated.id,
      metadata: { name: updated.name, memberCount: updated.members.length },
    });
    return c.json(updated);
  } catch (err) {
    return environmentErrorResponse(c, err);
  }
});

app.delete("/templates/:id", async (c) => {
  requirePermission(c, "resources:write");
  const organizationId = c.get("organizationId");
  const session = c.get("session");
  try {
    const deleted = await deleteEnvironmentTemplateRecord(organizationId, c.req.param("id"));
    void logAudit({
      organizationId,
      userId: session?.userId,
      action: "environment_template.delete",
      entityType: "environment_template",
      entityId: deleted.id,
      metadata: { name: deleted.name },
    });
    return c.body(null, 204);
  } catch (err) {
    return environmentErrorResponse(c, err);
  }
});

/** What this instantiation would cost per month, before it runs. */
app.post("/templates/:id/estimate", async (c) => {
  requirePermission(c, "resources:read");
  const { body, error } = await parseObjectBody(c);
  if (error) return error;
  try {
    return c.json(
      await estimateEnvironmentInstantiation(
        c.get("organizationId"),
        c.req.param("id"),
        stringRecord(body["parameters"]),
        stringRecord(body["accountOverrides"]),
      ),
    );
  } catch (err) {
    return environmentErrorResponse(c, err);
  }
});

app.post("/templates/:id/instantiate", async (c) => {
  // Creating an environment is a write; the mandatory auto-delete lease it
  // carries is a standing deletion, which is the permission POST /leases gates
  // `autoDelete: true` on.
  requirePermission(c, "resources:write");
  requirePermission(c, "resources:delete");
  const organizationId = c.get("organizationId");
  const session = c.get("session");
  const templateId = c.req.param("id");
  const { body, error } = await parseObjectBody(c);
  if (error) return error;

  // Instantiation spends real money and schedules a deletion; a freeze covers
  // both halves of that.
  const frozen = await checkChangeFreeze(c, {
    action: "environment.instantiate",
    entityType: "environment_template",
    entityId: templateId,
    metadata: { name: body["name"] },
  });
  if (frozen) return frozen;

  if (typeof body["name"] !== "string") return c.json({ error: "name is required" }, 400);
  if (typeof body["ttlHours"] !== "number") {
    return c.json({ error: "ttlHours is required — environments must expire" }, 400);
  }

  try {
    const instance = await instantiateEnvironment(
      organizationId,
      templateId,
      {
        name: body["name"],
        ttlHours: body["ttlHours"],
        parameters: stringRecord(body["parameters"]),
        ...(typeof body["note"] === "string" ? { note: body["note"] } : {}),
      },
      {
        userId: session?.userId,
        accountOverrides: stringRecord(body["accountOverrides"]),
      },
    );
    void logAudit({
      organizationId,
      userId: session?.userId,
      action: "environment_instance.create",
      entityType: "environment_instance",
      entityId: instance.id,
      metadata: {
        templateId,
        status: instance.status,
        expiresAt: instance.expiresAt,
        memberCount: instance.members.length,
      },
    });
    return c.json(instance, 201);
  } catch (err) {
    return environmentErrorResponse(c, err);
  }
});

// ---------------------------------------------------------------------------
// Instances
// ---------------------------------------------------------------------------

app.get("/instances", async (c) => {
  requirePermission(c, "resources:read");
  const organizationId = c.get("organizationId");
  // Expiry is executed per member by the lease pass, which knows nothing about
  // environments. Catching up here — bounded to instances past their own
  // deadline — is what keeps the page from claiming an environment is still
  // running after its last resource was auto-deleted.
  await reconcileEnvironmentInstances(organizationId).catch((err: unknown) => {
    console.error("[environments] reconcile failed:", err);
  });
  return c.json(await listEnvironmentInstances(organizationId));
});

app.get("/instances/:id", async (c) => {
  requirePermission(c, "resources:read");
  const instance = await getEnvironmentInstance(c.get("organizationId"), c.req.param("id"));
  if (!instance) return c.json({ error: "Environment not found" }, 404);
  return c.json(instance);
});

app.post("/instances/:id/teardown", async (c) => {
  requirePermission(c, "resources:delete");
  const organizationId = c.get("organizationId");
  const session = c.get("session");
  const instanceId = c.req.param("id");

  const frozen = await checkChangeFreeze(c, {
    action: "environment.teardown",
    entityType: "environment_instance",
    entityId: instanceId,
  });
  if (frozen) return frozen;

  try {
    const instance = await tearDownEnvironment(organizationId, instanceId, {
      userId: session?.userId,
    });
    void logAudit({
      organizationId,
      userId: session?.userId,
      action: "environment_instance.teardown",
      entityType: "environment_instance",
      entityId: instanceId,
      metadata: { status: instance.status, memberCount: instance.members.length },
    });
    return c.json(instance);
  } catch (err) {
    return environmentErrorResponse(c, err);
  }
});

app.delete("/instances/:id", async (c) => {
  requirePermission(c, "resources:write");
  const organizationId = c.get("organizationId");
  const session = c.get("session");
  const instanceId = c.req.param("id");
  try {
    await forgetEnvironmentInstance(organizationId, instanceId);
    void logAudit({
      organizationId,
      userId: session?.userId,
      action: "environment_instance.delete",
      entityType: "environment_instance",
      entityId: instanceId,
    });
    return c.body(null, 204);
  } catch (err) {
    return environmentErrorResponse(c, err);
  }
});

export { app as environmentRoutes };
