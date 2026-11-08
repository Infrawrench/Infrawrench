/**
 * The savings findings workflow, the endpoint definitions:
 *
 * - `/api/org/:orgId/savings/findings`: every finder's findings with their
 *   lifecycle status, detected date and summary tiles; `POST /status` moves
 *   findings between Ready for review, In progress, Completed and Archived.
 * - `/api/org/:orgId/savings-views`: saved views (filter + status tab +
 *   sort), narrowed by per-object sharing (`savings_view`).
 *
 * Reading is `resources:read`, the finders' own permission. Changing a status
 * is `resources:write`: archiving a finding takes it off everyone's list, a
 * statement about the resource rather than a personal preference. Views
 * follow the same split.
 *
 * The bodies and the findings query are checked by client-core's normalizers,
 * which answer with their own sentences, so the schemas here document them.
 */
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
import {
  SAVINGS_FINDING_KINDS,
  SAVINGS_FINDING_LIMITS,
  SAVINGS_FINDING_SORT_FIELDS,
  SAVINGS_FINDING_STATUSES,
  SAVINGS_FINDING_STATUS_FILTERS,
  SAVINGS_VIEW_LIMITS,
} from "@infrawrench/client-core";
import { maxLength, minLength, pattern } from "@infrawrench/ui/schemas";
import { RequiredPermission, SuccessDescription } from "../../annotations";
import { withApiDefaults } from "../../domain";
import { BadRequest, Conflict, Forbidden, NotFound } from "../../errors";
import { OrgAuth } from "../../middleware-tags";
import { IsoDateTime, Ok, OrgIdParams, OrgParams, Uuid } from "../../schemas/common";
import { documentedAs } from "../../schemas/documented";
import { describeQuery } from "../../schemas/params";

const day = (description?: string) =>
  Schema.String.annotate({
    examples: ["2026-10-01"],
    ...(description === undefined ? {} : { description }),
  }).check(pattern(/^\d{4}-\d{2}-\d{2}$/));

const IsoDay = day();

const Kind = Schema.Literals(SAVINGS_FINDING_KINDS).annotate({
  identifier: "SavingsFindingKind",
  description:
    "Which finder reported it: `orphan` (orphaned or idle resource), `oversized` " +
    "(right-sizing), `extended_support` (a version past standard support), `seat` (an " +
    "unused, duplicate or downgradable SaaS seat).",
});

const Status = Schema.Literals(SAVINGS_FINDING_STATUSES).annotate({
  identifier: "SavingsFindingStatus",
  description:
    "`ready` (Ready for review), `in_progress`, `completed`, `archived`. Ready and In " +
    "progress are open: their money counts as potential savings.",
});

const StatusFilter = Schema.Literals(SAVINGS_FINDING_STATUS_FILTERS).annotate({
  identifier: "SavingsFindingStatusFilter",
  description: "A status, `open` (Ready or In progress), or `all`.",
});

const Money = Schema.Struct({
  amount: Schema.Finite.annotate({ description: "Currency units (not cents)." }),
  currency: Schema.String.annotate({ examples: ["USD"] }),
}).annotate({ identifier: "SavingsFindingMoney" });

const Actor = Schema.Struct({
  userId: Schema.String,
  name: Schema.NullOr(Schema.String).annotate({
    description: "Display name or email; null when the member has left.",
  }),
}).annotate({ identifier: "SavingsFindingActor" });

const Resolution = Schema.NullOr(Schema.Literals(["manual", "resolved"]));

const Finding = Schema.Struct({
  key: Schema.String.annotate({
    description: "`<kind>:<sourceId>`, stable across scans; the handle for status changes.",
    examples: ["orphan:4f6c0a52-9b1e-4f0e-8d3c-2b7a7c1d9e10"],
  }),
  kind: Kind,
  sourceId: Schema.String,
  title: Schema.String,
  detail: Schema.NullOr(Schema.String),
  pluginId: Schema.NullOr(Schema.String),
  pluginName: Schema.NullOr(Schema.String),
  accountId: Schema.NullOr(Schema.String),
  accountName: Schema.NullOr(Schema.String),
  region: Schema.NullOr(Schema.String),
  resourceId: Schema.NullOr(Schema.String).annotate({
    description: "Infrawrench resource id; null for seats.",
  }),
  resourceName: Schema.String,
  resourceTypeId: Schema.NullOr(Schema.String),
  resourceTypeName: Schema.NullOr(Schema.String),
  tags: Schema.Record(Schema.String, Schema.String),
  monthlySavings: Schema.NullOr(Money).annotate({
    description:
      "What acting on it saves per month; null when the finder has no price (and, for " +
      "orphans, when the caller lacks `costs:read`, as on `/orphans`).",
  }),
  status: Status,
  statusChangedAt: Schema.NullOr(IsoDateTime),
  statusChangedBy: Schema.NullOr(Actor).annotate({
    description: "Null for the initial Ready and automatic changes.",
  }),
  statusNote: Schema.NullOr(Schema.String),
  resolution: Resolution.annotate({
    description:
      "For Completed: `manual` when a person completed it, `resolved` when a scan stopped " +
      "reporting it (the resource was removed, resized or is in use again).",
  }),
  detectedAt: IsoDateTime.annotate({ description: "First observation of this occurrence." }),
  lastSeenAt: IsoDateTime,
  present: Schema.Boolean.annotate({ description: "False once a scan stopped reporting it." }),
  realizedSavings: Schema.NullOr(Schema.Struct({ eventId: Uuid, title: Schema.String })).annotate({
    description: "The realized savings entry recorded for the fix, when one matches.",
  }),
}).annotate({ identifier: "SavingsFinding" });

const Summary = Schema.Struct({
  counts: Schema.Struct({
    ready: Schema.Int,
    in_progress: Schema.Int,
    completed: Schema.Int,
    archived: Schema.Int,
  }),
  potentialMonthly: Schema.Array(Money).annotate({
    description: "Monthly savings of open findings, per currency, largest first.",
  }),
  unpricedOpenCount: Schema.Int.annotate({
    description: "Open findings with no price; never summed.",
  }),
  realized: Schema.NullOr(Schema.Array(Money)).annotate({
    description:
      "Realized savings over the trailing `realizedWindowDays`, per currency (the realized " +
      "savings report). Null without `costs:read`.",
  }),
  realizedWindowDays: Schema.Int,
  savingsRate: Schema.NullOr(
    Schema.Array(
      Schema.Struct({
        currency: Schema.String,
        rate: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
      }),
    ),
  ).annotate({
    description:
      "Realized ÷ (realized + potential) per currency: the share of the identified monthly " +
      "opportunity already captured. Currencies with nothing on either side are omitted.",
  }),
}).annotate({
  identifier: "SavingsFindingsSummary",
  description: "Over every finding the caller can see, ignoring filters.",
});

export const SavingsFindingsResponse = Schema.Struct({
  findings: Schema.Array(Finding).annotate({
    description: "Matching findings, filtered and sorted.",
  }),
  // A bare reference, as before: describing the key would wrap it in an
  // `allOf`, so the description is the component's.
  summary: Summary,
  unavailable: Schema.Array(Schema.Struct({ kind: Kind, error: Schema.String })).annotate({
    description: "Finders that failed to compute this time; their findings are not fixed.",
  }),
  generatedAt: IsoDateTime,
}).annotate({ identifier: "SavingsFindingsResponse" });

const StatusInput = Schema.Struct({
  keys: Schema.Array(Schema.String).check(
    minLength(1),
    maxLength(SAVINGS_FINDING_LIMITS.maxBulkKeys),
  ),
  status: Status,
  note: Schema.optionalKey(
    Schema.NullOr(Schema.String.check(maxLength(SAVINGS_FINDING_LIMITS.maxNoteLength))).annotate({
      description: "Recorded on every finding changed; absent or null clears the previous note.",
    }),
  ),
}).annotate({ identifier: "SavingsFindingStatusInput" });

const StatusChange = Schema.Struct({
  key: Schema.String,
  status: Status,
  statusChangedAt: IsoDateTime,
  statusChangedBy: Schema.NullOr(Actor),
  statusNote: Schema.NullOr(Schema.String),
  resolution: Resolution,
}).annotate({ identifier: "SavingsFindingStatusChange" });

export const SavingsFindingStatusResult = Schema.Struct({
  updated: Schema.Array(StatusChange),
  missing: Schema.Array(Schema.String),
});

const filterValues = Schema.Array(Schema.String).check(
  maxLength(SAVINGS_VIEW_LIMITS.maxFilterValues),
);

const Filter = Schema.Struct({
  kinds: Schema.optionalKey(Schema.Array(Kind)),
  pluginIds: Schema.optionalKey(filterValues),
  accountIds: Schema.optionalKey(filterValues),
  regions: Schema.optionalKey(filterValues),
  tags: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        key: Schema.String.check(minLength(1)),
        values: Schema.optionalKey(Schema.Array(Schema.String)),
      }),
    )
      .annotate({
        description: "Every term must match; a term without values matches any value of the key.",
      })
      .check(maxLength(SAVINGS_VIEW_LIMITS.maxTagTerms)),
  ),
  minMonthlySavings: Schema.optionalKey(
    Schema.NullOr(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))),
  ),
  detectedFrom: Schema.optionalKey(Schema.NullOr(IsoDay)),
  detectedTo: Schema.optionalKey(Schema.NullOr(IsoDay)),
  search: Schema.optionalKey(
    Schema.NullOr(Schema.String.check(maxLength(SAVINGS_VIEW_LIMITS.maxSearchLength))),
  ),
}).annotate({
  identifier: "SavingsFindingFilter",
  description: "Empty lists and blank fields are dropped on write.",
});

const Sort = Schema.Struct({
  field: Schema.Literals(SAVINGS_FINDING_SORT_FIELDS),
  direction: Schema.Literals(["asc", "desc"]),
}).annotate({ identifier: "SavingsFindingSort" });

const ViewInput = Schema.Struct({
  name: Schema.String.check(minLength(1), maxLength(SAVINGS_VIEW_LIMITS.maxNameLength)),
  description: Schema.optionalKey(
    Schema.NullOr(Schema.String.check(maxLength(SAVINGS_VIEW_LIMITS.maxDescriptionLength))),
  ),
  status: Schema.optionalKey(StatusFilter).annotateKey({ description: "Defaults to `open`." }),
  filter: Schema.optionalKey(Filter),
  sort: Schema.optionalKey(Sort).annotateKey({
    description: "Defaults to savings, largest first.",
  }),
}).annotate({ identifier: "SavingsViewInput" });

export const SavingsView = Schema.Struct({
  id: Uuid,
  name: Schema.String,
  description: Schema.NullOr(Schema.String),
  status: StatusFilter,
  filter: Filter,
  sort: Sort,
  createdByUserId: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
}).annotate({ identifier: "SavingsView" });

/** A query parameter read as sent and documented as `doc`. */
const param = <S extends Schema.Top>(doc: S) => Schema.optionalKey(documentedAs(doc));
const text = (description: string) => param(Schema.String.annotate({ description }));

/** The 409 a write answers when the name is taken, described as the hand-written spec had it. */
const nameConflictResponse = (operation: Record<string, unknown>): Record<string, unknown> => {
  const responses = operation["responses"];
  if (typeof responses !== "object" || responses === null || !("409" in responses)) {
    return operation;
  }
  const conflict = responses["409"];
  if (typeof conflict !== "object" || conflict === null) return operation;
  return {
    ...operation,
    responses: {
      ...responses,
      "409": { ...conflict, description: "A live savings view already uses this name." },
    },
  };
};

export class SavingsFindingsGroup extends HttpApiGroup.make("savingsFindings")
  .add(
    HttpApiEndpoint.get("list", "/", {
      params: OrgParams,
      query: {
        view: text("Apply a saved view, by id or name. Explicit params override it."),
        status: param(StatusFilter),
        kind: text("Comma-separated finding kinds."),
        provider: text("Comma-separated plugin ids."),
        account: text("Comma-separated account ids."),
        region: text("Comma-separated regions."),
        // Repeatable, so an array: one value or several.
        tag: Schema.optionalKey(
          Schema.Array(Schema.String).annotate({
            description: "`key` or `key=value`; repeat for more terms (all must match).",
          }),
        ),
        minSavings: text(
          "Minimum monthly savings, in each finding's own currency. Unpriced findings never pass.",
        ),
        detectedFrom: param(day("Detected on or after (UTC day).")),
        detectedTo: param(day("Detected on or before (UTC day).")),
        q: text("Case-insensitive text match over title, resource and account."),
        sort: text(`\`<field>:<asc|desc>\`; fields ${SAVINGS_FINDING_SORT_FIELDS.join(", ")}.`),
        refresh: text("`true` bypasses the right-sizing and extended support caches."),
      },
      success: SavingsFindingsResponse,
      error: [BadRequest, NotFound],
    })
      .annotate(RequiredPermission, "resources:read")
      .annotate(OpenApi.Summary, "List savings findings")
      .annotate(
        OpenApi.Description,
        "Every savings finder's findings (orphaned and idle resources, oversized resources, " +
          "extended support surcharges, unused SaaS seats) with a lifecycle status, a detected " +
          "date and summary tiles. Open findings that a scan stops reporting move to Completed " +
          "automatically (`resolution: resolved`); a finding that returns after that reopens as " +
          "Ready with a new detected date. A cost-scoped caller sees only findings on accounts " +
          "granted to them outright.",
      )
      .annotate(SuccessDescription, "Findings")
      .annotate(
        OpenApi.Transform,
        describeQuery({ status: "Status tab. Defaults to `all` (or the view's)." }),
      ),
    HttpApiEndpoint.post("setStatus", "/status", {
      params: OrgParams,
      payload: StatusInput,
      success: SavingsFindingStatusResult,
      error: [BadRequest, NotFound],
    })
      .annotate(RequiredPermission, "resources:write")
      .annotate(OpenApi.Summary, "Change savings finding status")
      .annotate(
        OpenApi.Description,
        "Moves findings to a status, recording who, when and an optional note; Completed by hand " +
          "records `resolution: manual`. Audited per finding and published as the " +
          "`savings.finding.status_changed` event. Keys the caller cannot see come back in " +
          "`missing`; a 404 when none matched.",
      )
      .annotate(SuccessDescription, "Changed"),
  )
  .prefix("/api/org/:orgId/savings/findings")
  .middleware(OrgAuth)
  .annotate(OpenApi.Title, "Savings findings") {}

export class SavingsViewsGroup extends HttpApiGroup.make("savingsViews")
  .add(
    HttpApiEndpoint.get("list", "/", {
      params: OrgParams,
      success: Schema.Array(SavingsView),
    })
      .annotate(RequiredPermission, "resources:read")
      .annotate(OpenApi.Summary, "List savings views")
      .annotate(
        OpenApi.Description,
        "Saved views over the savings findings list: a status tab, a filter and a sort. " +
          "Narrowed by per-object sharing (`savings_view`); the creator owns a view.",
      )
      .annotate(SuccessDescription, "Views the caller can see, alphabetically"),
    HttpApiEndpoint.post("create", "/", {
      params: OrgParams,
      payload: ViewInput,
      success: SavingsView,
      error: [BadRequest, Conflict],
    })
      .annotate(RequiredPermission, "resources:write")
      .annotate(OpenApi.Summary, "Create a savings view")
      .annotate(OpenApi.Description, "Names are unique per organization, case-insensitively.")
      .annotate(SuccessDescription, "Created")
      .annotate(OpenApi.Transform, nameConflictResponse),
    HttpApiEndpoint.get("get", "/:id", {
      params: OrgIdParams,
      success: SavingsView,
      error: NotFound,
    })
      .annotate(RequiredPermission, "resources:read")
      .annotate(OpenApi.Summary, "Get a savings view")
      .annotate(SuccessDescription, "The view"),
    HttpApiEndpoint.put("update", "/:id", {
      params: OrgIdParams,
      payload: ViewInput,
      success: SavingsView,
      error: [BadRequest, Forbidden, NotFound, Conflict],
    })
      .annotate(RequiredPermission, "resources:write")
      .annotate(OpenApi.Summary, "Update a savings view")
      .annotate(OpenApi.Description, "Full replace. Needs editor on the view.")
      .annotate(SuccessDescription, "Updated")
      .annotate(OpenApi.Transform, nameConflictResponse),
    HttpApiEndpoint.delete("delete", "/:id", {
      params: OrgIdParams,
      success: Ok,
      error: [Forbidden, NotFound],
    })
      .annotate(RequiredPermission, "resources:write")
      .annotate(OpenApi.Summary, "Delete a savings view")
      .annotate(
        OpenApi.Description,
        "Soft delete. Needs owner on the view (or editor when nobody owns it).",
      )
      .annotate(SuccessDescription, "Deleted"),
  )
  .prefix("/api/org/:orgId/savings-views")
  .middleware(OrgAuth)
  .annotate(OpenApi.Title, "Savings findings") {}

export class SavingsFindingsApi extends withApiDefaults(
  HttpApi.make("savingsFindings").add(SavingsFindingsGroup).add(SavingsViewsGroup),
) {}
