/**
 * Synthetic probes: `/api/org/:orgId/probes`, the handlers. Execution happens
 * in the poller (`server-core/src/probes/pass.ts`); these manage the rows,
 * mine endpoint suggestions from synced resource outputs, and read the
 * recorded series back out of ClickHouse.
 */
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { and, eq, isNull } from "drizzle-orm";
import { normalizeProbeUrl, type ProbeSuggestion } from "@infrawrench/client-core";
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
import {
  badRequest,
  notFound,
  ProbeMetrics,
  ProbesApi,
  ProbeSuggestions,
  ServiceUnavailable,
  SyntheticProbe,
  SyntheticProbeList,
} from "@infrawrench/api-contract";
import { db } from "../../../db/client";
import { resources } from "../../../db/schema";
import { logAudit } from "../../../services/audit";
import { makeDomain } from "../../domain";
import { fireAndForget, legacy, legacyTry } from "../../legacy";
import { readObjectBody } from "../../request-body";
import { refusalCall, inputRefusals, refusalsOf } from "../../refusals";
import { OrgPrincipal } from "../../principal";
import { respond } from "../../response";

type Body = { readonly [key: string]: unknown };

const probeStore = refusalsOf(ProbeInputError, {
  logPrefix: "[probes]",
  failure: "Probe operation failed",
});

/** Row to wire shape (`SyntheticProbe` in client-core). */
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
 * endpoint. Bare hosts and IPs get `https://`: the safe default; the user
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
  // from the edge proxy anyway, only suggest hosts with a dot in them.
  const host = new URL(normalized.url).hostname;
  if (!host.includes(".")) return null;
  return normalized.url;
}

/**
 * Endpoint candidates mined from the org's synced resources; a cheap
 * Postgres read over the `outputs_json`/`fields_json` caches (the
 * `expiry/feed.ts` stance: no plugin clients, no credentials, no provider
 * calls). Deduped by URL, first resource wins.
 */
async function listSuggestions(organizationId: string): Promise<ProbeSuggestion[]> {
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
  return suggestions;
}

/** The settings both writes accept, type-checked; a field of the wrong type is ignored. */
function pickSettings(
  body: Body,
): Pick<
  ProbeUpdateInput,
  "method" | "intervalSeconds" | "timeoutMs" | "failureThreshold" | "enabled"
> {
  return {
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
}

const ProbesHandlers = HttpApiBuilder.group(ProbesApi, "probes", (handlers) =>
  handlers
    .handle("list", () =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const probes = yield* legacy(async () => {
          const rows = await listProbeRecords(organizationId);
          const uptime = await uptimeByProbe(organizationId, rows);
          return rows.map((row) => toWire(row, uptime.get(row.id) ?? null));
        });
        return yield* respond(SyntheticProbeList)({ probes });
      }),
    )
    .handle("suggestions", () =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const suggestions = yield* legacy(() => listSuggestions(organizationId));
        return yield* respond(ProbeSuggestions)({ suggestions });
      }),
    )
    .handleRaw("create", ({ request }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const read = yield* readObjectBody(request);
        if (!read.ok) return yield* badRequest(read.error);
        const body = read.body;
        const name = body["name"];
        const url = body["url"];
        if (typeof name !== "string" || typeof url !== "string") {
          return yield* badRequest("name and url are required");
        }
        const input: ProbeCreateInput = {
          name,
          url,
          ...pickSettings(body),
          ...(typeof body["resourceId"] === "string" ? { resourceId: body["resourceId"] } : {}),
          ...(typeof body["outputKey"] === "string" ? { outputKey: body["outputKey"] } : {}),
        };
        const created = yield* refusalCall(probeStore, inputRefusals, () =>
          createProbeRecord(organizationId, input, session.userId),
        );
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
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
          }),
        );
        return yield* respond(SyntheticProbe, { status: 201 })(toWire(created, null));
      }),
    )
    .handleRaw("update", ({ params, request }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const read = yield* readObjectBody(request);
        if (!read.ok) return yield* badRequest(read.error);
        const body = read.body;
        const patch: ProbeUpdateInput = {
          ...(typeof body["name"] === "string" ? { name: body["name"] } : {}),
          ...(typeof body["url"] === "string" ? { url: body["url"] } : {}),
          ...pickSettings(body),
        };
        if (Object.keys(patch).length === 0) return yield* badRequest("No changes supplied");
        const updated = yield* refusalCall(probeStore, inputRefusals, () =>
          updateProbeRecord(organizationId, params.probeId, patch),
        );
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "probe.update",
            entityType: "synthetic_probe",
            entityId: updated.id,
            metadata: { name: updated.name, patch: { ...patch } },
          }),
        );
        // Best-effort, never throws: a ClickHouse outage costs the uptime column.
        const uptime = yield* legacy(() => uptimeByProbe(organizationId, [updated]));
        return yield* respond(SyntheticProbe)(toWire(updated, uptime.get(updated.id) ?? null));
      }),
    )
    .handle("delete", ({ params }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const deleted = yield* refusalCall(probeStore, inputRefusals, () =>
          deleteProbeRecord(organizationId, params.probeId),
        );
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "probe.delete",
            entityType: "synthetic_probe",
            entityId: deleted.id,
            metadata: { name: deleted.name, url: deleted.url },
          }),
        );
      }),
    )
    .handle("metrics", ({ params, query }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const probe = yield* legacy(() => getProbeRecord(organizationId, params.probeId));
        if (!probe) return yield* notFound("Probe not found");

        const now = Date.now();
        const startMs = Number(query.startMs ?? now - 24 * 60 * 60 * 1000);
        const endMs = Number(query.endMs ?? now);
        if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs >= endMs) {
          return yield* badRequest("startMs and endMs must be a valid epoch-ms range");
        }
        const series = yield* legacyTry(
          () => getMetricRange(organizationId, probeMetricResourceId(probe.id), startMs, endMs),
          (err) => {
            console.error("[probes] metrics read failed:", err);
            return new ServiceUnavailable({ error: "Metric store unavailable" });
          },
        );
        return yield* respond(ProbeMetrics)({ series });
      }),
    ),
);

export const probesDomain = makeDomain("probes", ProbesApi, ProbesHandlers);
