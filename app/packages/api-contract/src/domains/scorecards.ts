/**
 * Scorecards: `/api/org/:orgId/scorecards`, the endpoint definitions.
 *
 * Org-defined checks, weights and levels every service is graded against,
 * the matrix, an evaluate-now for the editor, and the org grade above the
 * matrix. Reads are `resources:read`, writes `resources:write`: the SLO
 * stance. The org grade is `resources:read` too, like every feed it reads:
 * gating the summary more tightly than its parts would be a lock on a door
 * with no walls.
 *
 * The write bodies are documented here and checked by hand in the handlers,
 * whose 400s name the field at fault, so those endpoints are served raw.
 */
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/http-api";
import { ORG_SCORECARD_PILLARS, ORG_SCORECARD_RETENTION_DAYS } from "@infrawrench/client-core";
import { RequiredPermission, SuccessDescription } from "../http/annotations";
import { withApiDefaults } from "../http/api-defaults";
import { BadRequest, Conflict, NotFound } from "../http/errors";
import { OrgAuth } from "../http/middleware-tags";
import { IsoDateTime, OrgId, OrgParams, Uuid } from "../http/schemas/common";
import { documentedAs, optionalRequestBody } from "../http/schemas/documented";
import { ScorecardCheckType, ScorecardResult, ServiceTier } from "../http/schemas/service-catalog";

const OrgScorecardPillarId = Schema.Literals(ORG_SCORECARD_PILLARS).annotate({
  identifier: "OrgScorecardPillarId",
  description:
    "Which existing feed the org grade pillar reads. Each is a reading of a feed that " +
    "already exists, so a pillar can never disagree with the page it links to.",
});

const OrgScorecardGrade = Schema.Literals(["A", "B", "C", "D", "F"]).annotate({
  identifier: "OrgScorecardGrade",
});

const Percent = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100 }));

const ScorecardCheck = Schema.Struct({
  id: Schema.String.annotate({ description: "Stable within the scorecard." }),
  type: ScorecardCheckType,
  name: Schema.NullOr(Schema.String).annotate({
    description: "Display override; the type's label when null.",
  }),
  weight: Schema.Int.annotate({ description: "1 to 10." }),
  params: Schema.Record(
    Schema.String,
    Schema.Union([Schema.Finite, Schema.Array(Schema.String)]),
  ).annotate({
    description:
      "Type parameters: `minBudgetRemainingPercent` (0-100), `drillWithinDays` (1-730), " +
      "`severities` (critical/high/medium/low), `tags` (tag keys), " +
      "`maxFailureRatePercent` (0-100), `windowDays` (1-90).",
  }),
}).annotate({ identifier: "ScorecardCheck" });

const ScorecardLevel = Schema.Struct({
  key: Schema.String.annotate({
    description: "Lower-case letters, digits, dashes and underscores; unique.",
  }),
  name: Schema.String.annotate({ description: "At most 40 characters." }),
  minScore: Schema.Finite.annotate({ description: "0 to 100; unique within the scorecard." }),
  color: Schema.NullOr(Schema.String).annotate({ description: "Six-digit hex, e.g. `#d4a72c`." }),
}).annotate({ identifier: "ScorecardLevel" });

const scorecardFields = {
  name: Schema.String.annotate({
    description: "Unique in the organization; at most 120 characters.",
  }),
  description: Schema.NullOr(Schema.String).annotate({ description: "At most 1000 characters." }),
  checks: Schema.Array(ScorecardCheck).annotate({ description: "1 to 30 checks." }),
  levels: Schema.Array(ScorecardLevel).annotate({
    description: "1 to 6 levels; stored lowest first.",
  }),
  applicableTiers: Schema.Array(ServiceTier).annotate({
    description: "Tiers it applies to; empty means every service.",
  }),
  alertOnLevelDrop: Schema.Boolean.annotate({
    description: "Route a `scorecardAlerts` alert when a service drops a level.",
  }),
  enabled: Schema.Boolean,
};

export const Scorecard = Schema.Struct({
  id: Uuid,
  ...scorecardFields,
  isDefault: Schema.Boolean.annotate({
    description: "The scorecard seeded for the organization.",
  }),
  lastEvaluatedAt: Schema.NullOr(IsoDateTime),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
}).annotate({ identifier: "Scorecard" });

export const ScorecardList = Schema.Struct({ scorecards: Schema.Array(Scorecard) }).annotate({
  identifier: "ScorecardList",
});

const optionalInputs = {
  description: Schema.optionalKey(scorecardFields.description),
  checks: Schema.optionalKey(scorecardFields.checks),
  levels: Schema.optionalKey(scorecardFields.levels),
  applicableTiers: Schema.optionalKey(scorecardFields.applicableTiers),
  alertOnLevelDrop: Schema.optionalKey(scorecardFields.alertOnLevelDrop),
  enabled: Schema.optionalKey(scorecardFields.enabled),
};

const ScorecardCreate = Schema.Struct({ name: scorecardFields.name, ...optionalInputs }).annotate({
  identifier: "ScorecardCreate",
});

const ScorecardUpdate = Schema.Struct({
  name: Schema.optionalKey(scorecardFields.name),
  ...optionalInputs,
}).annotate({ identifier: "ScorecardUpdate" });

export const ScorecardOverview = Schema.Struct({
  scorecards: Schema.Array(Scorecard),
  services: Schema.Array(
    Schema.Struct({
      id: Uuid,
      name: Schema.String,
      slug: Schema.String,
      tier: Schema.NullOr(ServiceTier),
      ownerTeam: Schema.NullOr(Schema.String),
    }),
  ),
  results: Schema.Array(ScorecardResult),
}).annotate({ identifier: "ScorecardOverview" });

const OrgScorecardFact = Schema.Struct({
  label: Schema.String,
  value: Schema.String,
  bad: Schema.optionalKey(
    Schema.Boolean.annotate({ description: "True when this is the number that hurts." }),
  ),
}).annotate({ identifier: "OrgScorecardFact" });

const OrgScorecardPillar = Schema.Struct({
  id: OrgScorecardPillarId,
  score: Schema.NullOr(Percent).annotate({
    description:
      "Null when the pillar could not be assessed, **never zero**. An unassessed pillar is " +
      "excluded from the overall rather than counted as failure.",
  }),
  weight: Schema.Int.annotate({
    description:
      "Relative weight in the overall, fixed: posture 25, recoverability 20, services 15, " +
      "deadlines 15, access 10, headroom 10, ownership 5. Weights renormalize over the " +
      "assessed pillars, so gaining one cannot read as a regression.",
  }),
  headline: Schema.String.annotate({ description: "What the score measures over, in one line." }),
  unassessedReason: Schema.NullOr(Schema.String).annotate({
    description: "Why there is no score, phrased so a reader can act on it. Null when scored.",
  }),
  nextStep: Schema.NullOr(Schema.String).annotate({
    description: "The single most valuable thing to fix. Null when clean or unassessed.",
  }),
  facts: Schema.Array(OrgScorecardFact),
}).annotate({ identifier: "OrgScorecardPillar" });

const OrgScorecardTrendPoint = Schema.Struct({
  day: Schema.String.annotate({ examples: ["2026-10-12"], description: "UTC calendar day." }),
  score: Percent,
  grade: OrgScorecardGrade,
  pillars: Schema.Record(Schema.String, Schema.Int).annotate({
    description: "Per-pillar scores that day. A pillar unassessed then is absent, not zero.",
  }),
}).annotate({ identifier: "OrgScorecardTrendPoint" });

export const OrgScorecard = Schema.Struct({
  score: Schema.NullOr(Percent).annotate({
    description:
      "Weighted mean over the assessed pillars, or null when none could be assessed: an " +
      "organization with nothing connected has nothing to grade.",
  }),
  grade: Schema.NullOr(OrgScorecardGrade),
  pillars: Schema.Array(OrgScorecardPillar),
  failedPillars: Schema.Array(OrgScorecardPillarId).annotate({
    description:
      "Pillars whose computation failed, as opposed to having no data. Excluded from the " +
      "overall exactly as unassessed ones are, but named apart.",
  }),
  trend: Schema.Array(OrgScorecardTrendPoint).annotate({
    description: "Stored daily readings for the last 90 days, oldest first.",
  }),
  generatedAt: IsoDateTime,
}).annotate({ identifier: "OrgScorecard" });

export const OrgScorecardHistory = Schema.Struct({
  trend: Schema.Array(OrgScorecardTrendPoint),
}).annotate({ identifier: "OrgScorecardHistory" });

const ScorecardParams = { orgId: OrgId, scorecardId: Uuid } as const;

export class ScorecardsGroup extends HttpApiGroup.make("scorecards")
  .add(
    HttpApiEndpoint.get("list", "/", { params: OrgParams, success: ScorecardList })
      .annotate(RequiredPermission, "resources:read")
      .annotate(OpenApi.Summary, "List scorecards")
      .annotate(
        OpenApi.Description,
        "Seeds the default scorecard for organizations that have never had one (once; a deleted " +
          "default is not recreated).",
      )
      .annotate(SuccessDescription, "The scorecards"),
    HttpApiEndpoint.get("overview", "/overview", { params: OrgParams, success: ScorecardOverview })
      .annotate(RequiredPermission, "resources:read")
      .annotate(OpenApi.Summary, "Read the scorecard matrix")
      .annotate(
        OpenApi.Description,
        "Every service, every scorecard and the current result for each applicable pair.",
      )
      .annotate(SuccessDescription, "The matrix"),
    HttpApiEndpoint.get("org", "/org", { params: OrgParams, success: OrgScorecard })
      .annotate(RequiredPermission, "resources:read")
      .annotate(OpenApi.Summary, "Grade the organization")
      .annotate(
        OpenApi.Description,
        "The org grade shown above the scorecard matrix: one weighted reading over seven feeds " +
          "the product already computes (security posture, backup coverage, the service " +
          "scorecard results, declared deadlines, the cross-cloud access review, quota headroom " +
          "and resource ownership). Nothing is re-derived.\n\n" +
          "An unassessed pillar is excluded, never scored zero, and weights renormalize over what " +
          "was assessed. The trend comes from a daily snapshot the poller records; days when " +
          "nothing could be graded are absent rather than zero. Does not seed the default " +
          "scorecard.",
      )
      .annotate(SuccessDescription, "The org grade, its pillars and its history"),
    HttpApiEndpoint.get("orgHistory", "/org/history", {
      params: OrgParams,
      query: {
        // Read as sent and checked by the handler, which names the bounds.
        days: Schema.optionalKey(
          documentedAs(
            Schema.Int.check(
              Schema.isBetween({ minimum: 1, maximum: ORG_SCORECARD_RETENTION_DAYS }),
            ).annotate({
              description: `How far back to read. Defaults to 90; readings are kept for ${ORG_SCORECARD_RETENTION_DAYS} days.`,
            }),
          ),
        ),
      },
      success: OrgScorecardHistory,
      error: BadRequest,
    })
      .annotate(RequiredPermission, "resources:read")
      .annotate(OpenApi.Summary, "List stored org grade readings")
      .annotate(
        OpenApi.Description,
        "The daily history alone, without computing the grade: the cheap read for a sparkline.",
      )
      .annotate(SuccessDescription, "Stored readings, oldest first"),
    HttpApiEndpoint.get("get", "/:scorecardId", {
      params: ScorecardParams,
      success: Scorecard,
      error: NotFound,
    })
      .annotate(RequiredPermission, "resources:read")
      .annotate(OpenApi.Summary, "Read a scorecard")
      .annotate(SuccessDescription, "The scorecard"),
    HttpApiEndpoint.post("create", "/", {
      params: OrgParams,
      payload: ScorecardCreate,
      success: Scorecard.pipe(HttpApiSchema.status(201)),
      error: [BadRequest, NotFound, Conflict],
    })
      .annotate(RequiredPermission, "resources:write")
      .annotate(OpenApi.Summary, "Create a scorecard")
      .annotate(
        OpenApi.Description,
        "Omitted checks and levels default to every built-in check and bronze/silver/gold. " +
          "Out-of-range inputs are rejected. Audit-logged.",
      )
      .annotate(SuccessDescription, "The created scorecard")
      .annotate(OpenApi.Transform, optionalRequestBody),
    HttpApiEndpoint.patch("update", "/:scorecardId", {
      params: ScorecardParams,
      payload: ScorecardUpdate,
      success: Scorecard,
      error: [BadRequest, NotFound, Conflict],
    })
      .annotate(RequiredPermission, "resources:write")
      .annotate(OpenApi.Summary, "Update a scorecard")
      .annotate(
        OpenApi.Description,
        "Omitted fields keep their value; `checks` and `levels` replace the stored lists. " +
          "Services are re-scored within one poller tick. Audit-logged.",
      )
      .annotate(SuccessDescription, "The updated scorecard")
      .annotate(OpenApi.Transform, optionalRequestBody),
    HttpApiEndpoint.delete("delete", "/:scorecardId", {
      params: ScorecardParams,
      success: HttpApiSchema.NoContent,
      error: [BadRequest, NotFound, Conflict],
    })
      .annotate(RequiredPermission, "resources:write")
      .annotate(OpenApi.Summary, "Delete a scorecard")
      .annotate(OpenApi.Description, "Its results and history go with it. Audit-logged.")
      .annotate(SuccessDescription, "Deleted"),
    HttpApiEndpoint.post("evaluate", "/:scorecardId/evaluate", {
      params: ScorecardParams,
      success: ScorecardOverview,
      error: [BadRequest, NotFound, Conflict],
    })
      .annotate(RequiredPermission, "resources:write")
      .annotate(OpenApi.Summary, "Score every service on a scorecard now")
      .annotate(
        OpenApi.Description,
        "Level drops found here are stored but not announced: the caller just changed the bar.",
      )
      .annotate(SuccessDescription, "The matrix after scoring"),
  )
  .prefix("/api/org/:orgId/scorecards")
  .middleware(OrgAuth)
  .annotate(OpenApi.Title, "Scorecards") {}

export class ScorecardsApi extends withApiDefaults(
  HttpApi.make("scorecards").add(ScorecardsGroup),
) {}
