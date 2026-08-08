import { Hono, type Context } from "hono";
import { and, eq, isNull } from "drizzle-orm";
import { normalizeProbeUrl, type ProbeSuggestion } from "@infrawrench/client-core";
import { db } from "../../db/client";
import { resources } from "../../db/schema";
import {
  getMetricRange,
  getMetricSeriesAverageBatch,
} from "@infrawrench/server-core/clickhouse/readers";
import {
  ProbeInputError,
  createProbeRecord,
  deleteProbeRecord,
  getProbeRecord,
  listProbeRecords,
  updateProbeRecord,
  type ProbeCreateInput,
  type ProbeRecord,
  type ProbeUpdateInput,
} from "@infrawrench/server-core/probes/store";
import { probeMetricResourceId } from "@infrawrench/server-core/probes/metric-ids";
import { requirePermission } from "../../auth/permissions";
import { logAudit } from "../../services/audit";
import type { AuthSession } from "../auth-middleware";

/**
 * Synthetic probes — HTTP uptime/latency checks run on an interval from the
 * egress-proxy Worker (an external vantage point). Execution happens in the
 * poller (`server-core/src/probes/pass.ts`); these routes manage the rows,
 * mine endpoint suggestions from synced resource outputs, and read the
 * recorded series back out of ClickHouse.
 *
 * Permissions follow the schedules stance: reads are `resources:read` (the
 * suggestions list is derived from the org's resource set), mutations are
 * `resources:write` — a probe is a standing instruction to poll an endpoint
 * the org's resources expose.
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

function probeErrorResponse(c: Context, err: unknown) {
  if (err instanceof ProbeInputError) {
    return c.json({ error: err.message }, err.status);
  }
  console.error("[probes] unexpected error:", err);
  return c.json({ error: "Probe operation failed" }, 500);
}

/** Row → wire shape (`SyntheticProbe` in client-core). */
function toWire(row: ProbeRecord, uptime24h: number | null) {
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    method: row.method,
    intervalSeconds: row.intervalSeconds,
    timeoutMs: row.timeoutMs,
    failureThreshold: row.failureThreshold,
    enabled: row.enabled,
    accountId: row.accountId,
    resourceId: row.resourceId,
    pluginId: row.pluginId,
    resourceTypeId: row.resourceTypeId,
    outputKey: row.outputKey,
    status: row.status,
    consecutiveFailures: row.consecutiveFailures,
    lastProbeAt: row.lastProbeAt?.toISOString() ?? null,
    lastStatusCode: row.lastStatusCode,
    lastLatencyMs: row.lastLatencyMs,
    lastError: row.lastError,
    lastStateChangeAt: row.lastStateChangeAt?.toISOString() ?? null,
    uptime24h,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Trailing-24h uptime per probe from the recorded "Up" series. Best-effort:
 * a ClickHouse outage costs the uptime column, never the list.
 */
async function uptimeByProbe(
  organizationId: string,
  rows: ProbeRecord[],
): Promise<Map<string, number>> {
  if (rows.length === 0) return new Map();
  try {
    const now = Date.now();
    const byResourceId = await getMetricSeriesAverageBatch(
      organizationId,
      rows.map((r) => probeMetricResourceId(r.id)),
      "Up",
      now - 24 * 60 * 60 * 1000,
      now,
    );
    const out = new Map<string, number>();
    for (const row of rows) {
      const value = byResourceId.get(probeMetricResourceId(row.id));
      if (value !== undefined) out.set(row.id, value);
    }
    return out;
  } catch (err) {
    console.error("[probes] uptime read failed:", err);
    return new Map();
  }
}

app.get("/", async (c) => {
  requirePermission(c, "resources:read");
  const organizationId = c.get("organizationId");
  const rows = await listProbeRecords(organizationId);
  const uptime = await uptimeByProbe(organizationId, rows);
  return c.json({ probes: rows.map((row) => toWire(row, uptime.get(row.id) ?? null)) });
});

/**
 * Output/field keys that plausibly name a reachable endpoint. Order matters:
 * for one resource the first key with a usable value wins per URL, so "url"
 * beats a bare "host" when both resolve to the same endpoint.
 */
const SUGGESTION_KEYS = [
  "url",
  "endpoint",
  "host",
  "hostname",
  "domain",
  "publicIp",
  "ipv4",
] as const;

const MAX_SUGGESTIONS = 100;

/**
 * Turn one output value into an absolute URL, or null when it can't name an
 * endpoint. Bare hosts and IPs get `https://` — the safe default; the user
 * can edit the URL before saving.
 */
function suggestionUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || /\s/.test(trimmed)) return null;
  const candidate = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  const normalized = normalizeProbeUrl(candidate);
  if ("error" in normalized) return null;
  // A single-label host (a k8s service name, "localhost") can't be reached
  // from the edge proxy anyway — only suggest hosts with a dot in them.
  const host = new URL(normalized.url).hostname;
  if (!host.includes(".")) return null;
  return normalized.url;
}

/**
 * Endpoint candidates mined from the org's synced resources — a cheap
 * Postgres read over the `outputs_json`/`fields_json` caches (the
 * `expiry/feed.ts` stance: no plugin clients, no credentials, no provider
 * calls). Deduped by URL, first resource wins.
 */
app.get("/suggestions", async (c) => {
  requirePermission(c, "resources:read");
  const organizationId = c.get("organizationId");
  const rows = await db
    .select({
      id: resources.id,
      displayName: resources.displayName,
      accountId: resources.accountId,
      pluginId: resources.pluginId,
      resourceTypeId: resources.resourceTypeId,
      fieldsJson: resources.fieldsJson,
      outputsJson: resources.outputsJson,
    })
    .from(resources)
    .where(and(eq(resources.organizationId, organizationId), isNull(resources.deletedAt)));

  const seen = new Set<string>();
  const suggestions: ProbeSuggestion[] = [];
  for (const row of rows) {
    // Outputs first: they are resolved values; fields may hold raw config.
    const sources: Record<string, unknown> = { ...row.fieldsJson, ...row.outputsJson };
    for (const key of SUGGESTION_KEYS) {
      const url = suggestionUrl(sources[key]);
      if (!url || seen.has(url)) continue;
      seen.add(url);
      suggestions.push({
        url,
        resourceId: row.id,
        displayName: row.displayName,
        pluginId: row.pluginId,
        resourceTypeId: row.resourceTypeId,
        accountId: row.accountId,
        outputKey: key,
      });
      if (suggestions.length >= MAX_SUGGESTIONS) break;
    }
    if (suggestions.length >= MAX_SUGGESTIONS) break;
  }
  return c.json({ suggestions });
});

app.post("/", async (c) => {
  requirePermission(c, "resources:write");
  const organizationId = c.get("organizationId");
  const session = c.get("session");
  const { body, error } = await parseObjectBody(c);
  if (error) return error;
  if (typeof body["name"] !== "string" || typeof body["url"] !== "string") {
    return c.json({ error: "name and url are required" }, 400);
  }

  const input: ProbeCreateInput = {
    name: body["name"],
    url: body["url"],
    ...(typeof body["method"] === "string" ? { method: body["method"] } : {}),
    ...(typeof body["intervalSeconds"] === "number"
      ? { intervalSeconds: body["intervalSeconds"] }
      : {}),
    ...(typeof body["timeoutMs"] === "number" ? { timeoutMs: body["timeoutMs"] } : {}),
    ...(typeof body["failureThreshold"] === "number"
      ? { failureThreshold: body["failureThreshold"] }
      : {}),
    ...(typeof body["enabled"] === "boolean" ? { enabled: body["enabled"] } : {}),
    ...(typeof body["resourceId"] === "string" ? { resourceId: body["resourceId"] } : {}),
    ...(typeof body["outputKey"] === "string" ? { outputKey: body["outputKey"] } : {}),
  };
  try {
    const created = await createProbeRecord(organizationId, input, session?.userId);
    void logAudit({
      organizationId,
      userId: session?.userId,
      action: "probe.create",
      entityType: "synthetic_probe",
      entityId: created.id,
      metadata: {
        name: created.name,
        url: created.url,
        intervalSeconds: created.intervalSeconds,
        failureThreshold: created.failureThreshold,
        resourceId: created.resourceId,
      },
    });
    return c.json(toWire(created, null), 201);
  } catch (err) {
    return probeErrorResponse(c, err);
  }
});

app.put("/:id", async (c) => {
  requirePermission(c, "resources:write");
  const organizationId = c.get("organizationId");
  const session = c.get("session");
  const probeId = c.req.param("id");
  const { body, error } = await parseObjectBody(c);
  if (error) return error;

  const patch: ProbeUpdateInput = {
    ...(typeof body["name"] === "string" ? { name: body["name"] } : {}),
    ...(typeof body["url"] === "string" ? { url: body["url"] } : {}),
    ...(typeof body["method"] === "string" ? { method: body["method"] } : {}),
    ...(typeof body["intervalSeconds"] === "number"
      ? { intervalSeconds: body["intervalSeconds"] }
      : {}),
    ...(typeof body["timeoutMs"] === "number" ? { timeoutMs: body["timeoutMs"] } : {}),
    ...(typeof body["failureThreshold"] === "number"
      ? { failureThreshold: body["failureThreshold"] }
      : {}),
    ...(typeof body["enabled"] === "boolean" ? { enabled: body["enabled"] } : {}),
  };
  if (Object.keys(patch).length === 0) return c.json({ error: "No changes supplied" }, 400);

  try {
    const updated = await updateProbeRecord(organizationId, probeId, patch);
    void logAudit({
      organizationId,
      userId: session?.userId,
      action: "probe.update",
      entityType: "synthetic_probe",
      entityId: updated.id,
      metadata: { name: updated.name, patch: patch as Record<string, unknown> },
    });
    const uptime = await uptimeByProbe(organizationId, [updated]);
    return c.json(toWire(updated, uptime.get(updated.id) ?? null));
  } catch (err) {
    return probeErrorResponse(c, err);
  }
});

app.delete("/:id", async (c) => {
  requirePermission(c, "resources:write");
  const organizationId = c.get("organizationId");
  const session = c.get("session");
  const probeId = c.req.param("id");
  try {
    const deleted = await deleteProbeRecord(organizationId, probeId);
    void logAudit({
      organizationId,
      userId: session?.userId,
      action: "probe.delete",
      entityType: "synthetic_probe",
      entityId: deleted.id,
      metadata: { name: deleted.name, url: deleted.url },
    });
    return c.body(null, 204);
  } catch (err) {
    return probeErrorResponse(c, err);
  }
});

/** The recorded Latency/Up series — straight out of the shared metric store. */
app.get("/:id/metrics", async (c) => {
  requirePermission(c, "resources:read");
  const organizationId = c.get("organizationId");
  const probeId = c.req.param("id");
  const probe = await getProbeRecord(organizationId, probeId);
  if (!probe) return c.json({ error: "Probe not found" }, 404);

  const now = Date.now();
  const startMs = Number(c.req.query("startMs") ?? now - 24 * 60 * 60 * 1000);
  const endMs = Number(c.req.query("endMs") ?? now);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs >= endMs) {
    return c.json({ error: "startMs and endMs must be a valid epoch-ms range" }, 400);
  }

  try {
    const series = await getMetricRange(
      organizationId,
      probeMetricResourceId(probe.id),
      startMs,
      endMs,
    );
    return c.json({ series });
  } catch (err) {
    console.error("[probes] metrics read failed:", err);
    return c.json({ error: "Metric store unavailable" }, 503);
  }
});

export { app as probeRoutes };
