import { Hono, type Context } from "hono";

import {
  AiAttributionInputError,
  createAiDimension,
  createAiRequestSource,
  deleteAiDimension,
  deleteAiRequestSource,
  getAiRequestSource,
  listAiDimensions,
  listAiRequestSources,
  listAiSourceKindOptions,
  recollectAiRequestSource,
  updateAiDimension,
  updateAiRequestSource,
} from "@infrawrench/server-core/ai-attribution/store";
import { listAiSourceLocations } from "@infrawrench/server-core/ai-attribution/pass";
import { attributeOrgDays } from "@infrawrench/server-core/ai-attribution/run";
import {
  getAiAttributionStats,
  getAiSpendBreakdown,
} from "@infrawrench/server-core/ai-attribution/stats";
import {
  AI_DIMENSION_KEY_PATTERN,
  type AiAttributionDimensionInput,
  type AiRequestSourceInput,
} from "@infrawrench/client-core";
import { logAudit } from "../../services/audit";
import type { AuthSession } from "../auth-middleware";
import { requirePermission } from "../../auth/permissions";

declare module "hono" {
  interface ContextVariableMap {
    session: AuthSession;
  }
}

const app = new Hono();
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Default window: the trailing 30 days, like the other cost reports. */
function parseRange(c: Context): { from: string; to: string } | null {
  const today = new Date().toISOString().slice(0, 10);
  const defaultFrom = new Date(Date.now() - 29 * 86_400_000).toISOString().slice(0, 10);
  const from = c.req.query("from") ?? defaultFrom;
  const to = c.req.query("to") ?? today;
  if (!ISO_DAY.test(from) || !ISO_DAY.test(to) || from > to) return null;
  if (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`) > 400 * 86_400_000) {
    return null;
  }
  return { from, to };
}

function inputError(c: Context, e: unknown) {
  if (e instanceof AiAttributionInputError) return c.json({ error: e.message }, e.status);
  throw e;
}

function parseSourceInput(body: Record<string, unknown>): AiRequestSourceInput | string {
  if (typeof body["name"] !== "string") return "name must be a string";
  if (body["kind"] !== "plugin" && body["kind"] !== "litellm") {
    return 'kind must be "plugin" or "litellm"';
  }
  if (typeof body["sourceKindId"] !== "string") return "sourceKindId must be a string";
  const location = body["location"] ?? {};
  if (typeof location !== "object" || location === null || Array.isArray(location)) {
    return "location must be an object of strings";
  }
  if (typeof body["enabled"] !== "boolean") return "enabled must be a boolean";
  if (typeof body["lookbackDays"] !== "number") return "lookbackDays must be a number";
  return {
    name: body["name"],
    kind: body["kind"],
    accountId: typeof body["accountId"] === "string" ? body["accountId"] : null,
    sourceKindId: body["sourceKindId"],
    location: location as Record<string, string>,
    enabled: body["enabled"],
    lookbackDays: body["lookbackDays"],
    baseUrl: typeof body["baseUrl"] === "string" ? body["baseUrl"] : null,
    ...(typeof body["apiKey"] === "string" && body["apiKey"] ? { apiKey: body["apiKey"] } : {}),
  };
}

function parseDimensionInput(body: Record<string, unknown>): AiAttributionDimensionInput | string {
  if (typeof body["key"] !== "string") return "key must be a string";
  if (typeof body["label"] !== "string") return "label must be a string";
  const keys = body["metadataKeys"];
  if (!Array.isArray(keys) || keys.some((k) => typeof k !== "string")) {
    return "metadataKeys must be an array of strings";
  }
  return { key: body["key"], label: body["label"], metadataKeys: keys as string[] };
}

/* ---------------------------- sources ---------------------------- */

/** GET /source-kinds: what can be added, with the accounts that can supply each. */
app.get("/source-kinds", async (c: Context) => {
  requirePermission(c, "costs:read");
  return c.json({ sourceKinds: await listAiSourceKindOptions(c.get("organizationId") as string) });
});

/**
 * GET /locations?accountId&sourceKindId: the location picker, discovered by
 * the owning plugin (Bedrock's configured log bucket and group, the account's
 * buckets, its AI gateways). `org:settings:write` because it reads the
 * account's inventory to configure a source.
 */
app.get("/locations", async (c: Context) => {
  requirePermission(c, "org:settings:write");
  const accountId = c.req.query("accountId");
  const sourceKindId = c.req.query("sourceKindId");
  if (!accountId || !sourceKindId) {
    return c.json({ error: "accountId and sourceKindId are required" }, 400);
  }
  try {
    const locations = await listAiSourceLocations(
      c.get("organizationId") as string,
      accountId,
      sourceKindId,
    );
    return c.json({ locations });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (message === "Account not found") return c.json({ error: message }, 404);
    return c.json({ error: `Could not list locations: ${message}` }, 502);
  }
});

app.get("/sources", async (c: Context) => {
  requirePermission(c, "costs:read");
  return c.json({ sources: await listAiRequestSources(c.get("organizationId") as string) });
});

app.get("/sources/:id", async (c: Context) => {
  requirePermission(c, "costs:read");
  const source = await getAiRequestSource(c.get("organizationId") as string, c.req.param("id")!);
  if (!source) return c.json({ error: "source not found" }, 404);
  return c.json(source);
});

/**
 * POST /sources. `org:settings:write`, not `costs:write`: a source authorizes a
 * daily read of the org's request logs and, for the CloudWatch kind, a query
 * billed to the org's own AWS account. Audit-logged.
 */
app.post("/sources", async (c: Context) => {
  requirePermission(c, "org:settings:write");
  const organizationId = c.get("organizationId") as string;
  const session = c.get("session");
  const parsed = parseSourceInput((await c.req.json()) as Record<string, unknown>);
  if (typeof parsed === "string") return c.json({ error: parsed }, 400);
  try {
    const source = await createAiRequestSource(organizationId, session.userId ?? null, parsed);
    void logAudit({
      organizationId,
      userId: session.userId,
      action: "ai_request_source.create",
      entityType: "ai_request_source",
      entityId: source.id,
      metadata: { name: source.name, kind: source.kind, sourceKindId: source.sourceKindId },
    });
    return c.json(source, 201);
  } catch (e) {
    return inputError(c, e);
  }
});

app.put("/sources/:id", async (c: Context) => {
  requirePermission(c, "org:settings:write");
  const organizationId = c.get("organizationId") as string;
  const session = c.get("session");
  const parsed = parseSourceInput((await c.req.json()) as Record<string, unknown>);
  if (typeof parsed === "string") return c.json({ error: parsed }, 400);
  try {
    const source = await updateAiRequestSource(organizationId, c.req.param("id")!, parsed);
    void logAudit({
      organizationId,
      userId: session.userId,
      action: "ai_request_source.update",
      entityType: "ai_request_source",
      entityId: source.id,
      metadata: { name: source.name, enabled: source.enabled },
    });
    return c.json(source);
  } catch (e) {
    return inputError(c, e);
  }
});

app.delete("/sources/:id", async (c: Context) => {
  requirePermission(c, "org:settings:write");
  const organizationId = c.get("organizationId") as string;
  const id = c.req.param("id")!;
  const ok = await deleteAiRequestSource(organizationId, id);
  if (!ok) return c.json({ error: "source not found" }, 404);
  void logAudit({
    organizationId,
    userId: c.get("session").userId,
    action: "ai_request_source.delete",
    entityType: "ai_request_source",
    entityId: id,
  });
  return c.json({ ok: true });
});

/** POST /sources/:id/recollect { from }: re-read history after a mapping change. */
app.post("/sources/:id/recollect", async (c: Context) => {
  requirePermission(c, "org:settings:write");
  const organizationId = c.get("organizationId") as string;
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const from = typeof body["from"] === "string" ? body["from"] : "";
  try {
    const source = await recollectAiRequestSource(organizationId, c.req.param("id")!, from);
    void logAudit({
      organizationId,
      userId: c.get("session").userId,
      action: "ai_request_source.recollect",
      entityType: "ai_request_source",
      entityId: source.id,
      metadata: { from },
    });
    return c.json(source);
  } catch (e) {
    return inputError(c, e);
  }
});

/* --------------------------- dimensions -------------------------- */

app.get("/dimensions", async (c: Context) => {
  requirePermission(c, "costs:read");
  return c.json({ dimensions: await listAiDimensions(c.get("organizationId") as string) });
});

/**
 * Dimension writes are `costs:write`: a mapping changes how spend is labelled
 * in reports, like a cost centre or an allocation rule, and authorizes no new
 * reads of anything.
 */
app.post("/dimensions", async (c: Context) => {
  requirePermission(c, "costs:write");
  const organizationId = c.get("organizationId") as string;
  const parsed = parseDimensionInput((await c.req.json()) as Record<string, unknown>);
  if (typeof parsed === "string") return c.json({ error: parsed }, 400);
  try {
    const dim = await createAiDimension(organizationId, parsed);
    void logAudit({
      organizationId,
      userId: c.get("session").userId,
      action: "ai_dimension.create",
      entityType: "ai_dimension",
      entityId: dim.id,
      metadata: { key: dim.key, metadataKeys: dim.metadataKeys },
    });
    return c.json(dim, 201);
  } catch (e) {
    return inputError(c, e);
  }
});

app.put("/dimensions/:id", async (c: Context) => {
  requirePermission(c, "costs:write");
  const organizationId = c.get("organizationId") as string;
  const parsed = parseDimensionInput((await c.req.json()) as Record<string, unknown>);
  if (typeof parsed === "string") return c.json({ error: parsed }, 400);
  try {
    const dim = await updateAiDimension(organizationId, c.req.param("id")!, parsed);
    void logAudit({
      organizationId,
      userId: c.get("session").userId,
      action: "ai_dimension.update",
      entityType: "ai_dimension",
      entityId: dim.id,
      metadata: { key: dim.key, metadataKeys: dim.metadataKeys },
    });
    return c.json(dim);
  } catch (e) {
    return inputError(c, e);
  }
});

app.delete("/dimensions/:id", async (c: Context) => {
  requirePermission(c, "costs:write");
  const organizationId = c.get("organizationId") as string;
  const id = c.req.param("id")!;
  const ok = await deleteAiDimension(organizationId, id);
  if (!ok) return c.json({ error: "dimension not found" }, 404);
  void logAudit({
    organizationId,
    userId: c.get("session").userId,
    action: "ai_dimension.delete",
    entityType: "ai_dimension",
    entityId: id,
  });
  return c.json({ ok: true });
});

/* ------------------------ stats and spend ------------------------ */

app.get("/stats", async (c: Context) => {
  requirePermission(c, "costs:read");
  const range = parseRange(c);
  if (!range)
    return c.json({ error: "from/to must be YYYY-MM-DD, from <= to, at most 400 days" }, 400);
  return c.json(
    await getAiAttributionStats(c.get("organizationId") as string, range.from, range.to),
  );
});

app.get("/spend", async (c: Context) => {
  requirePermission(c, "costs:read");
  const range = parseRange(c);
  if (!range)
    return c.json({ error: "from/to must be YYYY-MM-DD, from <= to, at most 400 days" }, 400);
  const dimension = c.req.query("dimension") ?? "";
  if (!AI_DIMENSION_KEY_PATTERN.test(dimension)) {
    return c.json({ error: "dimension must be a dimension key" }, 400);
  }
  return c.json(
    await getAiSpendBreakdown(c.get("organizationId") as string, dimension, range.from, range.to),
  );
});

/**
 * POST /reattribute { from, to }: re-split a range now (after editing a
 * mapping, say) instead of waiting for the next collection. Bounded to 92 days.
 */
app.post("/reattribute", async (c: Context) => {
  requirePermission(c, "costs:write");
  const organizationId = c.get("organizationId") as string;
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const from = typeof body["from"] === "string" ? body["from"] : "";
  const to = typeof body["to"] === "string" ? body["to"] : "";
  if (!ISO_DAY.test(from) || !ISO_DAY.test(to) || from > to) {
    return c.json({ error: "from/to must be YYYY-MM-DD with from <= to" }, 400);
  }
  const days: string[] = [];
  for (
    let t = Date.parse(`${from}T00:00:00Z`);
    t <= Date.parse(`${to}T00:00:00Z`);
    t += 86_400_000
  ) {
    days.push(new Date(t).toISOString().slice(0, 10));
    if (days.length > 92) return c.json({ error: "at most 92 days at a time" }, 400);
  }
  await attributeOrgDays(organizationId, days);
  return c.json({ ok: true, days: days.length });
});

export { app as aiAttributionRoutes };
