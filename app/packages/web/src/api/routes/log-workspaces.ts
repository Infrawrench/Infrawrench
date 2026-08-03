import { Hono, type Context } from "hono";
import {
  LogWorkspaceInputError,
  createLogWorkspaceRecord,
  deleteLogWorkspaceRecord,
  listLogWorkspaceQueries,
  toWire,
  updateLogWorkspaceRecord,
  type LogWorkspaceQueryCreateInput,
  type LogWorkspaceQueryUpdateInput,
} from "@infrawrench/server-core/log-workspaces/store";
import type { LogStreamSelector } from "@infrawrench/client-core";
import { requirePermission } from "../../auth/permissions";
import { logAudit } from "../../services/audit";
import { listLogCapableResources } from "../../services/log-workspaces";
import type { AuthSession } from "../auth-middleware";

/**
 * Log workspace saved queries — a named set of log-capable resources plus a
 * search expression, so a multi-resource tail workspace can be reopened, and
 * optionally alert-evaluated by the poller
 * (`server-core/src/log-workspaces/pass.ts`).
 *
 * Permissions: reads are `resources:read` (a saved query is a view over the
 * org's resource logs, which that permission already gates via
 * `/resources/:pluginId/:typeId/logs`); mutations are `resources:write` —
 * the sleep-schedules stance.
 */

declare module "hono" {
  interface ContextVariableMap {
    session: AuthSession;
  }
}

const app = new Hono();

function logWorkspaceErrorResponse(c: Context, err: unknown) {
  if (err instanceof LogWorkspaceInputError) {
    return c.json({ error: err.message }, err.status);
  }
  // Anything else is a server bug or infrastructure failure — log the detail
  // server-side and keep internals out of the response.
  console.error("[log-workspaces] unexpected error:", err);
  return c.json({ error: "Saved query operation failed" }, 500);
}

function readSelectors(value: unknown): LogStreamSelector[] | { error: string } {
  if (!Array.isArray(value)) return { error: "resources must be an array" };
  const selectors: LogStreamSelector[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return { error: "each resource must be an object" };
    }
    const record = entry as Record<string, unknown>;
    for (const key of ["resourceId", "accountId", "pluginId", "resourceTypeId"] as const) {
      if (typeof record[key] !== "string" || record[key].length === 0) {
        return { error: `each resource needs a string ${key}` };
      }
    }
    if (record["container"] !== undefined && typeof record["container"] !== "string") {
      return { error: "container must be a string when present" };
    }
    selectors.push({
      resourceId: record["resourceId"] as string,
      accountId: record["accountId"] as string,
      pluginId: record["pluginId"] as string,
      resourceTypeId: record["resourceTypeId"] as string,
      ...(record["container"] ? { container: record["container"] as string } : {}),
    });
  }
  return selectors;
}

async function parseObjectBody(
  c: Context,
): Promise<{ body: Record<string, unknown>; error?: Response }> {
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

app.get("/", async (c) => {
  requirePermission(c, "resources:read");
  return c.json(await listLogWorkspaceQueries(c.get("organizationId")));
});

/** Org resources whose rendered detail declares the `logs` capability. */
app.get("/resources", async (c) => {
  requirePermission(c, "resources:read");
  return c.json(await listLogCapableResources(c.get("organizationId")));
});

app.post("/", async (c) => {
  requirePermission(c, "resources:write");
  const organizationId = c.get("organizationId");
  const session = c.get("session");
  const { body, error } = await parseObjectBody(c);
  if (error) return error;
  if (typeof body["name"] !== "string") return c.json({ error: "name is required" }, 400);
  if (typeof body["search"] !== "string") return c.json({ error: "search must be a string" }, 400);
  const selectors = readSelectors(body["resources"]);
  if ("error" in selectors) return c.json({ error: selectors.error }, 400);
  if (body["alertEnabled"] !== undefined && typeof body["alertEnabled"] !== "boolean") {
    return c.json({ error: "alertEnabled must be a boolean" }, 400);
  }

  const input: LogWorkspaceQueryCreateInput = {
    name: body["name"],
    resources: selectors,
    search: body["search"],
    ...(body["alertEnabled"] !== undefined ? { alertEnabled: body["alertEnabled"] } : {}),
  };
  try {
    const created = await createLogWorkspaceRecord(organizationId, input, session?.userId);
    void logAudit({
      organizationId,
      userId: session?.userId,
      action: "log_workspace_query.create",
      entityType: "log_workspace_query",
      entityId: created.id,
      metadata: {
        name: created.name,
        resourceCount: created.resources.length,
        alertEnabled: created.alertEnabled,
      },
    });
    return c.json(toWire(created), 201);
  } catch (err) {
    return logWorkspaceErrorResponse(c, err);
  }
});

app.put("/:id", async (c) => {
  requirePermission(c, "resources:write");
  const organizationId = c.get("organizationId");
  const session = c.get("session");
  const queryId = c.req.param("id");
  const { body, error } = await parseObjectBody(c);
  if (error) return error;

  const patch: LogWorkspaceQueryUpdateInput = {};
  if (body["name"] !== undefined) {
    if (typeof body["name"] !== "string") return c.json({ error: "name must be a string" }, 400);
    patch.name = body["name"];
  }
  if (body["search"] !== undefined) {
    if (typeof body["search"] !== "string")
      return c.json({ error: "search must be a string" }, 400);
    patch.search = body["search"];
  }
  if (body["resources"] !== undefined) {
    const selectors = readSelectors(body["resources"]);
    if ("error" in selectors) return c.json({ error: selectors.error }, 400);
    patch.resources = selectors;
  }
  if (body["alertEnabled"] !== undefined) {
    if (typeof body["alertEnabled"] !== "boolean") {
      return c.json({ error: "alertEnabled must be a boolean" }, 400);
    }
    patch.alertEnabled = body["alertEnabled"];
  }
  if (Object.keys(patch).length === 0) return c.json({ error: "No changes supplied" }, 400);

  try {
    const updated = await updateLogWorkspaceRecord(organizationId, queryId, patch);
    void logAudit({
      organizationId,
      userId: session?.userId,
      action: "log_workspace_query.update",
      entityType: "log_workspace_query",
      entityId: updated.id,
      metadata: { name: updated.name, patch: Object.keys(patch) },
    });
    return c.json(toWire(updated));
  } catch (err) {
    return logWorkspaceErrorResponse(c, err);
  }
});

app.delete("/:id", async (c) => {
  requirePermission(c, "resources:write");
  const organizationId = c.get("organizationId");
  const session = c.get("session");
  const queryId = c.req.param("id");
  try {
    const deleted = await deleteLogWorkspaceRecord(organizationId, queryId);
    void logAudit({
      organizationId,
      userId: session?.userId,
      action: "log_workspace_query.delete",
      entityType: "log_workspace_query",
      entityId: deleted.id,
      metadata: { name: deleted.name },
    });
    return c.body(null, 204);
  } catch (err) {
    return logWorkspaceErrorResponse(c, err);
  }
});

export { app as logWorkspaceRoutes };
