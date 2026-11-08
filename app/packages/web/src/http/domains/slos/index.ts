/**
 * Service-level objectives: `/api/org/:orgId/slos`, the handlers. CRUD, the
 * editor's source pickers, the detail read with its hourly history, and the
 * "start a change freeze" suggestion for an exhausted budget. Evaluation and
 * alerting happen in the poller (`server-core/src/slos/`).
 */
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { and, eq, inArray, isNull } from "drizzle-orm";
import {
  SLO_COMPARATORS,
  SLO_FREEZE_DURATIONS_HOURS,
  SLO_SLI_KINDS,
  SLO_WINDOW_DAYS,
  type SloComparator,
  type SloInput,
  type SloMetricResourceOption,
  type SloSliKind,
  type SloSourcesResponse,
  type SloWindowDays,
} from "@infrawrench/client-core";
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
import { db } from "../../../db/client";
import { resources, syntheticProbes } from "../../../db/schema";
import { logAudit } from "../../../services/audit";
import { createChangeFreeze, getActiveChangeFreeze } from "../../../services/change-freezes";
import { makeDomain } from "../../domain";
import { badRequest, notFound } from "../../errors";
import { fireAndForget, legacy } from "../../legacy";
import { readObjectBody } from "../../request-body";
import { refusalCall, inputRefusals, refusalsOf } from "../../refusals";
import { OrgPrincipal } from "../../principal";
import { respond } from "../../response";
import { Slo, SloActiveFreeze, SloDetail, SloList, SloSources, SlosApi } from "./api";

type Body = { readonly [key: string]: unknown };

const sloStore = refusalsOf(SloInputError, {
  logPrefix: "[slos]",
  failure: "SLO operation failed",
});

const isSliKind = (value: string): value is SloSliKind => SLO_SLI_KINDS.some((k) => k === value);
const isComparator = (value: string): value is SloComparator =>
  SLO_COMPARATORS.some((c) => c === value);
const isWindowDays = (value: number): value is SloWindowDays =>
  SLO_WINDOW_DAYS.some((d) => d === value);

/**
 * Pick the known fields off a request body, type-checked; unknown keys and
 * fields of the wrong type are ignored. A value outside a closed set (an
 * unknown `sliKind` or `comparator`, a window that is not 7, 28 or 30 days) is
 * the sentence to refuse it with.
 */
function pickSloBody(body: Body): Partial<SloInput> | string {
  const out: Partial<SloInput> = {};
  const str = (k: string) => {
    const v = body[k];
    return typeof v === "string" ? v : undefined;
  };
  const strOrNull = (k: string) => {
    const v = body[k];
    return v === null ? null : typeof v === "string" ? v : undefined;
  };
  const numOrNull = (k: string) => {
    const v = body[k];
    return v === null ? null : typeof v === "number" ? v : undefined;
  };
  const bool = (k: string) => {
    const v = body[k];
    return typeof v === "boolean" ? v : undefined;
  };

  const name = str("name");
  if (name !== undefined) out.name = name;
  const description = strOrNull("description");
  if (description !== undefined) out.description = description;
  const kind = str("sliKind");
  let kindProblem = false;
  if (kind !== undefined) {
    if (isSliKind(kind)) out.sliKind = kind;
    else kindProblem = true;
  }
  const probeId = strOrNull("probeId");
  if (probeId !== undefined) out.probeId = probeId;
  const latency = numOrNull("latencyThresholdMs");
  if (latency !== undefined) out.latencyThresholdMs = latency;
  const resourceId = strOrNull("resourceId");
  if (resourceId !== undefined) out.resourceId = resourceId;
  const metricKey = strOrNull("metricKey");
  if (metricKey !== undefined) out.metricKey = metricKey;
  const comparator = strOrNull("comparator");
  let comparatorProblem = false;
  if (comparator !== undefined) {
    if (comparator === null || isComparator(comparator)) out.comparator = comparator;
    else comparatorProblem = true;
  }
  const threshold = numOrNull("threshold");
  if (threshold !== undefined) out.threshold = threshold;
  const targetPercent = body["targetPercent"];
  if (typeof targetPercent === "number") out.targetPercent = targetPercent;
  const windowDays = body["windowDays"];
  let windowProblem = false;
  if (typeof windowDays === "number") {
    if (isWindowDays(windowDays)) out.windowDays = windowDays;
    else windowProblem = true;
  }
  const alertsEnabled = bool("alertsEnabled");
  if (alertsEnabled !== undefined) out.alertsEnabled = alertsEnabled;
  const suggestFreeze = bool("suggestFreeze");
  if (suggestFreeze !== undefined) out.suggestFreeze = suggestFreeze;
  const enabled = bool("enabled");
  if (enabled !== undefined) out.enabled = enabled;

  // Closed sets are refused before validation's prose, in this order.
  if (kindProblem) return `sliKind must be one of ${SLO_SLI_KINDS.join(", ")}`;
  if (comparatorProblem) return `comparator must be one of ${SLO_COMPARATORS.join(", ")}`;
  // The store's own sentence for a window outside the set.
  if (windowProblem) return "The window must be 7, 28 or 30 days.";
  return out;
}

/**
 * What an SLO can be measured from: every probe, and every synced resource
 * that reported a metric series in the last week with the series it reported.
 * The editor builds both pickers from this, so nobody types a probe id or an
 * internal series label.
 */
async function listSources(organizationId: string): Promise<SloSourcesResponse> {
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
  return { probes, metricResources };
}

/** The detail read: the SLO, its hourly history (best-effort) and the freeze in effect. */
async function loadDetail(organizationId: string, sloId: string) {
  const row = await getSloRecord(organizationId, sloId);
  if (!row) return null;
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
  return {
    slo: sloToWire(row, labels),
    buckets,
    activeFreeze: freeze
      ? { id: freeze.id, name: freeze.name, endsAt: freeze.endsAt?.toISOString() ?? null }
      : null,
  };
}

const SlosHandlers = HttpApiBuilder.group(SlosApi, "slos", (handlers) =>
  handlers
    .handle("list", () =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const slos = yield* legacy(() => listSlosWire(organizationId));
        return yield* respond(SloList)({ slos });
      }),
    )
    .handle("sources", () =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const sources = yield* legacy(() => listSources(organizationId));
        return yield* respond(SloSources)(sources);
      }),
    )
    .handle("get", ({ params }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const detail = yield* legacy(() => loadDetail(organizationId, params.sloId));
        if (!detail) return yield* notFound("SLO not found");
        return yield* respond(SloDetail)(detail);
      }),
    )
    .handleRaw("create", ({ request }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const read = yield* readObjectBody(request);
        if (!read.ok) return yield* badRequest(read.error);
        const input = pickSloBody(read.body);
        if (typeof input === "string") return yield* badRequest(input);
        const created = yield* refusalCall(sloStore, inputRefusals, () =>
          createSloRecord(organizationId, input, session.userId),
        );
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "slo.create",
            entityType: "slo",
            entityId: created.id,
            metadata: {
              name: created.name,
              sliKind: created.sliKind,
              targetPercent: created.targetPercent,
              windowDays: created.windowDays,
            },
          }),
        );
        const wire = yield* refusalCall(sloStore, inputRefusals, async () =>
          sloToWire(created, await loadSloSourceLabels(organizationId, [created])),
        );
        return yield* respond(Slo, { status: 201 })(wire);
      }),
    )
    .handleRaw("update", ({ params, request }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const read = yield* readObjectBody(request);
        if (!read.ok) return yield* badRequest(read.error);
        const patch = pickSloBody(read.body);
        if (typeof patch !== "string" && Object.keys(patch).length === 0) {
          return yield* badRequest("No changes supplied");
        }
        if (typeof patch === "string") return yield* badRequest(patch);
        const updated = yield* refusalCall(sloStore, inputRefusals, () =>
          updateSloRecord(organizationId, params.sloId, patch),
        );
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "slo.update",
            entityType: "slo",
            entityId: updated.id,
            metadata: { name: updated.name, patch: { ...patch } },
          }),
        );
        const wire = yield* refusalCall(sloStore, inputRefusals, async () =>
          sloToWire(updated, await loadSloSourceLabels(organizationId, [updated])),
        );
        return yield* respond(Slo)(wire);
      }),
    )
    .handle("delete", ({ params }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const deleted = yield* refusalCall(sloStore, inputRefusals, () =>
          deleteSloRecord(organizationId, params.sloId),
        );
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "slo.delete",
            entityType: "slo",
            entityId: deleted.id,
            metadata: { name: deleted.name },
          }),
        );
      }),
    )
    /**
     * Act on the freeze suggestion: start an org change freeze named after
     * the SLO. Uses the ordinary freeze objects (`services/change-freezes.ts`),
     * so the freeze is listed, ended and audited exactly like one made in
     * Settings.
     */
    .handleRaw("freeze", ({ params, request }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const row = yield* legacy(() => getSloRecord(organizationId, params.sloId));
        if (!row) return yield* notFound("SLO not found");
        const read = yield* readObjectBody(request);
        if (!read.ok) return yield* badRequest(read.error);
        const body = read.body;
        const raw = body["durationHours"];
        let duration: number | null;
        if (raw === undefined || raw === null) duration = null;
        else if (typeof raw === "number" && Number.isFinite(raw)) duration = raw;
        else return yield* badRequest("durationHours must be a number of hours or null");
        if (!SLO_FREEZE_DURATIONS_HOURS.includes(duration)) {
          return yield* badRequest(
            `durationHours must be one of ${SLO_FREEZE_DURATIONS_HOURS.join(", ")}`,
          );
        }
        const reasonRaw = body["reason"];
        const reason =
          typeof reasonRaw === "string" && reasonRaw.trim()
            ? reasonRaw.trim().slice(0, 500)
            : `The error budget of SLO "${row.name}" is exhausted.`;
        const now = new Date();
        const freeze = yield* legacy(() =>
          createChangeFreeze(
            organizationId,
            {
              name: `SLO budget: ${row.name}`.slice(0, 120),
              reason,
              startsAt: now,
              ...(duration === null
                ? {}
                : { endsAt: new Date(now.getTime() + duration * 60 * 60_000) }),
            },
            session.userId ?? null,
          ),
        );
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "change_freeze.create",
            entityType: "change_freeze",
            entityId: freeze.id,
            metadata: {
              name: freeze.name,
              startsAt: freeze.startsAt.toISOString(),
              endsAt: freeze.endsAt ? freeze.endsAt.toISOString() : null,
              sloId: row.id,
            },
          }),
        );
        return yield* respond(SloActiveFreeze, { status: 201 })({
          id: freeze.id,
          name: freeze.name,
          endsAt: freeze.endsAt?.toISOString() ?? null,
        });
      }),
    ),
);

export const slosDomain = makeDomain("slos", SlosApi, SlosHandlers);
