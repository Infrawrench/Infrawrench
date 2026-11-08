/**
 * Schemas the services and scorecards domains share: a service's tier and a
 * scorecard's result on one service, which the service page, the service
 * summary and the scorecard matrix all carry. Defined once so the two
 * domains document the same components.
 */
import { Schema } from "effect";
import { SCORECARD_CHECK_TYPE_IDS } from "@infrawrench/client-core";
import { IsoDateTime, Uuid } from "./common";

export const ServiceTier = Schema.Literals([1, 2, 3, 4]).annotate({
  description: "Criticality, 1 being the most critical.",
});

export const ScorecardCheckType = Schema.Literals(SCORECARD_CHECK_TYPE_IDS).annotate({
  identifier: "ScorecardCheckType",
  description: "A check type from the scorecard registry.",
});

const CheckStatus = Schema.Literals(["pass", "fail", "not_applicable", "error"]).annotate({
  description:
    "`not_applicable` leaves the score's denominator; `error` (a feed that could not be read) " +
    "counts as failing.",
});

const ScorecardCheckResult = Schema.Struct({
  checkId: Schema.String,
  type: ScorecardCheckType,
  name: Schema.String,
  weight: Schema.Int,
  status: CheckStatus,
  detail: Schema.NullOr(Schema.String),
}).annotate({ identifier: "ScorecardCheckResult" });

export const ScorecardResult = Schema.Struct({
  scorecardId: Uuid,
  scorecardName: Schema.String,
  serviceId: Uuid,
  score: Schema.NullOr(Schema.Finite).annotate({
    description: "0-100; null when no check applied.",
  }),
  level: Schema.NullOr(Schema.String),
  levelName: Schema.NullOr(Schema.String),
  checks: Schema.Array(ScorecardCheckResult),
  evaluatedAt: IsoDateTime,
}).annotate({ identifier: "ScorecardResult" });
