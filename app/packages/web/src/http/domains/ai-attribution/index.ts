/**
 * AI spend attribution: `/api/org/:orgId/ai-attribution`, the handlers. The
 * stores are promise code; the bodies and the range are read by hand, with
 * the sentences the routes always answered.
 */
import { Effect, Predicate } from "effect";
import { HttpApiBuilder } from "effect/http-api";
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
import { logAudit } from "../../../services/audit";
import { makeDomain } from "../../domain";
import { BadGateway, badRequest, NotFound, notFound } from "../../errors";
import { fieldsOf, readJson, readJsonOr } from "../../json-body";
import { fireAndForget, legacy, legacyTry } from "../../legacy";
import { OrgPrincipal } from "../../principal";
import { respond } from "../../response";
import { refuse, statusCall, type ReadRefusal } from "../status-refusals";
import {
  AiAttributionApi,
  AiAttributionDimension,
  AiAttributionStats,
  AiDimensions,
  AiLocations,
  AiOk,
  AiReattributed,
  AiRequestSource,
  AiSourceKinds,
  AiSources,
  AiSpendBreakdown,
} from "./api";

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;
const RANGE_ERROR = "from/to must be YYYY-MM-DD, from <= to, at most 400 days";

type Fields = { readonly [key: string]: unknown };

/** `inputError(c, e)`: the store's refusal with its status; anything else is a 500. */
const inputRefusal: ReadRefusal = (error) =>
  error instanceof AiAttributionInputError ? error : undefined;

/** Default window: the trailing 30 days, like the other cost reports. */
function parseRange(query: {
  readonly from?: string | undefined;
  readonly to?: string | undefined;
}): { from: string; to: string } | null {
  const today = new Date().toISOString().slice(0, 10);
  const defaultFrom = new Date(Date.now() - 29 * DAY_MS).toISOString().slice(0, 10);
  const from = query.from ?? defaultFrom;
  const to = query.to ?? today;
  if (!ISO_DAY.test(from) || !ISO_DAY.test(to) || from > to) return null;
  if (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`) > 400 * DAY_MS) {
    return null;
  }
  return { from, to };
}

/** A location as the picker returned it, passed to the store as sent. */
const isLocation = (value: unknown): value is Record<string, string> =>
  Predicate.isObject(value) && !Array.isArray(value);

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every(Predicate.isString);

function parseSourceInput(body: Fields): AiRequestSourceInput | string {
  const { name, kind, sourceKindId, enabled, lookbackDays, accountId, baseUrl, apiKey } = body;
  if (!Predicate.isString(name)) return "name must be a string";
  if (kind !== "plugin" && kind !== "litellm") return 'kind must be "plugin" or "litellm"';
  if (!Predicate.isString(sourceKindId)) return "sourceKindId must be a string";
  const location = body["location"] ?? {};
  if (!isLocation(location)) return "location must be an object of strings";
  if (!Predicate.isBoolean(enabled)) return "enabled must be a boolean";
  if (!Predicate.isNumber(lookbackDays)) return "lookbackDays must be a number";
  return {
    name,
    kind,
    accountId: Predicate.isString(accountId) ? accountId : null,
    sourceKindId,
    location,
    enabled,
    lookbackDays,
    baseUrl: Predicate.isString(baseUrl) ? baseUrl : null,
    ...(Predicate.isString(apiKey) && apiKey ? { apiKey } : {}),
  };
}

function parseDimensionInput(body: Fields): AiAttributionDimensionInput | string {
  const { key, label, metadataKeys } = body;
  if (!Predicate.isString(key)) return "key must be a string";
  if (!Predicate.isString(label)) return "label must be a string";
  if (!isStringArray(metadataKeys)) return "metadataKeys must be an array of strings";
  return { key, label, metadataKeys };
}

const AiAttributionHandlers = HttpApiBuilder.group(AiAttributionApi, "aiAttribution", (handlers) =>
  handlers
    .handle("sourceKinds", () =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const sourceKinds = yield* legacy(() => listAiSourceKindOptions(organizationId));
        return yield* respond(AiSourceKinds)({ sourceKinds });
      }),
    )
    .handle("locations", ({ query }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const { accountId, sourceKindId } = query;
        if (!accountId || !sourceKindId) {
          return yield* badRequest("accountId and sourceKindId are required");
        }
        const locations = yield* legacyTry(
          () => listAiSourceLocations(organizationId, accountId, sourceKindId),
          (error) => {
            const message = error instanceof Error ? error.message : String(error);
            if (message === "Account not found") return new NotFound({ error: message });
            return new BadGateway({ error: `Could not list locations: ${message}` });
          },
        );
        return yield* respond(AiLocations)({ locations });
      }),
    )
    .handle("sources", () =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const sources = yield* legacy(() => listAiRequestSources(organizationId));
        return yield* respond(AiSources)({ sources });
      }),
    )
    .handle("source", ({ params }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const source = yield* legacy(() => getAiRequestSource(organizationId, params.id));
        if (!source) return yield* notFound("source not found");
        return yield* respond(AiRequestSource)(source);
      }),
    )
    .handleRaw("createSource", ({ request }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const parsed = parseSourceInput(yield* fieldsOf(yield* readJson(request)));
        if (Predicate.isString(parsed)) return yield* badRequest(parsed);
        const source = yield* statusCall(inputRefusal, { 400: refuse[400], 404: refuse[404] }, () =>
          createAiRequestSource(organizationId, session.userId ?? null, parsed),
        );
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "ai_request_source.create",
            entityType: "ai_request_source",
            entityId: source.id,
            metadata: { name: source.name, kind: source.kind, sourceKindId: source.sourceKindId },
          }),
        );
        return yield* respond(AiRequestSource, { status: 201 })(source);
      }),
    )
    .handleRaw("updateSource", ({ params, request }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const parsed = parseSourceInput(yield* fieldsOf(yield* readJson(request)));
        if (Predicate.isString(parsed)) return yield* badRequest(parsed);
        const source = yield* statusCall(inputRefusal, { 400: refuse[400], 404: refuse[404] }, () =>
          updateAiRequestSource(organizationId, params.id, parsed),
        );
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "ai_request_source.update",
            entityType: "ai_request_source",
            entityId: source.id,
            metadata: { name: source.name, enabled: source.enabled },
          }),
        );
        return yield* respond(AiRequestSource)(source);
      }),
    )
    .handle("deleteSource", ({ params }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const deleted = yield* legacy(() => deleteAiRequestSource(organizationId, params.id));
        if (!deleted) return yield* notFound("source not found");
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "ai_request_source.delete",
            entityType: "ai_request_source",
            entityId: params.id,
          }),
        );
        return yield* respond(AiOk)({ ok: true });
      }),
    )
    // Re-read history after a mapping change.
    .handleRaw("recollect", ({ params, request }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const body = yield* fieldsOf(yield* readJsonOr(request, {}));
        const from = Predicate.isString(body["from"]) ? body["from"] : "";
        const source = yield* statusCall(inputRefusal, { 400: refuse[400], 404: refuse[404] }, () =>
          recollectAiRequestSource(organizationId, params.id, from),
        );
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "ai_request_source.recollect",
            entityType: "ai_request_source",
            entityId: source.id,
            metadata: { from },
          }),
        );
        return yield* respond(AiRequestSource)(source);
      }),
    )
    .handle("dimensions", () =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const dimensions = yield* legacy(() => listAiDimensions(organizationId));
        return yield* respond(AiDimensions)({ dimensions });
      }),
    )
    .handleRaw("createDimension", ({ request }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const parsed = parseDimensionInput(yield* fieldsOf(yield* readJson(request)));
        if (Predicate.isString(parsed)) return yield* badRequest(parsed);
        const dim = yield* statusCall(inputRefusal, { 400: refuse[400] }, () =>
          createAiDimension(organizationId, parsed),
        );
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "ai_dimension.create",
            entityType: "ai_dimension",
            entityId: dim.id,
            metadata: { key: dim.key, metadataKeys: dim.metadataKeys },
          }),
        );
        return yield* respond(AiAttributionDimension, { status: 201 })(dim);
      }),
    )
    .handleRaw("updateDimension", ({ params, request }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const parsed = parseDimensionInput(yield* fieldsOf(yield* readJson(request)));
        if (Predicate.isString(parsed)) return yield* badRequest(parsed);
        const dim = yield* statusCall(inputRefusal, { 400: refuse[400], 404: refuse[404] }, () =>
          updateAiDimension(organizationId, params.id, parsed),
        );
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "ai_dimension.update",
            entityType: "ai_dimension",
            entityId: dim.id,
            metadata: { key: dim.key, metadataKeys: dim.metadataKeys },
          }),
        );
        return yield* respond(AiAttributionDimension)(dim);
      }),
    )
    .handle("deleteDimension", ({ params }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const deleted = yield* legacy(() => deleteAiDimension(organizationId, params.id));
        if (!deleted) return yield* notFound("dimension not found");
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "ai_dimension.delete",
            entityType: "ai_dimension",
            entityId: params.id,
          }),
        );
        return yield* respond(AiOk)({ ok: true });
      }),
    )
    .handle("stats", ({ query }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const range = parseRange(query);
        if (!range) return yield* badRequest(RANGE_ERROR);
        const stats = yield* legacy(() =>
          getAiAttributionStats(organizationId, range.from, range.to),
        );
        return yield* respond(AiAttributionStats)(stats);
      }),
    )
    .handle("spend", ({ query }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const range = parseRange(query);
        if (!range) return yield* badRequest(RANGE_ERROR);
        const dimension = query.dimension ?? "";
        if (!AI_DIMENSION_KEY_PATTERN.test(dimension)) {
          return yield* badRequest("dimension must be a dimension key");
        }
        const breakdown = yield* legacy(() =>
          getAiSpendBreakdown(organizationId, dimension, range.from, range.to),
        );
        return yield* respond(AiSpendBreakdown)(breakdown);
      }),
    )
    .handleRaw("reattribute", ({ request }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const body = yield* fieldsOf(yield* readJsonOr(request, {}));
        const from = Predicate.isString(body["from"]) ? body["from"] : "";
        const to = Predicate.isString(body["to"]) ? body["to"] : "";
        if (!ISO_DAY.test(from) || !ISO_DAY.test(to) || from > to) {
          return yield* badRequest("from/to must be YYYY-MM-DD with from <= to");
        }
        const days: string[] = [];
        for (
          let t = Date.parse(`${from}T00:00:00Z`);
          t <= Date.parse(`${to}T00:00:00Z`);
          t += DAY_MS
        ) {
          days.push(new Date(t).toISOString().slice(0, 10));
          if (days.length > 92) return yield* badRequest("at most 92 days at a time");
        }
        yield* legacy(() => attributeOrgDays(organizationId, days));
        return yield* respond(AiReattributed)({ ok: true, days: days.length });
      }),
    ),
);

export const aiAttributionDomain = makeDomain(
  "ai-attribution",
  AiAttributionApi,
  AiAttributionHandlers,
);
