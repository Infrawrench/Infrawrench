import { Hono, type Context } from "hono";
import {
  DORA_DEPLOY_STATUSES,
  type DoraBucketSize,
  type DoraDeploymentInput,
  type DoraScopeFilter,
  type DoraSettings,
} from "@infrawrench/client-core";
import {
  DoraQueryError,
  getDoraReport,
  listDoraChanges,
  listDoraRestores,
  type DoraWindow,
} from "@infrawrench/server-core/dora/load";
import {
  DoraSettingsError,
  getDoraSettings,
  updateDoraSettings,
} from "@infrawrench/server-core/dora/settings";
import { DoraInputError, recordApiDeployEvent } from "@infrawrench/server-core/dora/record";
import { requirePermission } from "../../auth/permissions";
import { logAudit } from "../../services/audit";
import type { AuthSession } from "../auth-middleware";
import { parseObjectBody } from "../object-body";

/**
 * DORA metrics (the Delivery page): the report, its two drill-downs, the org
 * settings singleton, and a way to push in a deploy no plugin covers.
 *
 * Everything here reads Postgres only (`server-core/src/dora/load.ts`), so it
 * runs on the edge. Reads take `deployments:read`, the permission the
 * deployment history already uses: the metrics are a view over the same
 * record. The settings decide what counts as production for everyone, so
 * writing them takes `org:settings:write`; recording a deploy takes
 * `deployments:write`.
 */

declare module "hono" {
  interface ContextVariableMap {
    session: AuthSession;
  }
}

const app = new Hono();
const DAY_MS = 86_400_000;

function doraError(c: Context, err: unknown) {
  if (
    err instanceof DoraQueryError ||
    err instanceof DoraSettingsError ||
    err instanceof DoraInputError
  ) {
    return c.json({ error: err.message }, 400);
  }
  console.error("[dora] unexpected error:", err);
  return c.json({ error: "Delivery metrics failed" }, 500);
}

/** `from`/`to` from the query, defaulting to the 30 days ending now. */
function readWindow(c: Context): DoraWindow | string {
  const toRaw = c.req.query("to");
  const fromRaw = c.req.query("from");
  const to = toRaw ? new Date(toRaw) : new Date();
  if (!Number.isFinite(to.getTime())) return "to must be an ISO 8601 timestamp";
  const from = fromRaw ? new Date(fromRaw) : new Date(to.getTime() - 30 * DAY_MS);
  if (!Number.isFinite(from.getTime())) return "from must be an ISO 8601 timestamp";
  return { from, to };
}

/**
 * `dimension` + `value` filter to one scope. A dimension with no `value`
 * filters to "not known" (no owner recorded, no repository), which is a scope
 * worth seeing: it is where untracked deploys hide.
 */
function readFilter(c: Context): DoraScopeFilter | null {
  const dimension = c.req.query("dimension");
  if (!dimension) return null;
  const value = c.req.query("value");
  return { dimension, value: value === undefined || value === "" ? null : value };
}

app.get("/", async (c) => {
  requirePermission(c, "deployments:read");
  const window = readWindow(c);
  if (typeof window === "string") return c.json({ error: window }, 400);
  const bucketRaw = c.req.query("bucket");
  if (bucketRaw !== undefined && bucketRaw !== "day" && bucketRaw !== "week") {
    return c.json({ error: "bucket must be day or week" }, 400);
  }
  try {
    const groupBy = c.req.query("groupBy");
    return c.json(
      await getDoraReport(c.get("organizationId"), {
        ...window,
        ...(bucketRaw ? { bucket: bucketRaw as DoraBucketSize } : {}),
        filter: readFilter(c),
        ...(groupBy ? { groupBy } : {}),
      }),
    );
  } catch (err) {
    return doraError(c, err);
  }
});

app.get("/changes", async (c) => {
  requirePermission(c, "deployments:read");
  const window = readWindow(c);
  if (typeof window === "string") return c.json({ error: window }, 400);
  try {
    return c.json(
      await listDoraChanges(c.get("organizationId"), {
        ...window,
        filter: readFilter(c),
        failedOnly: c.req.query("failedOnly") === "true",
      }),
    );
  } catch (err) {
    return doraError(c, err);
  }
});

app.get("/restores", async (c) => {
  requirePermission(c, "deployments:read");
  const window = readWindow(c);
  if (typeof window === "string") return c.json({ error: window }, 400);
  try {
    return c.json({
      restores: await listDoraRestores(c.get("organizationId"), {
        ...window,
        filter: readFilter(c),
      }),
    });
  } catch (err) {
    return doraError(c, err);
  }
});

app.get("/settings", async (c) => {
  requirePermission(c, "deployments:read");
  return c.json(await getDoraSettings(c.get("organizationId")));
});

app.put("/settings", async (c) => {
  requirePermission(c, "org:settings:write");
  const { body, error } = await parseObjectBody(c);
  if (error) return error;
  const patch: Partial<DoraSettings> = {};
  if (body["failureWindowHours"] !== undefined) {
    if (typeof body["failureWindowHours"] !== "number") {
      return c.json({ error: "failureWindowHours must be a number" }, 400);
    }
    patch.failureWindowHours = body["failureWindowHours"];
  }
  for (const key of ["productionEnvironments", "pipelinePatterns"] as const) {
    const v = body[key];
    if (v === undefined) continue;
    if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) {
      return c.json({ error: `${key} must be a list of strings` }, 400);
    }
    patch[key] = v as string[];
  }
  for (const key of ["countFailedDeploys", "includeResourceChanges", "digestEnabled"] as const) {
    const v = body[key];
    if (v === undefined) continue;
    if (typeof v !== "boolean") return c.json({ error: `${key} must be a boolean` }, 400);
    patch[key] = v;
  }
  const organizationId = c.get("organizationId");
  const session = c.get("session");
  try {
    const saved = await updateDoraSettings(organizationId, patch, session?.userId ?? null);
    void logAudit({
      organizationId,
      userId: session?.userId,
      action: "dora.settings.update",
      entityType: "dora_settings",
      entityId: organizationId,
      metadata: { fields: Object.keys(patch) },
    });
    return c.json(saved);
  } catch (err) {
    return doraError(c, err);
  }
});

app.post("/deployments", async (c) => {
  requirePermission(c, "deployments:write");
  const { body, error } = await parseObjectBody(c);
  if (error) return error;
  const status = body["status"];
  if (
    status !== undefined &&
    (typeof status !== "string" ||
      !DORA_DEPLOY_STATUSES.includes(status as (typeof DORA_DEPLOY_STATUSES)[number]))
  ) {
    return c.json({ error: `status must be one of ${DORA_DEPLOY_STATUSES.join(", ")}` }, 400);
  }
  const organizationId = c.get("organizationId");
  try {
    const saved = await recordApiDeployEvent(
      organizationId,
      body as unknown as DoraDeploymentInput,
    );
    void logAudit({
      organizationId,
      userId: c.get("session")?.userId,
      action: "dora.deployment.record",
      entityType: "deploy_event",
      entityId: saved.id,
      metadata: { externalId: String(body["externalId"] ?? ""), environment: body["environment"] },
    });
    return c.json(saved, 201);
  } catch (err) {
    return doraError(c, err);
  }
});

export { app as doraRoutes };
