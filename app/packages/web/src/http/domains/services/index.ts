/**
 * Services: `/api/org/:orgId/services`, the handlers. CRUD, membership
 * (explicit members plus rules, with exclusions), the summary the service
 * page renders, and the resource-to-service lookup other features annotate
 * with.
 *
 * The summary's cost figure reads through the cost visibility store like
 * every cost route, so a scoped member sees only the spend their scope allows;
 * `legacy` runs it inside the caller's scope.
 */
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import {
  SERVICE_LIMITS,
  SERVICE_NAME_MATCHES,
  SERVICE_RULE_KINDS,
  isServiceTier,
  normalizeServiceRule,
  type ServiceInput,
  type ServiceLink,
  type ServiceMembershipRule,
  type ServiceNameMatch,
  type ServiceRuleKind,
} from "@infrawrench/client-core";
import {
  ServiceInputError,
  addServiceMembers,
  createServiceRecord,
  deleteServiceRecord,
  getServiceRecord,
  getServiceWire,
  listServicesWire,
  removeServiceMember,
  restoreExcludedMember,
  updateServiceRecord,
  type ServiceRecord,
} from "@infrawrench/server-core/service-catalog/store";
import { getServicesForResources } from "@infrawrench/server-core/service-catalog/lookup";
import { buildServiceSummary } from "@infrawrench/server-core/service-catalog/summary";
import { publishServiceChanged } from "@infrawrench/server-core/service-catalog/events";
import { keepAlive } from "@infrawrench/server-core/runtime/request-scope";
import {
  ensureDefaultScorecard,
  listScorecardHistory,
  listScorecardResults,
  markScorecardsDue,
} from "@infrawrench/server-core/scorecards/store";
import { logAudit } from "../../../services/audit";
import { makeDomain } from "../../domain";
import { badRequest, notFound } from "../../errors";
import { fireAndForget, legacy } from "../../legacy";
import { invalidBody, readObjectBody } from "../../object-body";
import { OrgPrincipal } from "../../principal";
import { respond } from "../../response";
import { storeCall } from "../store-errors";
import {
  Service,
  ServiceDetail,
  ServiceList,
  ServicesApi,
  ServicesForResources,
  ServiceScorecards,
  ServiceSummary,
} from "./api";

type Body = { readonly [key: string]: unknown };

const serviceStore = {
  isInputError: (error: unknown): error is ServiceInputError => error instanceof ServiceInputError,
  logPrefix: "[services]",
  failure: "Service operation failed",
};

const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === "string");

const isRecord = (v: unknown): v is Body => typeof v === "object" && v !== null;

const isLink = (v: unknown): v is ServiceLink =>
  isRecord(v) && typeof v["label"] === "string" && typeof v["url"] === "string";

const isRuleKind = (v: unknown): v is ServiceRuleKind => SERVICE_RULE_KINDS.some((k) => k === v);
const isNameMatch = (v: unknown): v is ServiceNameMatch =>
  SERVICE_NAME_MATCHES.some((m) => m === v);

/**
 * A rule object as the store stores it. The store runs every rule through
 * `normalizeServiceRule` (an unknown kind becomes `tag`, anything that is not
 * a non-blank string becomes null), so handing it only the well-typed fields
 * stores exactly what handing it the raw object did.
 */
function toRule(raw: Body): ServiceMembershipRule {
  const rule: Partial<ServiceMembershipRule> = {};
  const { kind, key, value, nameMatch, pluginId, accountId } = raw;
  if (isRuleKind(kind)) rule.kind = kind;
  if (typeof key === "string") rule.key = key;
  if (typeof value === "string") rule.value = value;
  if (isNameMatch(nameMatch)) rule.nameMatch = nameMatch;
  if (typeof pluginId === "string") rule.pluginId = pluginId;
  if (typeof accountId === "string") rule.accountId = accountId;
  return normalizeServiceRule(rule);
}

/** Pick the known fields off a request body, type-checked; unknown keys are ignored. */
function pickServiceBody(body: Body): Partial<ServiceInput> | string {
  const out: Partial<ServiceInput> = {};
  const strOrNull = (k: string) => {
    const v = body[k];
    return v === null ? null : typeof v === "string" ? v : undefined;
  };

  const name = body["name"];
  if (typeof name === "string") out.name = name;
  const slug = body["slug"];
  if (typeof slug === "string") out.slug = slug;
  const description = strOrNull("description");
  if (description !== undefined) out.description = description;
  const tier = body["tier"];
  if (tier !== undefined) {
    if (tier !== null && !isServiceTier(tier)) return "tier must be 1, 2, 3, 4 or null";
    out.tier = tier;
  }
  const ownerTeam = strOrNull("ownerTeam");
  if (ownerTeam !== undefined) out.ownerTeam = ownerTeam;
  const ownerUserIds = body["ownerUserIds"];
  if (ownerUserIds !== undefined) {
    if (!isStringArray(ownerUserIds)) return "ownerUserIds must be an array of user ids";
    out.ownerUserIds = ownerUserIds;
  }
  const links = body["links"];
  if (links !== undefined) {
    if (!Array.isArray(links) || !links.every(isLink)) {
      return "links must be an array of { label, url }";
    }
    out.links = links.map((l) => ({ label: l.label, url: l.url }));
  }
  const onCall = strOrNull("onCallScheduleId");
  if (onCall !== undefined) out.onCallScheduleId = onCall;
  const sloIds = body["sloIds"];
  if (sloIds !== undefined) {
    if (!isStringArray(sloIds)) return "sloIds must be an array of SLO ids";
    out.sloIds = sloIds;
  }
  const runbookIds = body["runbookIds"];
  if (runbookIds !== undefined) {
    if (!isStringArray(runbookIds)) return "runbookIds must be an array of runbook ids";
    out.runbookIds = runbookIds;
  }
  const rules = body["rules"];
  if (rules !== undefined) {
    if (!Array.isArray(rules) || !rules.every(isRecord)) {
      return "rules must be an array of rule objects";
    }
    out.rules = rules.map(toRule);
  }
  const monthlyBudget = body["monthlyBudget"];
  if (monthlyBudget !== undefined) {
    if (
      monthlyBudget !== null &&
      (typeof monthlyBudget !== "number" || !Number.isFinite(monthlyBudget))
    ) {
      return "monthlyBudget must be a number or null";
    }
    out.monthlyBudget = monthlyBudget;
  }
  const currency = strOrNull("budgetCurrency");
  if (currency !== undefined) out.budgetCurrency = currency;
  return out;
}

/** A service with its resolved members, as the detail and both member writes answer. */
async function serviceDetail(organizationId: string, row: ServiceRecord) {
  const { service, membership } = await getServiceWire(organizationId, row);
  return { service, members: membership.members, excluded: membership.excluded };
}

/** The row an id or slug names, or the 404 every per-service route answers. */
const findService = Effect.fnUntraced(function* (organizationId: string, serviceId: string) {
  const row = yield* legacy(() => getServiceRecord(organizationId, serviceId));
  if (!row) return yield* notFound("Service not found");
  return row;
});

const ServicesHandlers = HttpApiBuilder.group(ServicesApi, "services", (handlers) =>
  handlers
    .handle("list", () =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const services = yield* legacy(() => listServicesWire(organizationId));
        return yield* respond(ServiceList)({ services });
      }),
    )
    /**
     * Which services own these resources. `ids` is a comma-separated list of
     * Infrawrench resource ids; resources in no service are absent from the map.
     */
    .handle("forResources", ({ query }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const ids = query.ids
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        if (ids.length > SERVICE_LIMITS.maxMembersPerRequest) {
          return yield* badRequest(
            `Ask about at most ${SERVICE_LIMITS.maxMembersPerRequest} resources at a time`,
          );
        }
        const map = yield* legacy(() => getServicesForResources(organizationId, ids));
        return yield* respond(ServicesForResources)({ services: Object.fromEntries(map) });
      }),
    )
    .handle("get", ({ params }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const row = yield* findService(organizationId, params.serviceId);
        const detail = yield* legacy(() => serviceDetail(organizationId, row));
        return yield* respond(ServiceDetail)(detail);
      }),
    )
    .handle("summary", ({ params }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const row = yield* findService(organizationId, params.serviceId);
        const summary = yield* legacy(async () => {
          const scorecards = await listScorecardResults(organizationId, { serviceId: row.id });
          return buildServiceSummary(organizationId, row, scorecards);
        });
        return yield* respond(ServiceSummary)(summary);
      }),
    )
    .handle("scorecards", ({ params }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const row = yield* findService(organizationId, params.serviceId);
        const [results, history] = yield* legacy(() =>
          Promise.all([
            listScorecardResults(organizationId, { serviceId: row.id }),
            listScorecardHistory(organizationId, row.id),
          ]),
        );
        return yield* respond(ServiceScorecards)({ results, history });
      }),
    )
    .handleRaw("create", ({ request }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const read = yield* readObjectBody(request);
        if (!read.ok) return yield* invalidBody(read.error);
        const input = pickServiceBody(read.body);
        if (typeof input === "string") return yield* badRequest(input);
        const created = yield* storeCall(serviceStore, async () => {
          const row = await createServiceRecord(organizationId, input, session.userId);
          await ensureDefaultScorecard(organizationId);
          await markScorecardsDue(organizationId);
          return row;
        });
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "service.create",
            entityType: "service",
            entityId: created.id,
            metadata: { name: created.name, slug: created.slug, tier: created.tier },
          }),
        );
        yield* fireAndForget(() =>
          keepAlive(publishServiceChanged(organizationId, created, "created")),
        );
        const { service } = yield* storeCall(serviceStore, () =>
          getServiceWire(organizationId, created),
        );
        return yield* respond(Service, { status: 201 })(service);
      }),
    )
    .handleRaw("update", ({ params, request }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const read = yield* readObjectBody(request);
        if (!read.ok) return yield* invalidBody(read.error);
        const patch = pickServiceBody(read.body);
        if (typeof patch === "string") return yield* badRequest(patch);
        if (Object.keys(patch).length === 0) return yield* badRequest("No changes supplied");
        const updated = yield* storeCall(serviceStore, async () => {
          const row = await updateServiceRecord(organizationId, params.serviceId, patch);
          await markScorecardsDue(organizationId);
          return row;
        });
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "service.update",
            entityType: "service",
            entityId: updated.id,
            metadata: { name: updated.name, fields: Object.keys(patch) },
          }),
        );
        yield* fireAndForget(() =>
          keepAlive(publishServiceChanged(organizationId, updated, "updated", Object.keys(patch))),
        );
        const { service } = yield* storeCall(serviceStore, () =>
          getServiceWire(organizationId, updated),
        );
        return yield* respond(Service)(service);
      }),
    )
    .handle("delete", ({ params }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const deleted = yield* storeCall(serviceStore, () =>
          deleteServiceRecord(organizationId, params.serviceId),
        );
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "service.delete",
            entityType: "service",
            entityId: deleted.id,
            metadata: { name: deleted.name },
          }),
        );
        yield* fireAndForget(() =>
          keepAlive(publishServiceChanged(organizationId, deleted, "deleted")),
        );
      }),
    )
    /** Add resources by hand (or put an excluded one back). */
    .handleRaw("addMembers", ({ params, request }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const row = yield* findService(organizationId, params.serviceId);
        const read = yield* readObjectBody(request);
        if (!read.ok) return yield* invalidBody(read.error);
        const resourceIds = read.body["resourceIds"];
        if (!isStringArray(resourceIds)) {
          return yield* badRequest("resourceIds must be an array of resource ids");
        }
        const added = yield* storeCall(serviceStore, async () => {
          const count = await addServiceMembers(
            organizationId,
            row.id,
            resourceIds,
            session.userId,
          );
          await markScorecardsDue(organizationId);
          return count;
        });
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "service.members.add",
            entityType: "service",
            entityId: row.id,
            metadata: { name: row.name, count: added, resourceIds: resourceIds.slice(0, 50) },
          }),
        );
        yield* fireAndForget(() =>
          keepAlive(publishServiceChanged(organizationId, row, "updated", ["members"])),
        );
        const detail = yield* storeCall(serviceStore, () => serviceDetail(organizationId, row));
        return yield* respond(ServiceDetail)(detail);
      }),
    )
    /**
     * Take a resource out. A hand-added member is removed; a rule-matched one
     * is excluded, since the rule would otherwise put it back. Deleting an
     * exclusion (`?restore=1`) lets the rule apply again.
     */
    .handle("removeMember", ({ params, query }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const row = yield* findService(organizationId, params.serviceId);
        const resourceId = params.resourceId;
        let outcome: "removed" | "excluded" | "restored";
        if (query.restore === "1") {
          const restored = yield* storeCall(serviceStore, () =>
            restoreExcludedMember(row.id, resourceId),
          );
          if (!restored) return yield* notFound("That resource is not excluded from this service");
          outcome = "restored";
        } else {
          outcome = yield* storeCall(serviceStore, () =>
            removeServiceMember(organizationId, row, resourceId, session.userId),
          );
        }
        yield* storeCall(serviceStore, () => markScorecardsDue(organizationId));
        const action =
          outcome === "restored" ? "restore" : outcome === "excluded" ? "exclude" : "remove";
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: `service.members.${action}`,
            entityType: "service",
            entityId: row.id,
            metadata: { name: row.name, resourceId },
          }),
        );
        yield* fireAndForget(() =>
          keepAlive(publishServiceChanged(organizationId, row, "updated", ["members"])),
        );
        const detail = yield* storeCall(serviceStore, () => serviceDetail(organizationId, row));
        return yield* respond(ServiceDetail)(detail);
      }),
    ),
);

export const servicesDomain = makeDomain("services", ServicesApi, ServicesHandlers);
