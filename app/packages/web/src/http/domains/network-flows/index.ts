/**
 * Network flow attribution: `/api/org/:orgId/network-flows`, the handlers.
 *
 * Saved reports follow the cost reports' rules (report folders, per-object
 * sharing, soft delete), each write audit-logged as `network_flow_report.*`;
 * the storage and access rules are in `services/network-flow-reports.ts`,
 * the reads in server-core, the assembly and validation in client-core.
 */
import { Effect, Predicate, Schema } from "effect";
import type { HttpServerRequest } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import { NETWORK_FLOW_SCOPES } from "@infrawrench/plugin-base";
import {
  normalizeNetworkFlowReportConfig,
  normalizeNetworkFlowReportInput,
} from "@infrawrench/client-core";
import { getNetworkFlowFeed } from "@infrawrench/server-core/network-flow/feed";
import {
  KubernetesNetworkError,
  getKubernetesNetworkReport,
  getKubernetesNetworkSettings,
  setKubernetesNetworkSettings,
} from "@infrawrench/server-core/network-flow/kubernetes";
import {
  NetworkFlowSettingsError,
  getNetworkFlowSettings,
  setNetworkFlowSettings,
} from "@infrawrench/server-core/network-flow/settings";
import {
  NetworkFlowReportError,
  getNetworkFlowReportOptions,
  runNetworkFlowReportConfig,
} from "@infrawrench/server-core/network-flow/report";
import { logAudit } from "../../../services/audit";
import { CostReportFolderError } from "../../../services/cost-report-folders";
import {
  createNetworkFlowReport,
  getNetworkFlowReport,
  listNetworkFlowReports,
  runSavedNetworkFlowReport,
  softDeleteNetworkFlowReport,
  updateNetworkFlowReport,
} from "../../../services/network-flow-reports";
import { makeDomain } from "../../domain";
import { BadRequest, badRequest, notFound } from "../../errors";
import { fieldsOf, readJson, readJsonOr } from "../../json-body";
import { fireAndForget, legacy, legacyTry } from "../../legacy";
import { OrgPrincipal } from "../../principal";
import { respond } from "../../response";
import { ok } from "../../schemas/common";
import { refuse, statusCall, type ReadRefusal } from "../status-refusals";
import {
  KubernetesNetworkReport,
  KubernetesNetworkSettings,
  NetworkFlowFeed,
  NetworkFlowSettings,
  NetworkFlowsApi,
  Options,
  Report,
  Result,
  RunResult,
} from "./api";

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const RANGE_ERROR = "from/to must be YYYY-MM-DD with from <= to";
const LIMIT_ERROR = "limit must be an integer between 1 and 200";

/**
 * Default window: the last 14 days. Shorter than the cost surface's 30
 * because flow retention is shorter (CloudWatch log groups commonly keep 7
 * or 30 days and the plugin will not ask beyond 14), so a 30-day default
 * would open on a chart that is empty for its first half.
 */
function parseRange(query: {
  readonly from?: string | undefined;
  readonly to?: string | undefined;
}): { from: string; to: string } | null {
  const today = new Date().toISOString().slice(0, 10);
  const defaultFrom = new Date(Date.now() - 13 * 86_400_000).toISOString().slice(0, 10);
  const from = query.from ?? defaultFrom;
  const to = query.to ?? today;
  if (!ISO_DAY.test(from) || !ISO_DAY.test(to) || from > to) return null;
  return { from, to };
}

/** `limit` as sent, or the default; null when it is not an integer in 1..200. */
function parseLimit(raw: string | undefined, fallback: number): number | null {
  const limit = raw === undefined ? fallback : Number(raw);
  return Number.isInteger(limit) && limit >= 1 && limit <= 200 ? limit : null;
}

const kubernetesRefusal: ReadRefusal = (error) =>
  error instanceof KubernetesNetworkError ? error : undefined;

/** `reportError(c, e)`: a refused window or a bad folder is the caller's 400. */
const reportRefusal = (error: unknown) =>
  error instanceof NetworkFlowReportError || error instanceof CostReportFolderError
    ? new BadRequest({ error: error.message })
    : undefined;

/** The body as JSON, or the reports' own 400 when it is not JSON. */
const readReportBody = Effect.fnUntraced(function* (request: HttpServerRequest.HttpServerRequest) {
  const missing = Symbol("missing");
  const body: unknown = yield* readJsonOr(request, missing);
  if (body === missing) return yield* badRequest("Invalid JSON body");
  return body;
});

const NetworkFlowsHandlers = HttpApiBuilder.group(NetworkFlowsApi, "networkFlows", (handlers) =>
  handlers
    // The whole network-costs screen. `costs:read`, not a permission of its
    // own: this is spend information, and an org that grants the bill should
    // not have to grant the explanation of it separately.
    .handle("feed", ({ query }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const range = parseRange(query);
        if (!range) return yield* badRequest(RANGE_ERROR);
        const scope = query.scope;
        if (scope !== undefined && !NETWORK_FLOW_SCOPES.some((known) => known === scope)) {
          return yield* badRequest(`scope must be one of ${NETWORK_FLOW_SCOPES.join(", ")}`);
        }
        const limit = parseLimit(query.limit, 50);
        if (limit === null) return yield* badRequest(LIMIT_ERROR);
        const feed = yield* legacy(() =>
          getNetworkFlowFeed(organizationId, {
            from: range.from,
            to: range.to,
            limit,
            ...(scope ? { scope } : {}),
            ...(query.accountId ? { accountId: query.accountId } : {}),
          }),
        );
        return yield* respond(NetworkFlowFeed)(feed);
      }),
    )
    .handle("kubernetes", ({ params, query }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const range = parseRange(query);
        if (!range) return yield* badRequest(RANGE_ERROR);
        const limit = parseLimit(query.limit, 25);
        if (limit === null) return yield* badRequest(LIMIT_ERROR);
        const report = yield* statusCall(
          kubernetesRefusal,
          { 400: refuse[400], 404: refuse[404] },
          () => getKubernetesNetworkReport(organizationId, params.accountId, { ...range, limit }),
        );
        return yield* respond(KubernetesNetworkReport)(report);
      }),
    )
    .handle("kubernetesSettings", ({ params }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const settings = yield* statusCall(kubernetesRefusal, { 404: refuse[404] }, () =>
          getKubernetesNetworkSettings(organizationId, params.accountId),
        );
        return yield* respond(KubernetesNetworkSettings)(settings);
      }),
    )
    .handleRaw("setKubernetesSettings", ({ params, request }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const body = yield* readJsonOr(request, null);
        const billedQuery = Predicate.isObject(body) ? body["billedQuery"] : undefined;
        if (billedQuery !== null && !Predicate.isString(billedQuery)) {
          return yield* badRequest("billedQuery must be a string or null");
        }
        const settings = yield* statusCall(
          kubernetesRefusal,
          { 400: refuse[400], 404: refuse[404] },
          () =>
            setKubernetesNetworkSettings(
              organizationId,
              params.accountId,
              { billedQuery },
              session.userId,
            ),
        );
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "network_flows.kubernetes_settings.update",
            entityType: "account",
            entityId: params.accountId,
            metadata: { billedQuery: settings.billedQuery },
          }),
        );
        return yield* respond(KubernetesNetworkSettings)(settings);
      }),
    )
    .handle("settings", () =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const settings = yield* legacy(() => getNetworkFlowSettings(organizationId));
        return yield* respond(NetworkFlowSettings)(settings);
      }),
    )
    .handleRaw("setSettings", ({ request }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const { enabled, initialLookbackDays: lookback } = yield* fieldsOf(
          yield* readJson(request),
        );
        if (!Predicate.isBoolean(enabled)) return yield* badRequest("enabled must be a boolean");
        if (lookback !== undefined && !Predicate.isNumber(lookback)) {
          return yield* badRequest("initialLookbackDays must be a number");
        }
        const settings = yield* legacyTry(
          async () => {
            const current = await getNetworkFlowSettings(organizationId);
            return setNetworkFlowSettings(
              organizationId,
              { enabled, initialLookbackDays: lookback ?? current.initialLookbackDays },
              session.userId,
            );
          },
          (error) =>
            error instanceof NetworkFlowSettingsError
              ? new BadRequest({ error: error.message })
              : undefined,
        );
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: settings.enabled ? "network_flows.enable" : "network_flows.disable",
            entityType: "organization",
            entityId: organizationId,
            metadata: { initialLookbackDays: settings.initialLookbackDays },
          }),
        );
        return yield* respond(NetworkFlowSettings)(settings);
      }),
    )
    .handle("reportOptions", () =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const options = yield* legacy(() => getNetworkFlowReportOptions(organizationId));
        return yield* respond(Options)(options);
      }),
    )
    .handleRaw("reportQuery", ({ request }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const parsed = normalizeNetworkFlowReportConfig(yield* readReportBody(request));
        if (!parsed.ok) return yield* badRequest(parsed.error);
        const result = yield* legacyTry(
          () => runNetworkFlowReportConfig(organizationId, parsed.value),
          reportRefusal,
        );
        return yield* respond(Result)(result);
      }),
    )
    .handle("listReports", () =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const reports = yield* legacy(() => listNetworkFlowReports(organizationId));
        return yield* respond(Schema.Array(Report))(reports);
      }),
    )
    .handleRaw("createReport", ({ request }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const parsed = normalizeNetworkFlowReportInput(yield* readReportBody(request));
        if (!parsed.ok) return yield* badRequest(parsed.error);
        const created = yield* legacyTry(
          () => createNetworkFlowReport(organizationId, parsed.value, session.userId ?? null),
          reportRefusal,
        );
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "network_flow_report.create",
            entityType: "network_flow_report",
            entityId: created.id,
            metadata: { name: created.name },
          }),
        );
        return yield* respond(Report)(created);
      }),
    )
    .handle("getReport", ({ params }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const report = yield* legacy(() => getNetworkFlowReport(organizationId, params.id));
        if (!report) return yield* notFound();
        return yield* respond(Report)(report);
      }),
    )
    .handleRaw("updateReport", ({ params, request }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const parsed = normalizeNetworkFlowReportInput(yield* readReportBody(request));
        if (!parsed.ok) return yield* badRequest(parsed.error);
        const updated = yield* legacyTry(
          () => updateNetworkFlowReport(organizationId, params.id, parsed.value),
          reportRefusal,
        );
        if (!updated) return yield* notFound();
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "network_flow_report.update",
            entityType: "network_flow_report",
            entityId: updated.id,
            metadata: { name: updated.name },
          }),
        );
        return yield* respond(Report)(updated);
      }),
    )
    .handle("deleteReport", ({ params }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const deleted = yield* legacy(() => softDeleteNetworkFlowReport(organizationId, params.id));
        if (!deleted) return yield* notFound();
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "network_flow_report.delete",
            entityType: "network_flow_report",
            entityId: params.id,
            metadata: {},
          }),
        );
        return ok;
      }),
    )
    .handle("runReport", ({ params }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const result = yield* legacyTry(
          () => runSavedNetworkFlowReport(organizationId, params.id),
          reportRefusal,
        );
        if (!result) return yield* notFound();
        return yield* respond(RunResult)(result);
      }),
    ),
);

export const networkFlowsDomain = makeDomain(
  "network-flows",
  NetworkFlowsApi,
  NetworkFlowsHandlers,
);
