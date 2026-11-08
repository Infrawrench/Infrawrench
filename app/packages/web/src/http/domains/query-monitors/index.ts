/**
 * Query monitors: `/api/org/:orgId/query-monitors`, the handlers.
 *
 * The read-only guard on the SQL is enforced in the store, on every execution
 * rather than only on save, so a row that reaches the table by some other
 * route still cannot write. The write bodies are checked here, field by
 * field, with the sentences the routes always answered with.
 */
import { Effect, Predicate, Schema } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { foldMonitorRun, type QueryMonitorInput } from "@infrawrench/client-core";
import {
  QueryMonitorInputError,
  createQueryMonitor,
  deleteQueryMonitor,
  getQueryMonitor,
  listQueryMonitorTargets,
  listQueryMonitors,
  runMonitorQuery,
  updateQueryMonitor,
} from "@infrawrench/server-core/query-monitors/store";
import { logAudit } from "../../../services/audit";
import { makeDomain } from "../../domain";
import { notFound, badRequest } from "../../errors";
import { fireAndForget, legacy, legacyTry } from "../../legacy";
import { inputRefusal } from "../../refusals";
import { readObjectBody } from "../../request-body";
import { OrgPrincipal } from "../../principal";
import { respond } from "../../response";
import {
  QUERY_MONITOR_MODES,
  QUERY_MONITOR_OPERATORS,
  QueryMonitor,
  QueryMonitorList,
  QueryMonitorMode,
  QueryMonitorOperator,
  QueryMonitorsApi,
  QueryMonitorTargets,
  QueryMonitorTestResult,
} from "./api";

type MonitorFields =
  | { readonly ok: true; readonly value: Partial<QueryMonitorInput> }
  | { readonly ok: false; readonly error: string };

const isMode = Schema.is(QueryMonitorMode);
const isOperator = Schema.is(QueryMonitorOperator);

function readMonitorBody(body: { readonly [key: string]: unknown }): MonitorFields {
  const out: Partial<QueryMonitorInput> = {};
  for (const key of ["name", "accountId", "sql"] as const) {
    if (key in body) {
      const raw = body[key];
      if (!Predicate.isString(raw)) return { ok: false, error: `${key} must be a string` };
      out[key] = raw;
    }
  }
  for (const key of ["description", "resourceId", "resourceTypeId"] as const) {
    if (key in body) {
      const raw = body[key];
      if (raw !== null && !Predicate.isString(raw)) {
        return { ok: false, error: `${key} must be a string or null` };
      }
      out[key] = raw;
    }
  }
  if ("mode" in body) {
    const raw = body["mode"];
    if (!isMode(raw)) {
      return { ok: false, error: `mode must be one of ${QUERY_MONITOR_MODES.join(", ")}` };
    }
    out.mode = raw;
  }
  if ("operator" in body) {
    const raw = body["operator"];
    if (!isOperator(raw)) {
      return {
        ok: false,
        error: `operator must be one of ${QUERY_MONITOR_OPERATORS.join(", ")}`,
      };
    }
    out.operator = raw;
  }
  for (const key of ["threshold", "intervalMinutes", "consecutiveBreaches"] as const) {
    if (key in body) {
      const raw = body[key];
      if (!Predicate.isNumber(raw) || !Number.isFinite(raw)) {
        return { ok: false, error: `${key} must be a number` };
      }
      out[key] = raw;
    }
  }
  if ("enabled" in body) {
    const raw = body["enabled"];
    if (!Predicate.isBoolean(raw)) return { ok: false, error: "enabled must be a boolean" };
    out.enabled = raw;
  }
  return { ok: true, value: out };
}

/**
 * A create body as the store's input. A field `validateQueryMonitor` checks is
 * given the value it refuses with the same sentence as a missing one; `mode`
 * and `operator`, which it does not check, take the column defaults a missing
 * one was stored with.
 */
const monitorInput = (fields: Partial<QueryMonitorInput>): QueryMonitorInput => ({
  ...fields,
  name: fields.name ?? "",
  accountId: fields.accountId ?? "",
  sql: fields.sql ?? "",
  mode: fields.mode ?? "scalar",
  operator: fields.operator ?? "gt",
  threshold: fields.threshold ?? Number.NaN,
  intervalMinutes: fields.intervalMinutes ?? Number.NaN,
});

const storeRefusal = (error: unknown) =>
  error instanceof QueryMonitorInputError ? inputRefusal(error) : undefined;

const QueryMonitorsHandlers = HttpApiBuilder.group(QueryMonitorsApi, "queryMonitors", (handlers) =>
  handlers
    .handle("list", () =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const monitors = yield* legacy(() => listQueryMonitors(organizationId));
        return yield* respond(QueryMonitorList)({ monitors });
      }),
    )
    .handle("targets", () =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const accounts = yield* legacy(() => listQueryMonitorTargets(organizationId));
        return yield* respond(QueryMonitorTargets)({ accounts });
      }),
    )
    // The editor's "try it" button, through the same guard as a scheduled run:
    // a query that could not be saved as a monitor must not be runnable through
    // the monitor's own preview.
    .handleRaw("test", ({ request }) =>
      Effect.gen(function* () {
        const parsed = yield* readObjectBody(request);
        if (!parsed.ok) return yield* badRequest(parsed.error);
        const fields = readMonitorBody(parsed.body);
        if (!fields.ok) return yield* badRequest(fields.error);
        const { accountId, sql, mode = "scalar", resourceId, resourceTypeId } = fields.value;
        if (!accountId || !sql) return yield* badRequest("accountId and sql are required");

        const { organizationId } = yield* OrgPrincipal;
        const result = yield* legacy(() =>
          runMonitorQuery(organizationId, {
            accountId,
            sql,
            mode,
            resourceId: resourceId ?? null,
            resourceTypeId: resourceTypeId ?? null,
          }),
        );
        // The threshold is applied to the preview too, so the editor can say
        // "this would be breaching right now".
        const outcome = foldMonitorRun({
          previousStreak: 0,
          operator: fields.value.operator ?? "gt",
          threshold: fields.value.threshold ?? 0,
          consecutiveBreaches: 1,
          value: result.value,
          error: result.error,
        });
        return yield* respond(QueryMonitorTestResult)({
          value: result.value,
          state: outcome.state,
          error: outcome.error,
          durationMs: result.durationMs,
          rows: result.rows,
        });
      }),
    )
    .handleRaw("create", ({ request }) =>
      Effect.gen(function* () {
        const parsed = yield* readObjectBody(request);
        if (!parsed.ok) return yield* badRequest(parsed.error);
        const fields = readMonitorBody(parsed.body);
        if (!fields.ok) return yield* badRequest(fields.error);

        const { organizationId, session } = yield* OrgPrincipal;
        const monitor = yield* legacyTry(
          () =>
            createQueryMonitor(organizationId, monitorInput(fields.value), session.userId ?? null),
          storeRefusal,
        );
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "query_monitor.create",
            entityType: "query_monitor",
            entityId: monitor.id,
            // The query text is recorded: a scheduled statement against a
            // customer database is exactly what an audit reader wants to see,
            // and the guard means it can only ever be a read.
            metadata: { name: monitor.name, accountId: monitor.accountId, sql: monitor.sql },
          }),
        );
        return yield* respond(QueryMonitor)(monitor);
      }),
    )
    .handle("get", ({ params }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const monitor = yield* legacy(() => getQueryMonitor(organizationId, params.monitorId));
        if (!monitor) return yield* notFound("No such monitor");
        return yield* respond(QueryMonitor)(monitor);
      }),
    )
    .handleRaw("update", ({ params, request }) =>
      Effect.gen(function* () {
        const parsed = yield* readObjectBody(request);
        if (!parsed.ok) return yield* badRequest(parsed.error);
        const fields = readMonitorBody(parsed.body);
        if (!fields.ok) return yield* badRequest(fields.error);
        if (Object.keys(fields.value).length === 0) return yield* badRequest("No changes supplied");

        const { organizationId, session } = yield* OrgPrincipal;
        const monitor = yield* legacyTry(
          () => updateQueryMonitor(organizationId, params.monitorId, fields.value),
          storeRefusal,
        );
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "query_monitor.update",
            entityType: "query_monitor",
            entityId: monitor.id,
            metadata: { name: monitor.name, sql: monitor.sql, enabled: monitor.enabled },
          }),
        );
        return yield* respond(QueryMonitor)(monitor);
      }),
    )
    .handle("delete", ({ params }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const removed = yield* legacy(() => deleteQueryMonitor(organizationId, params.monitorId));
        if (!removed) return yield* notFound("No such monitor");
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "query_monitor.delete",
            entityType: "query_monitor",
            entityId: params.monitorId,
          }),
        );
      }),
    ),
);

export const queryMonitorsDomain = makeDomain(
  "query-monitors",
  QueryMonitorsApi,
  QueryMonitorsHandlers,
);
