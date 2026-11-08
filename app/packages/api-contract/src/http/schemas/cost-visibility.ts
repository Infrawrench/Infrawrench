/**
 * The caller's cost visibility scope as the API reports it (`/team/me`, the
 * cost visibility settings). Shared, so the components are defined once.
 */
import { Schema } from "effect";

export const CostVisibilityPrincipalKind = Schema.Literals(["role", "member", "api_key"]).annotate({
  identifier: "CostVisibilityPrincipalKind",
  description: "What a cost visibility scope attaches to.",
});

export const CostVisibilitySource = Schema.Struct({
  kind: CostVisibilityPrincipalKind,
  label: Schema.NullOr(Schema.String),
  costCentreIds: Schema.Array(Schema.String),
  accountIds: Schema.Array(Schema.String),
  savedFilterId: Schema.NullOr(Schema.String),
}).annotate({ identifier: "CostVisibilitySource" });

export const CostVisibilitySummary = Schema.Struct({
  restricted: Schema.Boolean.annotate({
    description: "False means the caller sees every cost row the organization holds.",
  }),
  sources: Schema.Array(CostVisibilitySource).annotate({
    description: "Every scope that applies to the caller. A cost row must match all of them.",
  }),
}).annotate({
  identifier: "CostVisibilitySummary",
  description: "The caller's cost visibility scope. Every cost read enforces it server-side.",
});
