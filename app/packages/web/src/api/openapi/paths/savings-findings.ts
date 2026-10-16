import { z } from "../zod";
import { strict, ErrorResponses, Ok, OrgIdParam, Uuid, IsoDateTime } from "../common";
import type { BuildContext } from "../context";
import {
  SAVINGS_FINDING_KINDS,
  SAVINGS_FINDING_LIMITS,
  SAVINGS_FINDING_SORT_FIELDS,
  SAVINGS_FINDING_STATUSES,
  SAVINGS_FINDING_STATUS_FILTERS,
  SAVINGS_VIEW_LIMITS,
} from "@infrawrench/client-core";

const IsoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .openapi({ example: "2026-10-01" });

export function registerSavingsFindingPaths(ctx: BuildContext) {
  const { registry } = ctx;

  const Kind = z
    .enum(SAVINGS_FINDING_KINDS)
    .describe(
      "Which finder reported it: `orphan` (orphaned or idle resource), `oversized` " +
        "(right-sizing), `extended_support` (a version past standard support), `seat` (an " +
        "unused, duplicate or downgradable SaaS seat).",
    )
    .openapi("SavingsFindingKind");

  const Status = z
    .enum(SAVINGS_FINDING_STATUSES)
    .describe(
      "`ready` (Ready for review), `in_progress`, `completed`, `archived`. Ready and In " +
        "progress are open: their money counts as potential savings.",
    )
    .openapi("SavingsFindingStatus");

  const StatusFilter = z
    .enum(SAVINGS_FINDING_STATUS_FILTERS)
    .describe("A status, `open` (Ready or In progress), or `all`.")
    .openapi("SavingsFindingStatusFilter");

  const Money = strict({
    amount: z.number().describe("Currency units (not cents)."),
    currency: z.string().openapi({ example: "USD" }),
  }).openapi("SavingsFindingMoney");

  const Actor = strict({
    userId: z.string(),
    name: z.string().nullable().describe("Display name or email; null when the member has left."),
  }).openapi("SavingsFindingActor");

  const Finding = strict({
    key: z
      .string()
      .describe("`<kind>:<sourceId>`, stable across scans; the handle for status changes.")
      .openapi({ example: "orphan:4f6c0a52-9b1e-4f0e-8d3c-2b7a7c1d9e10" }),
    kind: Kind,
    sourceId: z.string(),
    title: z.string(),
    detail: z.string().nullable(),
    pluginId: z.string().nullable(),
    pluginName: z.string().nullable(),
    accountId: z.string().nullable(),
    accountName: z.string().nullable(),
    region: z.string().nullable(),
    resourceId: z.string().nullable().describe("Infrawrench resource id; null for seats."),
    resourceName: z.string(),
    resourceTypeId: z.string().nullable(),
    resourceTypeName: z.string().nullable(),
    tags: z.record(z.string()),
    monthlySavings: Money.nullable().describe(
      "What acting on it saves per month; null when the finder has no price (and, for " +
        "orphans, when the caller lacks `costs:read`, as on `/orphans`).",
    ),
    status: Status,
    statusChangedAt: IsoDateTime.nullable(),
    statusChangedBy: Actor.nullable().describe("Null for the initial Ready and automatic changes."),
    statusNote: z.string().nullable(),
    resolution: z
      .enum(["manual", "resolved"])
      .nullable()
      .describe(
        "For Completed: `manual` when a person completed it, `resolved` when a scan stopped " +
          "reporting it (the resource was removed, resized or is in use again).",
      ),
    detectedAt: IsoDateTime.describe("First observation of this occurrence."),
    lastSeenAt: IsoDateTime,
    present: z.boolean().describe("False once a scan stopped reporting it."),
    realizedSavings: strict({ eventId: Uuid, title: z.string() })
      .nullable()
      .describe("The realized savings entry recorded for the fix, when one matches."),
  }).openapi("SavingsFinding");

  const Summary = strict({
    counts: strict({
      ready: z.number().int(),
      in_progress: z.number().int(),
      completed: z.number().int(),
      archived: z.number().int(),
    }),
    potentialMonthly: z
      .array(Money)
      .describe("Monthly savings of open findings, per currency, largest first."),
    unpricedOpenCount: z.number().int().describe("Open findings with no price; never summed."),
    realized: z
      .array(Money)
      .nullable()
      .describe(
        "Realized savings over the trailing `realizedWindowDays`, per currency (the realized " +
          "savings report). Null without `costs:read`.",
      ),
    realizedWindowDays: z.number().int(),
    savingsRate: z
      .array(strict({ currency: z.string(), rate: z.number().min(0).max(1) }))
      .nullable()
      .describe(
        "Realized ÷ (realized + potential) per currency: the share of the identified monthly " +
          "opportunity already captured. Currencies with nothing on either side are omitted.",
      ),
  }).openapi("SavingsFindingsSummary");

  const Response = strict({
    findings: z.array(Finding).describe("Matching findings, filtered and sorted."),
    summary: Summary.describe("Over every finding the caller can see, ignoring filters."),
    unavailable: z
      .array(strict({ kind: Kind, error: z.string() }))
      .describe("Finders that failed to compute this time; their findings are not fixed."),
    generatedAt: IsoDateTime,
  }).openapi("SavingsFindingsResponse");

  const q = (name: string, description: string, schema: z.ZodTypeAny = z.string()) =>
    schema.optional().openapi({ param: { name, in: "query" }, description });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/savings/findings",
    tags: ["Savings findings"],
    summary: "List savings findings",
    description:
      "Every savings finder's findings (orphaned and idle resources, oversized resources, " +
      "extended support surcharges, unused SaaS seats) with a lifecycle status, a detected " +
      "date and summary tiles. Open findings that a scan stops reporting move to Completed " +
      "automatically (`resolution: resolved`); a finding that returns after that reopens as " +
      "Ready with a new detected date. A cost-scoped caller sees only findings on accounts " +
      "granted to them outright.",
    request: {
      params: OrgIdParam,
      query: z.object({
        view: q("view", "Apply a saved view, by id or name. Explicit params override it."),
        status: q("status", "Status tab. Defaults to `all` (or the view's).", StatusFilter),
        kind: q("kind", "Comma-separated finding kinds."),
        provider: q("provider", "Comma-separated plugin ids."),
        account: q("account", "Comma-separated account ids."),
        region: q("region", "Comma-separated regions."),
        tag: q("tag", "`key` or `key=value`; repeat for more terms (all must match)."),
        minSavings: q(
          "minSavings",
          "Minimum monthly savings, in each finding's own currency. Unpriced findings never pass.",
        ),
        detectedFrom: q("detectedFrom", "Detected on or after (UTC day).", IsoDate),
        detectedTo: q("detectedTo", "Detected on or before (UTC day).", IsoDate),
        q: q("q", "Case-insensitive text match over title, resource and account."),
        sort: q(
          "sort",
          `\`<field>:<asc|desc>\`; fields ${SAVINGS_FINDING_SORT_FIELDS.join(", ")}.`,
        ),
        refresh: q("refresh", "`true` bypasses the right-sizing and extended support caches."),
      }),
    },
    responses: {
      200: { description: "Findings", content: { "application/json": { schema: Response } } },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
    },
  });

  const StatusInput = strict({
    keys: z.array(z.string()).min(1).max(SAVINGS_FINDING_LIMITS.maxBulkKeys),
    status: Status,
    note: z
      .string()
      .max(SAVINGS_FINDING_LIMITS.maxNoteLength)
      .nullable()
      .optional()
      .describe("Recorded on every finding changed; absent or null clears the previous note."),
  }).openapi("SavingsFindingStatusInput");

  const StatusChange = strict({
    key: z.string(),
    status: Status,
    statusChangedAt: IsoDateTime,
    statusChangedBy: Actor.nullable(),
    statusNote: z.string().nullable(),
    resolution: z.enum(["manual", "resolved"]).nullable(),
  }).openapi("SavingsFindingStatusChange");

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/savings/findings/status",
    tags: ["Savings findings"],
    summary: "Change savings finding status",
    description:
      "Moves findings to a status, recording who, when and an optional note; Completed by hand " +
      "records `resolution: manual`. Audited per finding and published as the " +
      "`savings.finding.status_changed` event. Keys the caller cannot see come back in " +
      "`missing`; a 404 when none matched.",
    request: {
      params: OrgIdParam,
      body: { content: { "application/json": { schema: StatusInput } }, required: true },
    },
    responses: {
      200: {
        description: "Changed",
        content: {
          "application/json": {
            schema: strict({ updated: z.array(StatusChange), missing: z.array(z.string()) }),
          },
        },
      },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
    },
  });

  const Filter = strict({
    kinds: z.array(Kind).optional(),
    pluginIds: z.array(z.string()).max(SAVINGS_VIEW_LIMITS.maxFilterValues).optional(),
    accountIds: z.array(z.string()).max(SAVINGS_VIEW_LIMITS.maxFilterValues).optional(),
    regions: z.array(z.string()).max(SAVINGS_VIEW_LIMITS.maxFilterValues).optional(),
    tags: z
      .array(strict({ key: z.string().min(1), values: z.array(z.string()).optional() }))
      .max(SAVINGS_VIEW_LIMITS.maxTagTerms)
      .optional()
      .describe("Every term must match; a term without values matches any value of the key."),
    minMonthlySavings: z.number().min(0).nullable().optional(),
    detectedFrom: IsoDate.nullable().optional(),
    detectedTo: IsoDate.nullable().optional(),
    search: z.string().max(SAVINGS_VIEW_LIMITS.maxSearchLength).nullable().optional(),
  })
    .describe("Empty lists and blank fields are dropped on write.")
    .openapi("SavingsFindingFilter");

  const Sort = strict({
    field: z.enum(SAVINGS_FINDING_SORT_FIELDS),
    direction: z.enum(["asc", "desc"]),
  }).openapi("SavingsFindingSort");

  const ViewInput = strict({
    name: z.string().min(1).max(SAVINGS_VIEW_LIMITS.maxNameLength),
    description: z.string().max(SAVINGS_VIEW_LIMITS.maxDescriptionLength).nullable().optional(),
    status: StatusFilter.optional().describe("Defaults to `open`."),
    filter: Filter.optional(),
    sort: Sort.optional().describe("Defaults to savings, largest first."),
  }).openapi("SavingsViewInput");

  const View = strict({
    id: Uuid,
    name: z.string(),
    description: z.string().nullable(),
    status: StatusFilter,
    filter: Filter,
    sort: Sort,
    createdByUserId: z.string().nullable(),
    createdAt: IsoDateTime,
    updatedAt: IsoDateTime,
  }).openapi("SavingsView");

  const idParam = OrgIdParam.extend({ id: Uuid.openapi({ param: { name: "id", in: "path" } }) });
  const conflict = {
    description: "A live savings view already uses this name.",
    content: { "application/json": { schema: strict({ error: z.string() }) } },
  };

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/savings-views",
    tags: ["Savings findings"],
    summary: "List savings views",
    description:
      "Saved views over the savings findings list: a status tab, a filter and a sort. " +
      "Narrowed by per-object sharing (`savings_view`); the creator owns a view.",
    request: { params: OrgIdParam },
    responses: {
      200: {
        description: "Views the caller can see, alphabetically",
        content: { "application/json": { schema: z.array(View) } },
      },
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/savings-views",
    tags: ["Savings findings"],
    summary: "Create a savings view",
    description: "Names are unique per organization, case-insensitively.",
    request: {
      params: OrgIdParam,
      body: { content: { "application/json": { schema: ViewInput } }, required: true },
    },
    responses: {
      200: { description: "Created", content: { "application/json": { schema: View } } },
      400: ErrorResponses[400],
      409: conflict,
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/savings-views/{id}",
    tags: ["Savings findings"],
    summary: "Get a savings view",
    request: { params: idParam },
    responses: {
      200: { description: "The view", content: { "application/json": { schema: View } } },
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "put",
    path: "/api/org/{orgId}/savings-views/{id}",
    tags: ["Savings findings"],
    summary: "Update a savings view",
    description: "Full replace. Needs editor on the view.",
    request: {
      params: idParam,
      body: { content: { "application/json": { schema: ViewInput } }, required: true },
    },
    responses: {
      200: { description: "Updated", content: { "application/json": { schema: View } } },
      400: ErrorResponses[400],
      403: ErrorResponses[403],
      404: ErrorResponses[404],
      409: conflict,
    },
  });

  registry.registerPath({
    method: "delete",
    path: "/api/org/{orgId}/savings-views/{id}",
    tags: ["Savings findings"],
    summary: "Delete a savings view",
    description: "Soft delete. Needs owner on the view (or editor when nobody owns it).",
    request: { params: idParam },
    responses: {
      200: { description: "Deleted", content: { "application/json": { schema: Ok } } },
      403: ErrorResponses[403],
      404: ErrorResponses[404],
    },
  });
}
