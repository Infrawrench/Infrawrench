/**
 * Cloud-credit burndown: `/api/org/:orgId/credits`, the endpoint definitions.
 *
 * Prepaid balances with a measured burn rate and a runway. `costs:read`: a
 * credit balance is spend information, and the permission that governs "what
 * is this costing us" governs "how much is left".
 */
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
import { RequiredPermission, SuccessDescription } from "../../annotations";
import { withApiDefaults } from "../../domain";
import { OrgAuth } from "../../middleware-tags";
import { IsoDateTime, OrgParams, Uuid } from "../../schemas/common";
import { PluginId } from "../../schemas/plugin-registry";

const CreditPot = Schema.Struct({
  accountId: Uuid,
  accountName: Schema.String,
  pluginId: PluginId,
  capabilityLabel: Schema.String.annotate({
    description: 'The provider\'s own word for this pot, "Credits", "Balance".',
  }),
  topUpUrl: Schema.NullOr(Schema.String),
  potKey: Schema.String.annotate({
    description:
      "Stable identity for this pot within the account (a currency code, a project id) so " +
      "successive readings line up into a series.",
  }),
  label: Schema.String,
  remaining: Schema.Finite,
  currency: Schema.String,
  granted: Schema.NullOr(Schema.Finite).annotate({
    description: "What was granted, when the provider reports it.",
  }),
  creditExpiresAt: Schema.NullOr(IsoDateTime).annotate({
    description: "Hard expiry on the credit itself, independent of burn.",
  }),
  observedAt: IsoDateTime,
  burnPerDay: Schema.NullOr(Schema.Finite).annotate({
    description:
      "Spend per day over the observed span. **Null means there is not enough history to " +
      "say**: never 0, which would read as 'nothing is being spent'.",
  }),
  burnSpanDays: Schema.Finite,
  observations: Schema.Int,
  topUps: Schema.Int.annotate({
    description:
      "Increases seen between consecutive readings. A top-up is recorded, never netted off " +
      "the burn: subtracting the endpoints of a window containing one reports a negative " +
      "burn and an infinite runway.",
  }),
  runwayDays: Schema.NullOr(Schema.Finite),
  exhaustedAt: Schema.NullOr(IsoDateTime),
  neverEmpties: Schema.Boolean.annotate({
    description: "Nothing has been spent over the observed span.",
  }),
  limitedByExpiry: Schema.Boolean.annotate({
    description: "The credit's own expiry, not the burn rate, is the binding deadline.",
  }),
  urgency: Schema.Literals(["critical", "warning", "ok", "unknown"]),
}).annotate({ identifier: "CreditPot" });

const CreditPollFailure = Schema.Struct({
  accountId: Uuid,
  accountName: Schema.String,
  pluginId: PluginId,
  error: Schema.String,
  helpLabel: Schema.NullOr(Schema.String),
  helpUrl: Schema.NullOr(Schema.String).annotate({
    description: "Set when the plugin reported a permission gap rather than an outage.",
  }),
  failureCount: Schema.Int,
}).annotate({ identifier: "CreditPollFailure" });

export const CreditBurndown = Schema.Struct({
  pots: Schema.Array(CreditPot),
  failures: Schema.Array(CreditPollFailure),
  pendingAccountIds: Schema.Array(Uuid).annotate({
    description: "Credit-capable accounts never yet collected, named rather than omitted.",
  }),
  burnWindowDays: Schema.Int,
}).annotate({ identifier: "CreditBurndown" });

export class CreditsGroup extends HttpApiGroup.make("credits")
  .add(
    HttpApiEndpoint.get("burndown", "/", {
      params: OrgParams,
      success: CreditBurndown,
    })
      .annotate(RequiredPermission, "costs:read")
      .annotate(OpenApi.Summary, "Prepaid credit balances, burn rate and runway")
      .annotate(
        OpenApi.Description,
        "Every prepaid pot the organization holds, most urgent first. A provider that bills in " +
          "arrears sends an invoice you can argue with; a prepaid pot that empties simply stops " +
          "answering: so this is an availability number as much as a finance one.\n\n" +
          "The burn rate is measured from the server's own series of readings rather than reported " +
          "by the provider, and it is the sum of the **decreases** between consecutive readings: a " +
          "top-up inside the window is recorded separately, never netted off. The runway is bounded " +
          "by both the burn and the credit's own expiry, whichever comes first.\n\n" +
          "Only providers that expose a balance appear here; most bill in arrears and have no pot.",
      )
      .annotate(SuccessDescription, "The organization's prepaid balances"),
  )
  .prefix("/api/org/:orgId/credits")
  .middleware(OrgAuth)
  .annotate(OpenApi.Title, "Credit burndown") {}

export class CreditsApi extends withApiDefaults(HttpApi.make("credits").add(CreditsGroup)) {}
