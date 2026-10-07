import { Hono, type Context } from "hono";
import { and, eq, isNull, inArray } from "drizzle-orm";
import {
  SLO_COMPARATORS,
  SLO_FREEZE_DURATIONS_HOURS,
  SLO_SLI_KINDS,
  type SloInput,
  type SloMetricResourceOption,
  type SloSourcesResponse,
} from "@infrawrench/client-core";
import { db } from "../../db/client";
import { resources, syntheticProbes } from "../../db/schema";
import {
  getSloHourlyBuckets,
  listResourceMetricSeries,
} from "@infrawrench/server-core/clickhouse/slo-readers";
import {
  SloInputError,
  createSloRecord,
  deleteSloRecord,
  getSloRecord,
  listSlosWire,
  loadSloSourceLabels,
  sloToWire,
  updateSloRecord,
} from "@infrawrench/server-core/slos/store";
import { sloMetricTarget } from "@infrawrench/server-core/slos/eval";
import { requirePermission } from "../../auth/permissions";
import { logAudit } from "../../services/audit";
import { createChangeFreeze, getActiveChangeFreeze } from "../../services/change-freezes";
import type { AuthSession } from "../auth-middleware";
import { parseObjectBody } from "../object-body";

/**
 * Service-level objectives over the metric store: CRUD, the editor's source
 * pickers, the detail read with its hourly history, and the "start a change
 * freeze" suggestion for an exhausted budget. Evaluation and alerting happen
 * in the poller (`server-core/src/slos/`).
 *
 * Permissions follow the probes stance: reads are `resources:read`, writes
 * `resources:write`. Starting a freeze additionally takes `freezes:write`,
 * checked here, because the SLO page is only where the suggestion is made:
 * freezing the org is the same decision wherever the button lives.
 */

declare module "hono" {
  interface ContextVariableMap {
    session: AuthSession;
  }
}

const app = new Hono();

function sloErrorResponse(c: Context, err: unknown) {
  if (err instanceof SloInputError) return c.json({ error: err.message }, err.status);
  console.error("[slos] unexpected error:", err);
  return c.json({ error: "SLO operation failed" }, 500);
}

/** Pick the known fields off a request body, type-checked; unknown keys are ignored. */
function pickSloBody(body: Record<string, unknown>): Partial<SloInput> {
  const out: Partial<SloInput> = {};
  const str = (k: string) => (typeof body[k] === "string" ? (body[k] as string) : undefined);
  const strOrNull = (k: string) =>
    body[k] === null ? null : typeof body[k] === "string" ? (body[k] as string) : undefined;
  const numOrNull = (k: string) =>
    body[k] === null ? null : typeof body[k] === "number" ? (body[k] as number) : undefined;
  const bool = (k: string) => (typeof body[k] === "boolean" ? (body[k] as boolean) : undefined);

  const name = str("name");
  if (name !== undefined) out.name = name;
  const description = strOrNull("description");
  if (description !== undefined) out.description = description;
  const kind = str("sliKind");
  if (kind !== undefined) out.sliKind = kind as SloInput["sliKind"];
  const probeId = strOrNull("probeId");
  if (probeId !== undefined) out.probeId = probeId;
  const latency = numOrNull("latencyThresholdMs");
  if (latency !== undefined) out.latencyThresholdMs = latency;
  const resourceId = strOrNull("resourceId");
  if (resourceId !== undefined) out.resourceId = resourceId;
  const metricKey = strOrNull("metricKey");
  if (metricKey !== undefined) out.metricKey = metricKey;
  const comparator = strOrNull("comparator");
  if (comparator !== undefined) out.comparator = comparator as SloInput["comparator"];
  const threshold = numOrNull("threshold");
  if (threshold !== undefined) out.threshold = threshold;
  if (typeof body["targetPercent"] === "number") out.targetPercent = body["targetPercent"];
  if (typeof body["windowDays"] === "number") {
    out.windowDays = body["windowDays"] as SloInput["windowDays"];
  }
  const alertsEnabled = bool("alertsEnabled");
  if (alertsEnabled !== undefined) out.alertsEnabled = alertsEnabled;
  const suggestFreeze = bool("suggestFreeze");
  if (suggestFreeze !== undefined) out.suggestFreeze = suggestFreeze;
  const enabled = bool("enabled");
  if (enabled !== undefined) out.enabled = enabled;
  return out;
}

/** Reject values the closed sets do not contain before they reach validation's prose. */
function closedSetProblem(input: Partial<SloInput>): string | null {
  if (input.sliKind !== undefined && !SLO_SLI_KINDS.includes(input.sliKind)) {
    return `sliKind must be one of ${SLO_SLI_KINDS.join(", ")}`;
  }
  if (
    input.comparator !== undefined &&
    input.comparator !== null &&
    !SLO_COMPARATORS.includes(input.comparator)
  ) {
    return `comparator must be one of ${SLO_COMPARATORS.join(", ")}`;
  }
  return null;
}

app.get("/", async (c) => {
  requirePermission(c, "resources:read");
  return c.json({ slos: await listSlosWire(c.get("organizationId")) });
});

/**
 * What an SLO can be measured from: every probe, and every synced resource
 * that reported a metric series in the last week with the series it reported.
 * The editor builds both pickers from this, so nobody types a probe id or an
 * internal series label.
 */
app.get("/sources", async (c) => {
  requirePermission(c, "resources:read");
  const organizationId = c.get("organizationId");
  const probes = await db
    .select({
      id: syntheticProbes.id,
      name: syntheticProbes.name,
      url: syntheticProbes.url,
      status: syntheticProbes.status,
    })
    .from(syntheticProbes)
    .where(eq(syntheticProbes.organizationId, organizationId))
    .orderBy(syntheticProbes.name);

  let metricResources: SloMetricResourceOption[] = [];
  try {
    const series = await listResourceMetricSeries(organizationId);
    const ids = [...new Set(series.map((s) => s.resourceId))];
    const rows = ids.length
      ? await db
          .select({
            id: resources.id,
            displayName: resources.displayName,
            accountId: resources.accountId,
            pluginId: resources.pluginId,
            resourceTypeId: resources.resourceTypeId,
          })
          .from(resources)
          .where(
            and(
              eq(resources.organizationId, organizationId),
              inArray(resources.id, ids),
              isNull(resources.deletedAt),
            ),
          )
      : [];
    const byId = new Map(rows.map((r) => [r.id, r]));
    const grouped = new Map<string, SloMetricResourceOption>();
    for (const s of series) {
      const row = byId.get(s.resourceId);
      if (!row) continue; // metric history for a resource that no longer exists
      let entry = grouped.get(row.id);
      if (!entry) {
        entry = {
          resourceId: row.id,
          displayName: row.displayName,
          accountId: row.accountId,
          pluginId: row.pluginId,
          resourceTypeId: row.resourceTypeId,
          series: [],
        };
        grouped.set(row.id, entry);
      }
      entry.series.push({ label: s.label, unit: s.unit });
    }
    metricResources = [...grouped.values()].sort((a, b) =>
      a.displayName.localeCompare(b.displayName),
    );
  } catch (err) {
    // Best-effort: a metric-store outage costs the metric picker, never the probes.
    console.error("[slos] metric source read failed:", err);
  }
  const response: SloSourcesResponse = { probes, metricResources };
  return c.json(response);
});

app.get("/:id", async (c) => {
  requirePermission(c, "resources:read");
  const organizationId = c.get("organizationId");
  const row = await getSloRecord(organizationId, c.req.param("id"));
  if (!row) return c.json({ error: "SLO not found" }, 404);
  const labels = await loadSloSourceLabels(organizationId, [row]);

  let buckets: Array<{ startMs: number; good: number; total: number }> = [];
  const target = sloMetricTarget(row);
  if (target) {
    try {
      const now = Date.now();
      buckets = await getSloHourlyBuckets(
        organizationId,
        target.resourceId,
        target.seriesLabel,
        target.judgement,
        now - row.windowDays * 24 * 60 * 60_000,
        now,
      );
    } catch (err) {
      console.error("[slos] history read failed:", err);
    }
  }
  const freeze = await getActiveChangeFreeze(organizationId).catch(() => null);
  return c.json({
    slo: sloToWire(row, labels),
    buckets,
    activeFreeze: freeze
      ? { id: freeze.id, name: freeze.name, endsAt: freeze.endsAt?.toISOString() ?? null }
      : null,
  });
});

app.post("/", async (c) => {
  requirePermission(c, "resources:write");
  const organizationId = c.get("organizationId");
  const session = c.get("session");
  const { body, error } = await parseObjectBody(c);
  if (error) return error;
  const input = pickSloBody(body);
  const problem = closedSetProblem(input);
  if (problem) return c.json({ error: problem }, 400);
  try {
    const created = await createSloRecord(organizationId, input, session?.userId);
    void logAudit({
      organizationId,
      userId: session?.userId,
      action: "slo.create",
      entityType: "slo",
      entityId: created.id,
      metadata: {
        name: created.name,
        sliKind: created.sliKind,
        targetPercent: created.targetPercent,
        windowDays: created.windowDays,
      },
    });
    const labels = await loadSloSourceLabels(organizationId, [created]);
    return c.json(sloToWire(created, labels), 201);
  } catch (err) {
    return sloErrorResponse(c, err);
  }
});

app.put("/:id", async (c) => {
  requirePermission(c, "resources:write");
  const organizationId = c.get("organizationId");
  const session = c.get("session");
  const { body, error } = await parseObjectBody(c);
  if (error) return error;
  const patch = pickSloBody(body);
  if (Object.keys(patch).length === 0) return c.json({ error: "No changes supplied" }, 400);
  const problem = closedSetProblem(patch);
  if (problem) return c.json({ error: problem }, 400);
  try {
    const updated = await updateSloRecord(organizationId, c.req.param("id"), patch);
    void logAudit({
      organizationId,
      userId: session?.userId,
      action: "slo.update",
      entityType: "slo",
      entityId: updated.id,
      metadata: { name: updated.name, patch: patch as Record<string, unknown> },
    });
    const labels = await loadSloSourceLabels(organizationId, [updated]);
    return c.json(sloToWire(updated, labels));
  } catch (err) {
    return sloErrorResponse(c, err);
  }
});

app.delete("/:id", async (c) => {
  requirePermission(c, "resources:write");
  const organizationId = c.get("organizationId");
  const session = c.get("session");
  try {
    const deleted = await deleteSloRecord(organizationId, c.req.param("id"));
    void logAudit({
      organizationId,
      userId: session?.userId,
      action: "slo.delete",
      entityType: "slo",
      entityId: deleted.id,
      metadata: { name: deleted.name },
    });
    return c.body(null, 204);
  } catch (err) {
    return sloErrorResponse(c, err);
  }
});

/**
 * Act on the freeze suggestion: start an org change freeze named after the
 * SLO. Uses the ordinary freeze objects (`services/change-freezes.ts`), so the
 * freeze is listed, ended and audited exactly like one made in Settings.
 */
app.post("/:id/freeze", async (c) => {
  requirePermission(c, "freezes:write");
  const organizationId = c.get("organizationId");
  const session = c.get("session");
  const row = await getSloRecord(organizationId, c.req.param("id"));
  if (!row) return c.json({ error: "SLO not found" }, 404);
  const { body, error } = await parseObjectBody(c);
  if (error) return error;
  const duration = body["durationHours"] === undefined ? null : body["durationHours"];
  if (duration !== null && (typeof duration !== "number" || !Number.isFinite(duration))) {
    return c.json({ error: "durationHours must be a number of hours or null" }, 400);
  }
  if (!SLO_FREEZE_DURATIONS_HOURS.includes(duration as number | null)) {
    return c.json(
      { error: `durationHours must be one of ${SLO_FREEZE_DURATIONS_HOURS.join(", ")}` },
      400,
    );
  }
  const reason =
    typeof body["reason"] === "string" && body["reason"].trim()
      ? body["reason"].trim().slice(0, 500)
      : `The error budget of SLO "${row.name}" is exhausted.`;
  const now = new Date();
  const freeze = await createChangeFreeze(
    organizationId,
    {
      name: `SLO budget: ${row.name}`.slice(0, 120),
      reason,
      startsAt: now,
      ...(duration === null
        ? {}
        : { endsAt: new Date(now.getTime() + (duration as number) * 60 * 60_000) }),
    },
    session?.userId ?? null,
  );
  void logAudit({
    organizationId,
    userId: session?.userId,
    action: "change_freeze.create",
    entityType: "change_freeze",
    entityId: freeze.id,
    metadata: {
      name: freeze.name,
      startsAt: freeze.startsAt.toISOString(),
      endsAt: freeze.endsAt ? freeze.endsAt.toISOString() : null,
      sloId: row.id,
    },
  });
  return c.json(
    { id: freeze.id, name: freeze.name, endsAt: freeze.endsAt?.toISOString() ?? null },
    201,
  );
});

export { app as sloRoutes };
