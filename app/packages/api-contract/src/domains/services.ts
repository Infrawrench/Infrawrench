/**
 * Services: `/api/org/:orgId/services`, the endpoint definitions.
 *
 * A service is a logical grouping of resources across providers with an
 * owner, a tier and links to its SLOs, runbooks and on-call schedule.
 * Permissions follow the resource ownership stance: reads are
 * `resources:read`, writes `resources:write`. Saying "these resources are the
 * checkout API" is the same kind of statement as "this VM is mine", and gating
 * it on an admin permission would leave services empty.
 *
 * The write bodies are documented here and checked by hand in the handlers,
 * whose 400s name the field at fault, so those endpoints are served raw.
 */
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/http-api";
import { InvalidRequestMessage, RequiredPermission, SuccessDescription } from "../http/annotations";
import { withApiDefaults } from "../http/api-defaults";
import { BadRequest, Conflict, NotFound } from "../http/errors";
import { OrgAuth } from "../http/middleware-tags";
import { IsoDateTime, OrgId, OrgParams, Uuid } from "../http/schemas/common";
import { documentedAs, optionalRequestBody } from "../http/schemas/documented";
import { PluginId } from "../http/schemas/plugin-registry";
import { PostureFinding } from "../http/schemas/posture";
import { ScorecardResult, ServiceTier } from "../http/schemas/service-catalog";

const RuleKind = Schema.Literals(["tag", "virtual_tag", "name"]).annotate({
  description:
    "`tag`: the resource carries provider tag `key` (with `value` when set). `virtual_tag`: " +
    "the org's virtual tag `key` resolves to `value` on the resource's cost rows over the last " +
    "30 days. `name`: the display name matches `value` per `nameMatch`, case-insensitively.",
});

const NameMatch = Schema.Literals(["contains", "prefix", "suffix", "exact"]);

const ServiceLink = Schema.Struct({
  label: Schema.String.annotate({ description: "At most 80 characters." }),
  url: Schema.String.annotate({ description: "An http or https URL." }),
}).annotate({ identifier: "ServiceLink" });

const ServiceMembershipRule = Schema.Struct({
  kind: RuleKind,
  key: Schema.NullOr(Schema.String).annotate({
    description: "`tag` / `virtual_tag`: the key. Null for `name`.",
  }),
  value: Schema.NullOr(Schema.String).annotate({
    description: "`tag`: exact value, null for any. `virtual_tag`: required. `name`: the pattern.",
  }),
  nameMatch: Schema.NullOr(NameMatch).annotate({
    description: "`name` only; defaults to `contains`.",
  }),
  pluginId: Schema.NullOr(Schema.String).annotate({
    description: "Narrow the rule to one provider.",
  }),
  accountId: Schema.NullOr(Schema.String).annotate({
    description: "Narrow the rule to one account.",
  }),
}).annotate({ identifier: "ServiceMembershipRule" });

const ServiceScoreBadge = Schema.Struct({
  scorecardId: Uuid,
  scorecardName: Schema.String,
  score: Schema.NullOr(Schema.Finite),
  level: Schema.NullOr(Schema.String),
  levelName: Schema.NullOr(Schema.String),
}).annotate({ identifier: "ServiceScoreBadge" });

const inputFields = {
  name: Schema.String.annotate({
    description: "Unique in the organization; at most 120 characters.",
  }),
  slug: Schema.String.annotate({
    description:
      "Lower-case letters, digits and dashes; unique. Derived from the name when omitted.",
  }),
  description: Schema.NullOr(Schema.String).annotate({ description: "At most 1000 characters." }),
  tier: Schema.NullOr(ServiceTier),
  ownerTeam: Schema.NullOr(Schema.String).annotate({
    description: "Free-text owning team; display-only, never routed. At most 120 characters.",
  }),
  ownerUserIds: Schema.Array(Schema.String).annotate({
    description: "Owning org members (at most 20).",
  }),
  links: Schema.Array(ServiceLink).annotate({
    description: "Dashboards, repositories, docs (at most 20).",
  }),
  onCallScheduleId: Schema.NullOr(Uuid),
  sloIds: Schema.Array(Uuid).annotate({ description: "Linked SLOs (at most 50)." }),
  runbookIds: Schema.Array(Uuid).annotate({ description: "Linked runbooks (at most 50)." }),
  rules: Schema.Array(ServiceMembershipRule).annotate({
    description: "Membership rules (at most 20).",
  }),
  monthlyBudget: Schema.NullOr(Schema.Finite).annotate({
    description: "Monthly budget in `budgetCurrency`; read by the cost scorecard check.",
  }),
  budgetCurrency: Schema.NullOr(Schema.String).annotate({
    description: "ISO 4217 code; required with a budget.",
  }),
};

export const Service = Schema.Struct({
  id: Uuid,
  ...inputFields,
  owners: Schema.Array(
    Schema.Struct({
      userId: Schema.String,
      name: Schema.NullOr(Schema.String),
      email: Schema.NullOr(Schema.String),
    }),
  ),
  onCallScheduleName: Schema.NullOr(Schema.String),
  memberCount: Schema.Int.annotate({
    description: "Resolved members: explicit plus rule-matched.",
  }),
  scores: Schema.Array(ServiceScoreBadge).annotate({
    description: "Current standing on each enabled scorecard.",
  }),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
}).annotate({ identifier: "Service" });

export const ServiceList = Schema.Struct({ services: Schema.Array(Service) }).annotate({
  identifier: "ServiceList",
});

const optionalInputs = {
  slug: Schema.optionalKey(inputFields.slug),
  description: Schema.optionalKey(inputFields.description),
  tier: Schema.optionalKey(inputFields.tier),
  ownerTeam: Schema.optionalKey(inputFields.ownerTeam),
  ownerUserIds: Schema.optionalKey(inputFields.ownerUserIds),
  links: Schema.optionalKey(inputFields.links),
  onCallScheduleId: Schema.optionalKey(inputFields.onCallScheduleId),
  sloIds: Schema.optionalKey(inputFields.sloIds),
  runbookIds: Schema.optionalKey(inputFields.runbookIds),
  rules: Schema.optionalKey(inputFields.rules),
  monthlyBudget: Schema.optionalKey(inputFields.monthlyBudget),
  budgetCurrency: Schema.optionalKey(inputFields.budgetCurrency),
};

const ServiceCreate = Schema.Struct({ name: inputFields.name, ...optionalInputs }).annotate({
  identifier: "ServiceCreate",
});

const ServiceUpdate = Schema.Struct({
  name: Schema.optionalKey(inputFields.name),
  ...optionalInputs,
}).annotate({ identifier: "ServiceUpdate" });

const ServiceMemberOwner = Schema.Struct({
  userId: Schema.NullOr(Schema.String).annotate({
    description: "Set when a routable org member owns it.",
  }),
  displayName: Schema.String,
  isLabel: Schema.Boolean.annotate({ description: "True when `displayName` is free text." }),
  ticketUrl: Schema.NullOr(Schema.String),
  purpose: Schema.NullOr(Schema.String),
}).annotate({ identifier: "ServiceMemberOwner" });

const ServiceMember = Schema.Struct({
  resourceId: Schema.String,
  accountId: Uuid,
  accountName: Schema.NullOr(Schema.String),
  pluginId: PluginId,
  resourceTypeId: Schema.String,
  resourceName: Schema.String,
  externalId: Schema.NullOr(Schema.String),
  source: Schema.Literals(["manual", "rule"]),
  ruleIndex: Schema.NullOr(Schema.Int).annotate({
    description: "Index into `rules` for `rule` members.",
  }),
  owner: Schema.NullOr(ServiceMemberOwner),
  missing: Schema.Boolean.annotate({ description: "The resource was deleted upstream." }),
}).annotate({ identifier: "ServiceMember" });

export const ServiceDetail = Schema.Struct({
  service: Service,
  members: Schema.Array(ServiceMember),
  excluded: Schema.Array(ServiceMember).annotate({
    description: "Rule-matched resources the service deliberately leaves out.",
  }),
}).annotate({ identifier: "ServiceDetail" });

const ServiceMembersRequest = Schema.Struct({
  resourceIds: Schema.Array(Schema.String).annotate({
    description: "Infrawrench resource ids (at most 500).",
  }),
}).annotate({ identifier: "ServiceMembersRequest" });

const ShiftPerson = {
  userId: Schema.String,
  name: Schema.NullOr(Schema.String),
  email: Schema.NullOr(Schema.String),
};

export const ServiceSummary = Schema.Struct({
  service: Service,
  memberCount: Schema.Int,
  cost: Schema.Struct({
    windowDays: Schema.Int,
    available: Schema.Boolean.annotate({
      description: "False when the cost warehouse could not be read; never read that as zero.",
    }),
    totals: Schema.Array(Schema.Struct({ currency: Schema.String, amount: Schema.Finite })),
    byProvider: Schema.Array(
      Schema.Struct({ pluginId: Schema.String, currency: Schema.String, amount: Schema.Finite }),
    ),
    costedMembers: Schema.Int,
  }).annotate({
    description:
      "Trailing member spend, per currency. Respects the caller's cost visibility scope.",
  }),
  slos: Schema.Array(
    Schema.Struct({
      id: Uuid,
      name: Schema.String,
      status: Schema.Literals(["exhausted", "fast_burn", "slow_burn", "ok", "unknown"]),
      targetPercent: Schema.Finite,
      budgetRemaining: Schema.NullOr(Schema.Finite),
    }),
  ),
  runbooks: Schema.Array(Schema.Struct({ id: Uuid, name: Schema.String, enabled: Schema.Boolean })),
  onCall: Schema.NullOr(
    Schema.Struct({
      scheduleId: Uuid,
      scheduleName: Schema.String,
      enabled: Schema.Boolean,
      current: Schema.NullOr(Schema.Struct({ ...ShiftPerson, endsAt: IsoDateTime })),
      next: Schema.NullOr(Schema.Struct(ShiftPerson)),
    }),
  ),
  findings: Schema.Struct({
    posture: Schema.Struct({
      counts: Schema.Struct({
        critical: Schema.Int,
        high: Schema.Int,
        medium: Schema.Int,
        low: Schema.Int,
      }),
      items: Schema.Array(PostureFinding).annotate({
        description: "At most 25, worst first.",
      }),
    }),
    orphans: Schema.Array(
      Schema.Struct({
        resourceId: Schema.String,
        resourceName: Schema.String,
        reason: Schema.String,
      }),
    ),
    backups: Schema.Array(
      Schema.Struct({
        resourceId: Schema.String,
        resourceName: Schema.String,
        kind: Schema.String.annotate({
          description:
            "`unprotected`, `rpo-breach`, `retention-below-policy`, `drill-stale`, " +
            "`drill-failed` or `drill-never`.",
        }),
        detail: Schema.String,
      }),
    ),
    unavailable: Schema.Array(Schema.Literals(["posture", "orphans", "backups"])),
  }),
  recentChanges: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      resourceId: Schema.String,
      resourceName: Schema.String,
      pluginId: Schema.String,
      changeKind: Schema.Literals(["created", "updated", "deleted"]),
      fields: Schema.Array(Schema.String),
      at: IsoDateTime,
    }),
  ),
  scorecards: Schema.Array(ScorecardResult),
  generatedAt: IsoDateTime,
}).annotate({ identifier: "ServiceSummary" });

const ServiceRef = Schema.Struct({
  id: Uuid,
  name: Schema.String,
  slug: Schema.String,
  tier: Schema.NullOr(ServiceTier),
}).annotate({ identifier: "ServiceRef" });

export const ServicesForResources = Schema.Struct({
  services: Schema.Record(Schema.String, Schema.Array(ServiceRef)).annotate({
    description: "Resource id to the services it belongs to; resources in none are absent.",
  }),
}).annotate({ identifier: "ServicesForResources" });

const ScorecardHistoryPoint = Schema.Struct({
  day: Schema.String.annotate({ description: "`YYYY-MM-DD`, UTC." }),
  score: Schema.NullOr(Schema.Finite),
  level: Schema.NullOr(Schema.String),
}).annotate({ identifier: "ScorecardHistoryPoint" });

export const ServiceScorecards = Schema.Struct({
  results: Schema.Array(ScorecardResult),
  history: Schema.Record(Schema.String, Schema.Array(ScorecardHistoryPoint)).annotate({
    description: "Per scorecard id, oldest first, at most 90 days.",
  }),
}).annotate({ identifier: "ServiceScorecards" });

const ServiceParams = {
  orgId: OrgId,
  serviceId: Schema.String.annotate({ description: "Service id or slug." }),
} as const;

export class ServicesGroup extends HttpApiGroup.make("services")
  .add(
    HttpApiEndpoint.get("list", "/", { params: OrgParams, success: ServiceList })
      .annotate(RequiredPermission, "resources:read")
      .annotate(OpenApi.Summary, "List services")
      .annotate(
        OpenApi.Description,
        "Every service with its owners, links, resolved member count and current scorecard levels.",
      )
      .annotate(SuccessDescription, "The services"),
    HttpApiEndpoint.get("forResources", "/for-resources", {
      params: OrgParams,
      query: {
        ids: Schema.String.annotate({
          description: "Comma-separated Infrawrench resource ids (at most 500).",
        }),
      },
      success: ServicesForResources,
      error: BadRequest,
    })
      .annotate(RequiredPermission, "resources:read")
      .annotate(OpenApi.Summary, "Look up the services resources belong to")
      .annotate(
        OpenApi.Description,
        "Membership is explicit members plus rules minus exclusions, resolved against the " +
          "current inventory. Resources in no service are absent from the map.",
      )
      .annotate(SuccessDescription, "Services per resource")
      .annotate(InvalidRequestMessage, "ids must be a comma-separated list of resource ids"),
    HttpApiEndpoint.get("get", "/:serviceId", {
      params: ServiceParams,
      success: ServiceDetail,
      error: NotFound,
    })
      .annotate(RequiredPermission, "resources:read")
      .annotate(OpenApi.Summary, "Read a service with its members")
      .annotate(SuccessDescription, "The service"),
    HttpApiEndpoint.get("summary", "/:serviceId/summary", {
      params: ServiceParams,
      success: ServiceSummary,
      error: NotFound,
    })
      .annotate(RequiredPermission, "resources:read")
      .annotate(OpenApi.Summary, "Summarize a service")
      .annotate(
        OpenApi.Description,
        "Trailing 30-day member spend (scoped to the caller's cost visibility), linked SLO " +
          "standing, open posture, orphan and backup findings on members, the current on-call " +
          "shift, the last week's changes and current scorecard results. Feeds that fail are " +
          "listed in `findings.unavailable` or `cost.available` rather than failing the request.",
      )
      .annotate(SuccessDescription, "The summary"),
    HttpApiEndpoint.get("scorecards", "/:serviceId/scorecards", {
      params: ServiceParams,
      success: ServiceScorecards,
      error: NotFound,
    })
      .annotate(RequiredPermission, "resources:read")
      .annotate(OpenApi.Summary, "Read a service's scorecard results and history")
      .annotate(SuccessDescription, "Results and history"),
    HttpApiEndpoint.post("create", "/", {
      params: OrgParams,
      payload: ServiceCreate,
      success: Service.pipe(HttpApiSchema.status(201)),
      error: [BadRequest, NotFound, Conflict],
    })
      .annotate(RequiredPermission, "resources:write")
      .annotate(OpenApi.Summary, "Create a service")
      .annotate(
        OpenApi.Description,
        "Owners, the on-call schedule, SLOs and runbooks must belong to the organization. " +
          "Audit-logged.",
      )
      .annotate(SuccessDescription, "The created service")
      .annotate(OpenApi.Transform, optionalRequestBody),
    HttpApiEndpoint.patch("update", "/:serviceId", {
      params: ServiceParams,
      payload: ServiceUpdate,
      success: Service,
      error: [BadRequest, NotFound, Conflict],
    })
      .annotate(RequiredPermission, "resources:write")
      .annotate(OpenApi.Summary, "Update a service")
      .annotate(
        OpenApi.Description,
        "Omitted fields keep their value. List fields (owners, links, SLOs, runbooks, rules) " +
          "replace the stored list. Audit-logged.",
      )
      .annotate(SuccessDescription, "The updated service")
      .annotate(OpenApi.Transform, optionalRequestBody),
    HttpApiEndpoint.delete("delete", "/:serviceId", {
      params: ServiceParams,
      success: HttpApiSchema.NoContent,
      error: [BadRequest, NotFound, Conflict],
    })
      .annotate(RequiredPermission, "resources:write")
      .annotate(OpenApi.Summary, "Delete a service")
      .annotate(
        OpenApi.Description,
        "The member resources, SLOs, runbooks and schedule are untouched. Audit-logged.",
      )
      .annotate(SuccessDescription, "Deleted"),
    HttpApiEndpoint.post("addMembers", "/:serviceId/members", {
      params: ServiceParams,
      payload: ServiceMembersRequest,
      success: ServiceDetail,
      error: [BadRequest, NotFound, Conflict],
    })
      .annotate(RequiredPermission, "resources:write")
      .annotate(OpenApi.Summary, "Add members to a service")
      .annotate(
        OpenApi.Description,
        "Adds resources by hand. An excluded resource is put back. Audit-logged.",
      )
      .annotate(SuccessDescription, "The service with its members")
      .annotate(OpenApi.Transform, optionalRequestBody),
    HttpApiEndpoint.delete("removeMember", "/:serviceId/members/:resourceId", {
      params: { ...ServiceParams, resourceId: Schema.String },
      query: {
        // Read as sent: any value but `1` removes, as it always did.
        restore: Schema.optionalKey(
          documentedAs(
            Schema.Literal("1").annotate({ description: "Delete an exclusion instead." }),
          ),
        ),
      },
      success: ServiceDetail,
      error: [BadRequest, NotFound, Conflict],
    })
      .annotate(RequiredPermission, "resources:write")
      .annotate(OpenApi.Summary, "Remove a member from a service")
      .annotate(
        OpenApi.Description,
        "A hand-added member is removed; a rule-matched one is excluded, since the rule would " +
          "otherwise put it back. With `restore=1`, deletes an exclusion instead. Audit-logged.",
      )
      .annotate(SuccessDescription, "The service with its members"),
  )
  .prefix("/api/org/:orgId/services")
  .middleware(OrgAuth)
  .annotate(OpenApi.Title, "Services") {}

export class ServicesApi extends withApiDefaults(HttpApi.make("services").add(ServicesGroup)) {}
