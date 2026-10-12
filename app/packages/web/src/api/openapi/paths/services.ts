import { SCORECARD_CHECK_TYPE_IDS } from "@infrawrench/client-core";
import { z } from "../zod";
import { strict, ErrorResponses, OrgIdParam, Uuid, IsoDateTime } from "../common";
import type { BuildContext } from "../context";

const Tier = z
  .union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)])
  .openapi({ description: "Criticality, 1 being the most critical." });

const RuleKind = z.enum(["tag", "virtual_tag", "name"]).openapi({
  description:
    "`tag`: the resource carries provider tag `key` (with `value` when set). `virtual_tag`: " +
    "the org's virtual tag `key` resolves to `value` on the resource's cost rows over the last " +
    "30 days. `name`: the display name matches `value` per `nameMatch`, case-insensitively.",
});

const NameMatch = z.enum(["contains", "prefix", "suffix", "exact"]);

const CheckType = z
  .enum(SCORECARD_CHECK_TYPE_IDS as unknown as [string, ...string[]])
  .openapi("ScorecardCheckType", { description: "A check type from the scorecard registry." });

const CheckStatus = z.enum(["pass", "fail", "not_applicable", "error"]).openapi({
  description:
    "`not_applicable` leaves the score's denominator; `error` (a feed that could not be read) " +
    "counts as failing.",
});

export function registerServicePaths(ctx: BuildContext) {
  const { registry, enums } = ctx;

  const ServiceLink = strict({
    label: z.string().describe("At most 80 characters."),
    url: z.string().describe("An http or https URL."),
  }).openapi("ServiceLink");

  const ServiceRule = strict({
    kind: RuleKind,
    key: z.string().nullable().describe("`tag` / `virtual_tag`: the key. Null for `name`."),
    value: z
      .string()
      .nullable()
      .describe("`tag`: exact value, null for any. `virtual_tag`: required. `name`: the pattern."),
    nameMatch: NameMatch.nullable().describe("`name` only; defaults to `contains`."),
    pluginId: z.string().nullable().describe("Narrow the rule to one provider."),
    accountId: z.string().nullable().describe("Narrow the rule to one account."),
  }).openapi("ServiceMembershipRule");

  const ScoreBadge = strict({
    scorecardId: Uuid,
    scorecardName: z.string(),
    score: z.number().nullable(),
    level: z.string().nullable(),
    levelName: z.string().nullable(),
  }).openapi("ServiceScoreBadge");

  const inputFields = {
    name: z.string().describe("Unique in the organization; at most 120 characters."),
    slug: z
      .string()
      .describe(
        "Lower-case letters, digits and dashes; unique. Derived from the name when omitted.",
      ),
    description: z.string().nullable().describe("At most 1000 characters."),
    tier: Tier.nullable(),
    ownerTeam: z
      .string()
      .nullable()
      .describe("Free-text owning team; display-only, never routed. At most 120 characters."),
    ownerUserIds: z.array(z.string()).describe("Owning org members (at most 20)."),
    links: z.array(ServiceLink).describe("Dashboards, repositories, docs (at most 20)."),
    onCallScheduleId: Uuid.nullable(),
    sloIds: z.array(Uuid).describe("Linked SLOs (at most 50)."),
    runbookIds: z.array(Uuid).describe("Linked runbooks (at most 50)."),
    rules: z.array(ServiceRule).describe("Membership rules (at most 20)."),
    monthlyBudget: z
      .number()
      .nullable()
      .describe("Monthly budget in `budgetCurrency`; read by the cost scorecard check."),
    budgetCurrency: z.string().nullable().describe("ISO 4217 code; required with a budget."),
  };

  const Service = strict({
    id: Uuid,
    ...inputFields,
    owners: z.array(
      strict({ userId: z.string(), name: z.string().nullable(), email: z.string().nullable() }),
    ),
    onCallScheduleName: z.string().nullable(),
    memberCount: z.number().int().describe("Resolved members: explicit plus rule-matched."),
    scores: z.array(ScoreBadge).describe("Current standing on each enabled scorecard."),
    createdAt: IsoDateTime,
    updatedAt: IsoDateTime,
  }).openapi("Service");

  const ServiceList = strict({ services: z.array(Service) }).openapi("ServiceList");

  const ServiceCreate = strict({
    name: inputFields.name,
    slug: inputFields.slug.optional(),
    description: inputFields.description.optional(),
    tier: inputFields.tier.optional(),
    ownerTeam: inputFields.ownerTeam.optional(),
    ownerUserIds: inputFields.ownerUserIds.optional(),
    links: inputFields.links.optional(),
    onCallScheduleId: inputFields.onCallScheduleId.optional(),
    sloIds: inputFields.sloIds.optional(),
    runbookIds: inputFields.runbookIds.optional(),
    rules: inputFields.rules.optional(),
    monthlyBudget: inputFields.monthlyBudget.optional(),
    budgetCurrency: inputFields.budgetCurrency.optional(),
  }).openapi("ServiceCreate");

  const ServiceUpdate = strict({
    name: inputFields.name.optional(),
    slug: inputFields.slug.optional(),
    description: inputFields.description.optional(),
    tier: inputFields.tier.optional(),
    ownerTeam: inputFields.ownerTeam.optional(),
    ownerUserIds: inputFields.ownerUserIds.optional(),
    links: inputFields.links.optional(),
    onCallScheduleId: inputFields.onCallScheduleId.optional(),
    sloIds: inputFields.sloIds.optional(),
    runbookIds: inputFields.runbookIds.optional(),
    rules: inputFields.rules.optional(),
    monthlyBudget: inputFields.monthlyBudget.optional(),
    budgetCurrency: inputFields.budgetCurrency.optional(),
  }).openapi("ServiceUpdate");

  const OwnerSummary = strict({
    userId: z.string().nullable().describe("Set when a routable org member owns it."),
    displayName: z.string(),
    isLabel: z.boolean().describe("True when `displayName` is free text."),
    ticketUrl: z.string().nullable(),
    purpose: z.string().nullable(),
  }).openapi("ServiceMemberOwner");

  const ServiceMember = strict({
    resourceId: z.string(),
    accountId: Uuid,
    accountName: z.string().nullable(),
    pluginId: enums.PluginId,
    resourceTypeId: z.string(),
    resourceName: z.string(),
    externalId: z.string().nullable(),
    source: z.enum(["manual", "rule"]),
    ruleIndex: z.number().int().nullable().describe("Index into `rules` for `rule` members."),
    owner: OwnerSummary.nullable(),
    missing: z.boolean().describe("The resource was deleted upstream."),
  }).openapi("ServiceMember");

  const ServiceDetail = strict({
    service: Service,
    members: z.array(ServiceMember),
    excluded: z
      .array(ServiceMember)
      .describe("Rule-matched resources the service deliberately leaves out."),
  }).openapi("ServiceDetail");

  const ServiceMembersRequest = strict({
    resourceIds: z.array(z.string()).describe("Infrawrench resource ids (at most 500)."),
  }).openapi("ServiceMembersRequest");

  const ScorecardCheckResult = strict({
    checkId: z.string(),
    type: CheckType,
    name: z.string(),
    weight: z.number().int(),
    status: CheckStatus,
    detail: z.string().nullable(),
  }).openapi("ScorecardCheckResult");

  const ScorecardResult = strict({
    scorecardId: Uuid,
    scorecardName: z.string(),
    serviceId: Uuid,
    score: z.number().nullable().describe("0-100; null when no check applied."),
    level: z.string().nullable(),
    levelName: z.string().nullable(),
    checks: z.array(ScorecardCheckResult),
    evaluatedAt: IsoDateTime,
  }).openapi("ScorecardResult");

  const PostureFinding = strict({
    resourceId: z.string(),
    pluginId: z.string(),
    pluginName: z.string(),
    resourceTypeId: z.string(),
    resourceTypeName: z.string(),
    accountId: z.string(),
    accountName: z.string(),
    displayName: z.string(),
    externalId: z.string().nullable(),
    ruleId: z.string(),
    title: z.string(),
    severity: z.enum(["critical", "high", "medium", "low"]),
    category: z.string(),
    reason: z.string(),
  }).openapi("ServicePostureFinding");

  const ServiceSummary = strict({
    service: Service,
    memberCount: z.number().int(),
    cost: strict({
      windowDays: z.number().int(),
      available: z
        .boolean()
        .describe("False when the cost warehouse could not be read; never read that as zero."),
      totals: z.array(strict({ currency: z.string(), amount: z.number() })),
      byProvider: z.array(
        strict({ pluginId: z.string(), currency: z.string(), amount: z.number() }),
      ),
      costedMembers: z.number().int(),
    }).describe(
      "Trailing member spend, per currency. Respects the caller's cost visibility scope.",
    ),
    slos: z.array(
      strict({
        id: Uuid,
        name: z.string(),
        status: z.enum(["exhausted", "fast_burn", "slow_burn", "ok", "unknown"]),
        targetPercent: z.number(),
        budgetRemaining: z.number().nullable(),
      }),
    ),
    runbooks: z.array(strict({ id: Uuid, name: z.string(), enabled: z.boolean() })),
    onCall: strict({
      scheduleId: Uuid,
      scheduleName: z.string(),
      enabled: z.boolean(),
      current: strict({
        userId: z.string(),
        name: z.string().nullable(),
        email: z.string().nullable(),
        endsAt: IsoDateTime,
      }).nullable(),
      next: strict({
        userId: z.string(),
        name: z.string().nullable(),
        email: z.string().nullable(),
      }).nullable(),
    }).nullable(),
    findings: strict({
      posture: strict({
        counts: strict({
          critical: z.number().int(),
          high: z.number().int(),
          medium: z.number().int(),
          low: z.number().int(),
        }),
        items: z.array(PostureFinding).describe("At most 25, worst first."),
      }),
      orphans: z.array(
        strict({ resourceId: z.string(), resourceName: z.string(), reason: z.string() }),
      ),
      backups: z.array(
        strict({
          resourceId: z.string(),
          resourceName: z.string(),
          kind: z
            .string()
            .describe(
              "`unprotected`, `rpo-breach`, `retention-below-policy`, `drill-stale`, " +
                "`drill-failed` or `drill-never`.",
            ),
          detail: z.string(),
        }),
      ),
      unavailable: z.array(z.enum(["posture", "orphans", "backups"])),
    }),
    recentChanges: z.array(
      strict({
        id: z.string(),
        resourceId: z.string(),
        resourceName: z.string(),
        pluginId: z.string(),
        changeKind: z.enum(["created", "updated", "deleted"]),
        fields: z.array(z.string()),
        at: IsoDateTime,
      }),
    ),
    scorecards: z.array(ScorecardResult),
    generatedAt: IsoDateTime,
  }).openapi("ServiceSummary");

  const ServiceRef = strict({
    id: Uuid,
    name: z.string(),
    slug: z.string(),
    tier: Tier.nullable(),
  }).openapi("ServiceRef");

  const ServicesForResources = strict({
    services: z
      .record(z.string(), z.array(ServiceRef))
      .describe("Resource id to the services it belongs to; resources in none are absent."),
  }).openapi("ServicesForResources");

  const HistoryPoint = strict({
    day: z.string().describe("`YYYY-MM-DD`, UTC."),
    score: z.number().nullable(),
    level: z.string().nullable(),
  }).openapi("ScorecardHistoryPoint");

  const ServiceScorecards = strict({
    results: z.array(ScorecardResult),
    history: z
      .record(z.string(), z.array(HistoryPoint))
      .describe("Per scorecard id, oldest first, at most 90 days."),
  }).openapi("ServiceScorecards");

  // --- Scorecards -----------------------------------------------------------

  const ScorecardCheck = strict({
    id: z.string().describe("Stable within the scorecard."),
    type: CheckType,
    name: z.string().nullable().describe("Display override; the type's label when null."),
    weight: z.number().int().describe("1 to 10."),
    params: z
      .record(z.string(), z.union([z.number(), z.array(z.string())]))
      .describe(
        "Type parameters: `minBudgetRemainingPercent` (0-100), `drillWithinDays` (1-730), " +
          "`severities` (critical/high/medium/low), `tags` (tag keys), " +
          "`maxFailureRatePercent` (0-100), `windowDays` (1-90).",
      ),
  }).openapi("ScorecardCheck");

  const ScorecardLevel = strict({
    key: z.string().describe("Lower-case letters, digits, dashes and underscores; unique."),
    name: z.string().describe("At most 40 characters."),
    minScore: z.number().describe("0 to 100; unique within the scorecard."),
    color: z.string().nullable().describe("Six-digit hex, e.g. `#d4a72c`."),
  }).openapi("ScorecardLevel");

  const scorecardFields = {
    name: z.string().describe("Unique in the organization; at most 120 characters."),
    description: z.string().nullable().describe("At most 1000 characters."),
    checks: z.array(ScorecardCheck).describe("1 to 30 checks."),
    levels: z.array(ScorecardLevel).describe("1 to 6 levels; stored lowest first."),
    applicableTiers: z.array(Tier).describe("Tiers it applies to; empty means every service."),
    alertOnLevelDrop: z
      .boolean()
      .describe("Route a `scorecardAlerts` alert when a service drops a level."),
    enabled: z.boolean(),
  };

  const Scorecard = strict({
    id: Uuid,
    ...scorecardFields,
    isDefault: z.boolean().describe("The scorecard seeded for the organization."),
    lastEvaluatedAt: IsoDateTime.nullable(),
    createdAt: IsoDateTime,
    updatedAt: IsoDateTime,
  }).openapi("Scorecard");

  const ScorecardList = strict({ scorecards: z.array(Scorecard) }).openapi("ScorecardList");

  const ScorecardCreate = strict({
    name: scorecardFields.name,
    description: scorecardFields.description.optional(),
    checks: scorecardFields.checks.optional(),
    levels: scorecardFields.levels.optional(),
    applicableTiers: scorecardFields.applicableTiers.optional(),
    alertOnLevelDrop: scorecardFields.alertOnLevelDrop.optional(),
    enabled: scorecardFields.enabled.optional(),
  }).openapi("ScorecardCreate");

  const ScorecardUpdate = strict({
    name: scorecardFields.name.optional(),
    description: scorecardFields.description.optional(),
    checks: scorecardFields.checks.optional(),
    levels: scorecardFields.levels.optional(),
    applicableTiers: scorecardFields.applicableTiers.optional(),
    alertOnLevelDrop: scorecardFields.alertOnLevelDrop.optional(),
    enabled: scorecardFields.enabled.optional(),
  }).openapi("ScorecardUpdate");

  const ScorecardOverview = strict({
    scorecards: z.array(Scorecard),
    services: z.array(
      strict({
        id: Uuid,
        name: z.string(),
        slug: z.string(),
        tier: Tier.nullable(),
        ownerTeam: z.string().nullable(),
      }),
    ),
    results: z.array(ScorecardResult),
  }).openapi("ScorecardOverview");

  const ServiceIdParam = OrgIdParam.extend({
    serviceId: z.string().describe("Service id or slug."),
  });
  const MemberParam = ServiceIdParam.extend({ resourceId: z.string() });
  const ScorecardIdParam = OrgIdParam.extend({ scorecardId: Uuid });
  const tags = ["Services"];
  const scTags = ["Scorecards"];
  const json = <T extends z.ZodTypeAny>(description: string, schema: T) => ({
    description,
    content: { "application/json": { schema } },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/services",
    tags,
    summary: "List services",
    description:
      "Every service with its owners, links, resolved member count and current scorecard levels.",
    request: { params: OrgIdParam },
    responses: { 200: json("The services", ServiceList) },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/services/for-resources",
    tags,
    summary: "Look up the services resources belong to",
    description:
      "Membership is explicit members plus rules minus exclusions, resolved against the " +
      "current inventory. Resources in no service are absent from the map.",
    request: {
      params: OrgIdParam,
      query: strict({
        ids: z.string().describe("Comma-separated Infrawrench resource ids (at most 500)."),
      }),
    },
    responses: {
      200: json("Services per resource", ServicesForResources),
      400: ErrorResponses[400],
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/services/{serviceId}",
    tags,
    summary: "Read a service with its members",
    request: { params: ServiceIdParam },
    responses: { 200: json("The service", ServiceDetail), 404: ErrorResponses[404] },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/services/{serviceId}/summary",
    tags,
    summary: "Summarize a service",
    description:
      "Trailing 30-day member spend (scoped to the caller's cost visibility), linked SLO " +
      "standing, open posture, orphan and backup findings on members, the current on-call " +
      "shift, the last week's changes and current scorecard results. Feeds that fail are " +
      "listed in `findings.unavailable` or `cost.available` rather than failing the request.",
    request: { params: ServiceIdParam },
    responses: { 200: json("The summary", ServiceSummary), 404: ErrorResponses[404] },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/services/{serviceId}/scorecards",
    tags,
    summary: "Read a service's scorecard results and history",
    request: { params: ServiceIdParam },
    responses: { 200: json("Results and history", ServiceScorecards), 404: ErrorResponses[404] },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/services",
    tags,
    summary: "Create a service",
    description:
      "Owners, the on-call schedule, SLOs and runbooks must belong to the organization. " +
      "Audit-logged.",
    request: {
      params: OrgIdParam,
      body: { content: { "application/json": { schema: ServiceCreate } } },
    },
    responses: {
      201: json("The created service", Service),
      400: ErrorResponses[400],
      404: ErrorResponses[404],
      409: ErrorResponses[409],
    },
  });

  registry.registerPath({
    method: "patch",
    path: "/api/org/{orgId}/services/{serviceId}",
    tags,
    summary: "Update a service",
    description:
      "Omitted fields keep their value. List fields (owners, links, SLOs, runbooks, rules) " +
      "replace the stored list. Audit-logged.",
    request: {
      params: ServiceIdParam,
      body: { content: { "application/json": { schema: ServiceUpdate } } },
    },
    responses: {
      200: json("The updated service", Service),
      400: ErrorResponses[400],
      404: ErrorResponses[404],
      409: ErrorResponses[409],
    },
  });

  registry.registerPath({
    method: "delete",
    path: "/api/org/{orgId}/services/{serviceId}",
    tags,
    summary: "Delete a service",
    description: "The member resources, SLOs, runbooks and schedule are untouched. Audit-logged.",
    request: { params: ServiceIdParam },
    responses: { 204: { description: "Deleted" }, 404: ErrorResponses[404] },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/services/{serviceId}/members",
    tags,
    summary: "Add members to a service",
    description: "Adds resources by hand. An excluded resource is put back. Audit-logged.",
    request: {
      params: ServiceIdParam,
      body: { content: { "application/json": { schema: ServiceMembersRequest } } },
    },
    responses: {
      200: json("The service with its members", ServiceDetail),
      400: ErrorResponses[400],
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "delete",
    path: "/api/org/{orgId}/services/{serviceId}/members/{resourceId}",
    tags,
    summary: "Remove a member from a service",
    description:
      "A hand-added member is removed; a rule-matched one is excluded, since the rule would " +
      "otherwise put it back. With `restore=1`, deletes an exclusion instead. Audit-logged.",
    request: {
      params: MemberParam,
      query: strict({
        restore: z.literal("1").optional().describe("Delete an exclusion instead."),
      }),
    },
    responses: {
      200: json("The service with its members", ServiceDetail),
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/scorecards",
    tags: scTags,
    summary: "List scorecards",
    description:
      "Seeds the default scorecard for organizations that have never had one (once; a deleted " +
      "default is not recreated).",
    request: { params: OrgIdParam },
    responses: { 200: json("The scorecards", ScorecardList) },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/scorecards/overview",
    tags: scTags,
    summary: "Read the scorecard matrix",
    description: "Every service, every scorecard and the current result for each applicable pair.",
    request: { params: OrgIdParam },
    responses: { 200: json("The matrix", ScorecardOverview) },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/scorecards/{scorecardId}",
    tags: scTags,
    summary: "Read a scorecard",
    request: { params: ScorecardIdParam },
    responses: { 200: json("The scorecard", Scorecard), 404: ErrorResponses[404] },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/scorecards",
    tags: scTags,
    summary: "Create a scorecard",
    description:
      "Omitted checks and levels default to every built-in check and bronze/silver/gold. " +
      "Out-of-range inputs are rejected. Audit-logged.",
    request: {
      params: OrgIdParam,
      body: { content: { "application/json": { schema: ScorecardCreate } } },
    },
    responses: {
      201: json("The created scorecard", Scorecard),
      400: ErrorResponses[400],
      409: ErrorResponses[409],
    },
  });

  registry.registerPath({
    method: "patch",
    path: "/api/org/{orgId}/scorecards/{scorecardId}",
    tags: scTags,
    summary: "Update a scorecard",
    description:
      "Omitted fields keep their value; `checks` and `levels` replace the stored lists. " +
      "Services are re-scored within one poller tick. Audit-logged.",
    request: {
      params: ScorecardIdParam,
      body: { content: { "application/json": { schema: ScorecardUpdate } } },
    },
    responses: {
      200: json("The updated scorecard", Scorecard),
      400: ErrorResponses[400],
      404: ErrorResponses[404],
      409: ErrorResponses[409],
    },
  });

  registry.registerPath({
    method: "delete",
    path: "/api/org/{orgId}/scorecards/{scorecardId}",
    tags: scTags,
    summary: "Delete a scorecard",
    description: "Its results and history go with it. Audit-logged.",
    request: { params: ScorecardIdParam },
    responses: { 204: { description: "Deleted" }, 404: ErrorResponses[404] },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/scorecards/{scorecardId}/evaluate",
    tags: scTags,
    summary: "Score every service on a scorecard now",
    description:
      "Level drops found here are stored but not announced: the caller just changed the bar.",
    request: { params: ScorecardIdParam },
    responses: {
      200: json("The matrix after scoring", ScorecardOverview),
      404: ErrorResponses[404],
    },
  });
}
