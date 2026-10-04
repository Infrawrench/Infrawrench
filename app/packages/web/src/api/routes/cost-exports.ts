/**
 * Scheduled cost export routes (org-scoped, mounted at
 * `/api/org/:orgId/cost-exports`).
 *
 * An export is a saved cost query plus a schedule plus a destination; the
 * poller runs it and writes one object per period. This file is transport only:
 * validation, credential handling and the run itself live in
 * `server-core/src/cost-exports/*` so the poller drives exactly the same code.
 *
 * ## Permissions
 *
 * Reads are `costs:read`, matching every other cost surface.
 *
 * Writes are **`org:settings:write`, not `costs:write`**, and that is a
 * deliberate step up. `costs:write` is the "curate the cost surface" scope: it
 * lets someone name a report, define a cost centre, retune anomaly detection;
 * all of which move numbers around *inside* Infrawrench. Creating an export is
 * a different act. It is standing authorisation to ship the organization's
 * entire billing history, on a schedule, to a bucket or endpoint the creator
 * chose, indefinitely, with a credential only they supplied. That is a data
 * egress decision, and the people who should be allowed to make it are the
 * people who already decide how the org handles its data. It is the same
 * reasoning that put `PUT /currency` on `org:settings:write` while leaving
 * `GET /currency` on `costs:read`: reading spend and *governing* what happens
 * to spend are not the same trust level.
 *
 * ## Credentials
 *
 * No route here returns a destination credential, and none can: responses are
 * built exclusively by `toCostExportView`, which has no branch that emits the
 * ciphertext, the IV or the plaintext. `GET` answers with a redacted
 * `credentialHint` (`AKIA…7F2Q`), and an omitted credential on `PUT` means
 * "keep the stored one": the same contract the Jira and Twilio sections use.
 */
import { Hono } from "hono";
import { z } from "zod";
import {
  COST_EXPORT_CADENCES,
  COST_EXPORT_FORMATS,
  COST_EXPORT_SCHEMAS,
  COST_DIMENSIONS,
  COST_CHARGE_TYPES,
  type CostExportInput,
} from "@infrawrench/client-core";
import {
  CostExportInputError,
  createCostExport,
  deleteCostExport,
  getCostExport,
  getCostExportRow,
  listCostExports,
  updateCostExport,
} from "@infrawrench/server-core/cost-exports/store";
import { runCostExport } from "@infrawrench/server-core/cost-exports/run";
import {
  describeWarehouseSetup,
  listWarehouseOptions,
  listWarehouseSinks,
} from "@infrawrench/server-core/cost-exports/warehouse";
import { requirePermission } from "../../auth/permissions";
import { logAudit } from "../../services/audit";
import type { AuthSession } from "../auth-middleware";

declare module "hono" {
  interface ContextVariableMap {
    session: AuthSession;
  }
}

const app = new Hono();

const filterSchema = z.object({
  dimension: z.enum(COST_DIMENSIONS),
  op: z.enum(["in", "not_in"]),
  values: z.array(z.string().max(512)).min(1).max(500),
  tagKey: z.string().max(255).optional(),
});

const querySchema = z.object({
  version: z.literal(1),
  dimensions: z.array(z.enum(COST_DIMENSIONS)).max(8),
  tagKeys: z.array(z.string().min(1).max(255)).max(25),
  virtualTagKeys: z.array(z.string().min(1).max(64)).max(25).optional(),
  filters: z.array(filterSchema).max(25),
  chargeTypes: z.array(z.enum(COST_CHARGE_TYPES)).optional(),
  costBasis: z.enum(["cash", "amortized"]).optional(),
});

const destinationSchema = z.union([
  z.object({
    kind: z.literal("s3"),
    bucket: z.string().min(1).max(255),
    prefix: z.string().max(512),
    region: z.string().max(64),
    endpoint: z.string().max(255),
    forcePathStyle: z.boolean(),
  }),
  z.object({
    kind: z.literal("http"),
    method: z.enum(["POST", "PUT"]),
    // Echoed back from a GET; the server recomputes it whenever a URL is
    // supplied, so a client cannot use it to claim a destination it has not
    // proved it holds the URL for.
    urlHint: z.string().max(255).optional(),
  }),
  z.object({
    kind: z.literal("warehouse"),
    pluginId: z.string().min(1).max(64),
    accountId: z.string().min(1).max(128),
    target: z.record(z.string(), z.string().max(255)),
  }),
]);

const warehouseTargetSchema = z.record(z.string().max(64), z.string().max(255));

const warehouseOptionsSchema = z.object({
  accountId: z.string().min(1).max(128),
  field: z.string().min(1).max(64),
  target: warehouseTargetSchema.default({}),
});

const warehouseSetupSchema = z.object({
  accountId: z.string().min(1).max(128),
  target: warehouseTargetSchema.default({}),
});

/** Non-secret one-liner for the audit log: bucket, URL hint, or table. */
function destinationSummary(d: CostExportInput["destination"]): string {
  if (d.kind === "s3") return `${d.bucket}/${d.prefix}`;
  if (d.kind === "http") return d.urlHint;
  return `${d.pluginId}:${Object.values(d.target).join(".")}`;
}

const inputSchema = z.object({
  name: z.string().min(1).max(120),
  format: z.enum(COST_EXPORT_FORMATS),
  /** Omitted keeps the stored layout (`native` on create). */
  schema: z.enum(COST_EXPORT_SCHEMAS).optional(),
  query: querySchema,
  cadence: z.enum(COST_EXPORT_CADENCES),
  hour: z.number().int().min(0).max(23),
  timezone: z.string().min(1).max(64),
  restatementDays: z.number().int().min(0).max(90),
  enabled: z.boolean(),
  destination: destinationSchema,
  /** Write-only. Omitted on update means "keep the stored credential". */
  accessKeyId: z.string().min(1).max(255).optional(),
  secretAccessKey: z.string().min(1).max(1024).optional(),
  url: z.string().min(1).max(2048).optional(),
});

/** Map a store-level validation failure onto a status the client can branch on. */
function inputFailure(err: unknown): { message: string; status: 400 | 404 } | null {
  if (err instanceof CostExportInputError) return { message: err.message, status: err.status };
  return null;
}

/** GET /api/org/:orgId/cost-exports: every export, redacted. */
app.get("/", async (c) => {
  requirePermission(c, "costs:read");
  return c.json(await listCostExports(c.get("organizationId")));
});

/**
 * GET /api/org/:orgId/cost-exports/warehouse-sinks: the destination types a
 * connected account can provide (Snowflake, Databricks), with the org's
 * accounts of each and the fields to pick. Registered before `/:id`.
 */
app.get("/warehouse-sinks", async (c) => {
  requirePermission(c, "org:settings:write");
  return c.json({ sinks: await listWarehouseSinks(c.get("organizationId")) });
});

/**
 * POST /api/org/:orgId/cost-exports/warehouse-options: picker options for one
 * target field, read live from the provider with the account's credentials.
 * A provider refusal (bad grant, no warehouse) is a 400 carrying its message,
 * because the user can act on it and the form falls back to typing.
 */
app.post("/warehouse-options", async (c) => {
  requirePermission(c, "org:settings:write");
  const parsed = warehouseOptionsSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: "Invalid request", issues: parsed.error.issues }, 400);
  }
  try {
    const options = await listWarehouseOptions(
      c.get("organizationId"),
      parsed.data.accountId,
      parsed.data.field,
      parsed.data.target,
    );
    return c.json({ options });
  } catch (err) {
    // A WarehouseDestinationError or the provider's own refusal: both are
    // things the user can act on, and the form falls back to typing.
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
});

/**
 * POST /api/org/:orgId/cost-exports/warehouse-setup: the least-privilege GRANT
 * statements for a target, personalised with the account's role or principal.
 */
app.post("/warehouse-setup", async (c) => {
  requirePermission(c, "org:settings:write");
  const parsed = warehouseSetupSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: "Invalid request", issues: parsed.error.issues }, 400);
  }
  try {
    return c.json(
      await describeWarehouseSetup(
        c.get("organizationId"),
        parsed.data.accountId,
        parsed.data.target,
      ),
    );
  } catch (err) {
    // A WarehouseDestinationError or the provider's own refusal: both are
    // things the user can act on, and the form falls back to typing.
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
});

/** GET /api/org/:orgId/cost-exports/:id */
app.get("/:id", async (c) => {
  requirePermission(c, "costs:read");
  const found = await getCostExport(c.get("organizationId"), c.req.param("id"));
  if (!found) return c.json({ error: "Not found" }, 404);
  return c.json(found);
});

/** POST /api/org/:orgId/cost-exports: create. Credentials are required here. */
app.post("/", async (c) => {
  requirePermission(c, "org:settings:write");
  const organizationId = c.get("organizationId");
  const session = c.get("session");

  const parsed = inputSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: "Invalid cost export", issues: parsed.error.issues }, 400);
  }

  try {
    const created = await createCostExport(
      organizationId,
      parsed.data as CostExportInput,
      session.userId ?? null,
    );
    void logAudit({
      organizationId,
      userId: session.userId,
      action: "cost_export.create",
      entityType: "cost_export",
      entityId: created.id,
      // Destination and schedule, never the credential: the audit log is
      // readable by every holder of `audit:read`.
      metadata: {
        name: created.name,
        format: created.format,
        schema: created.schema,
        cadence: created.cadence,
        destinationKind: created.destination.kind,
        destination: destinationSummary(created.destination),
      },
    });
    return c.json(created);
  } catch (err) {
    const failure = inputFailure(err);
    if (failure) return c.json({ error: failure.message }, failure.status);
    throw err;
  }
});

/** PUT /api/org/:orgId/cost-exports/:id: replace everything but the credential. */
app.put("/:id", async (c) => {
  requirePermission(c, "org:settings:write");
  const organizationId = c.get("organizationId");
  const session = c.get("session");
  const id = c.req.param("id");

  const parsed = inputSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: "Invalid cost export", issues: parsed.error.issues }, 400);
  }

  try {
    const updated = await updateCostExport(organizationId, id, parsed.data as CostExportInput);
    if (!updated) return c.json({ error: "Not found" }, 404);
    void logAudit({
      organizationId,
      userId: session.userId,
      action: "cost_export.update",
      entityType: "cost_export",
      entityId: id,
      metadata: {
        name: updated.name,
        schema: updated.schema,
        cadence: updated.cadence,
        enabled: updated.enabled,
        destinationKind: updated.destination.kind,
        credentialChanged: parsed.data.accessKeyId !== undefined || parsed.data.url !== undefined,
      },
    });
    return c.json(updated);
  } catch (err) {
    const failure = inputFailure(err);
    if (failure) return c.json({ error: failure.message }, failure.status);
    throw err;
  }
});

/** DELETE /api/org/:orgId/cost-exports/:id: soft delete; objects already written stay. */
app.delete("/:id", async (c) => {
  requirePermission(c, "org:settings:write");
  const organizationId = c.get("organizationId");
  const session = c.get("session");
  const id = c.req.param("id");

  const deleted = await deleteCostExport(organizationId, id);
  if (!deleted) return c.json({ error: "Not found" }, 404);
  void logAudit({
    organizationId,
    userId: session.userId,
    action: "cost_export.delete",
    entityType: "cost_export",
    entityId: id,
    metadata: {},
  });
  return c.json({ ok: true });
});

/**
 * POST /api/org/:orgId/cost-exports/:id/run: run it now.
 *
 * A write, not a read: it pushes org spend to an external destination, which is
 * the whole thing `org:settings:write` is gating here. Answers 200 with the
 * run's own `status` even when it failed: the caller wants the error rendered,
 * and the same failure is already recorded on the row for the next page load.
 */
app.post("/:id/run", async (c) => {
  requirePermission(c, "org:settings:write");
  const organizationId = c.get("organizationId");
  const session = c.get("session");
  const id = c.req.param("id");

  const row = await getCostExportRow(organizationId, id);
  if (!row) return c.json({ error: "Not found" }, 404);

  const result = await runCostExport(row);
  void logAudit({
    organizationId,
    userId: session.userId,
    action: "cost_export.run",
    entityType: "cost_export",
    entityId: id,
    metadata: {
      status: result.status,
      objectCount: result.objects.length,
      rowCount: result.rowCount,
      ...(result.error ? { error: result.error } : {}),
    },
  });
  return c.json(result);
});

export { app as costExportRoutes };
