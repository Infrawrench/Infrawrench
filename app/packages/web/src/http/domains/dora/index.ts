/**
 * DORA metrics: `/api/org/:orgId/dora`, the handlers. Everything here reads
 * Postgres only (`server-core/src/dora/load.ts`), so it runs on the edge.
 */
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import {
  DORA_DEPLOY_STATUSES,
  type DoraBucketSize,
  type DoraDeploymentInput,
  type DoraDeployStatus,
  type DoraScopeFilter,
  type DoraSettings as DoraSettingsPatch,
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
import { logAudit } from "../../../services/audit";
import { makeDomain } from "../../domain";
import { BadRequest, badRequest } from "../../errors";
import { fireAndForget, legacy, legacyTry } from "../../legacy";
import { readObjectBody } from "../../request-body";
import { unexpectedAs } from "../../refusals";
import { OrgPrincipal } from "../../principal";
import { respond } from "../../response";
import {
  DoraApi,
  DoraChangeList,
  DoraDeploymentRecorded,
  DoraReport,
  DoraRestoreList,
  DoraSettings,
} from "./api";

type Body = { readonly [key: string]: unknown };

const DAY_MS = 86_400_000;

/** The loaders' and the settings' refusals are 400s; anything else the route's 500. */
const doraCall = <A>(fn: () => PromiseLike<A>): Effect.Effect<A, BadRequest> =>
  legacyTry(fn, (err) =>
    err instanceof DoraQueryError ||
    err instanceof DoraSettingsError ||
    err instanceof DoraInputError
      ? new BadRequest({ error: err.message })
      : undefined,
  ).pipe(unexpectedAs({ logPrefix: "[dora]", failure: "Delivery metrics failed" }));

interface WindowQuery {
  readonly from?: string | undefined;
  readonly to?: string | undefined;
  readonly dimension?: string | undefined;
  readonly value?: string | undefined;
}

/** `from`/`to` from the query, defaulting to the 30 days ending now. */
function readWindow(query: WindowQuery): DoraWindow | string {
  const to = query.to ? new Date(query.to) : new Date();
  if (!Number.isFinite(to.getTime())) return "to must be an ISO 8601 timestamp";
  const from = query.from ? new Date(query.from) : new Date(to.getTime() - 30 * DAY_MS);
  if (!Number.isFinite(from.getTime())) return "from must be an ISO 8601 timestamp";
  return { from, to };
}

/**
 * `dimension` + `value` filter to one scope. A dimension with no `value`
 * filters to "not known" (no owner recorded, no repository), which is a scope
 * worth seeing: it is where untracked deploys hide.
 */
function readFilter(query: WindowQuery): DoraScopeFilter | null {
  if (!query.dimension) return null;
  const value = query.value;
  return { dimension: query.dimension, value: value === undefined || value === "" ? null : value };
}

const isBucket = (v: string): v is DoraBucketSize => v === "day" || v === "week";
const isDeployStatus = (v: unknown): v is DoraDeployStatus =>
  DORA_DEPLOY_STATUSES.some((s) => s === v);

/** Pick the settings patch; the first field of the wrong type is the sentence to refuse it with. */
function pickSettings(body: Body): Partial<DoraSettingsPatch> | string {
  const patch: Partial<DoraSettingsPatch> = {};
  const hours = body["failureWindowHours"];
  if (hours !== undefined) {
    if (typeof hours !== "number") return "failureWindowHours must be a number";
    patch.failureWindowHours = hours;
  }
  for (const key of ["productionEnvironments", "pipelinePatterns"] as const) {
    const v = body[key];
    if (v === undefined) continue;
    if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) {
      return `${key} must be a list of strings`;
    }
    patch[key] = v.map(String);
  }
  for (const key of ["countFailedDeploys", "includeResourceChanges", "digestEnabled"] as const) {
    const v = body[key];
    if (v === undefined) continue;
    if (typeof v !== "boolean") return `${key} must be a boolean`;
    patch[key] = v;
  }
  return patch;
}

/**
 * The deploy as `recordApiDeployEvent` reads it. The recorder checks every
 * field itself (presence, length, format), treating a missing or null value
 * as an empty one; what it cannot be handed through its type is a value of the
 * wrong type, which is refused here with the recorder's own sentence.
 */
function deploymentInput(
  body: Body,
  status: DoraDeployStatus | undefined,
): DoraDeploymentInput | string {
  // In the order the recorder reads them, so the first bad field is the one it would name.
  for (const key of [
    "externalId",
    "isRollback",
    "commitSha",
    "url",
    "name",
    "environment",
    "repository",
    "commitAt",
    "deployedAt",
  ] as const) {
    const v = body[key];
    if (key === "isRollback") {
      if (v !== undefined && typeof v !== "boolean") return "isRollback must be a boolean";
    } else if (v !== undefined && v !== null && typeof v !== "string") {
      return `${key} must be a string`;
    }
  }
  const req = (key: string) => {
    const v = body[key];
    return typeof v === "string" ? v : "";
  };
  const opt = (key: string) => {
    const v = body[key];
    return typeof v === "string" || v === null ? v : undefined;
  };
  const input: DoraDeploymentInput = {
    externalId: req("externalId"),
    name: req("name"),
    environment: req("environment"),
    deployedAt: req("deployedAt"),
  };
  const repository = opt("repository");
  if (repository !== undefined) input.repository = repository;
  const commitSha = opt("commitSha");
  if (commitSha !== undefined) input.commitSha = commitSha;
  const commitAt = opt("commitAt");
  if (commitAt !== undefined) input.commitAt = commitAt;
  const url = opt("url");
  if (url !== undefined) input.url = url;
  if (status !== undefined) input.status = status;
  const isRollback = body["isRollback"];
  if (typeof isRollback === "boolean") input.isRollback = isRollback;
  return input;
}

const DoraHandlers = HttpApiBuilder.group(DoraApi, "dora", (handlers) =>
  handlers
    .handle("report", ({ query }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const window = readWindow(query);
        if (typeof window === "string") return yield* badRequest(window);
        const bucket = query.bucket;
        if (bucket !== undefined && !isBucket(bucket)) {
          return yield* badRequest("bucket must be day or week");
        }
        const groupBy = query.groupBy;
        const report = yield* doraCall(() =>
          getDoraReport(organizationId, {
            ...window,
            ...(bucket ? { bucket } : {}),
            filter: readFilter(query),
            ...(groupBy ? { groupBy } : {}),
          }),
        );
        return yield* respond(DoraReport)(report);
      }),
    )
    .handle("changes", ({ query }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const window = readWindow(query);
        if (typeof window === "string") return yield* badRequest(window);
        const changes = yield* doraCall(() =>
          listDoraChanges(organizationId, {
            ...window,
            filter: readFilter(query),
            failedOnly: query.failedOnly === "true",
          }),
        );
        return yield* respond(DoraChangeList)(changes);
      }),
    )
    .handle("restores", ({ query }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const window = readWindow(query);
        if (typeof window === "string") return yield* badRequest(window);
        const restores = yield* doraCall(() =>
          listDoraRestores(organizationId, { ...window, filter: readFilter(query) }),
        );
        return yield* respond(DoraRestoreList)({ restores });
      }),
    )
    .handle("settings", () =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const settings = yield* legacy(() => getDoraSettings(organizationId));
        return yield* respond(DoraSettings)(settings);
      }),
    )
    .handleRaw("updateSettings", ({ request }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const read = yield* readObjectBody(request);
        if (!read.ok) return yield* badRequest(read.error);
        const patch = pickSettings(read.body);
        if (typeof patch === "string") return yield* badRequest(patch);
        const saved = yield* doraCall(() =>
          updateDoraSettings(organizationId, patch, session.userId ?? null),
        );
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "dora.settings.update",
            entityType: "dora_settings",
            entityId: organizationId,
            metadata: { fields: Object.keys(patch) },
          }),
        );
        return yield* respond(DoraSettings)(saved);
      }),
    )
    .handleRaw("recordDeployment", ({ request }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const read = yield* readObjectBody(request);
        if (!read.ok) return yield* badRequest(read.error);
        const body = read.body;
        const status = body["status"];
        if (status !== undefined && !isDeployStatus(status)) {
          return yield* badRequest(`status must be one of ${DORA_DEPLOY_STATUSES.join(", ")}`);
        }
        const input = deploymentInput(body, status);
        if (typeof input === "string") return yield* badRequest(input);
        const saved = yield* doraCall(() => recordApiDeployEvent(organizationId, input));
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "dora.deployment.record",
            entityType: "deploy_event",
            entityId: saved.id,
            metadata: {
              externalId: String(body["externalId"] ?? ""),
              environment: body["environment"],
            },
          }),
        );
        return yield* respond(DoraDeploymentRecorded, { status: 201 })(saved);
      }),
    ),
);

export const doraDomain = makeDomain("dora", DoraApi, DoraHandlers);
