import { z } from "../zod";
import { strict, OrgIdParam, Uuid, IsoDateTime } from "../common";
import type { BuildContext } from "../context";

export function registerCreditPaths(ctx: BuildContext) {
  const { registry, enums } = ctx;

  const CreditPot = strict({
    accountId: Uuid,
    accountName: z.string(),
    pluginId: enums.PluginId,
    capabilityLabel: z
      .string()
      .describe('The provider\'s own word for this pot — "Credits", "Balance".'),
    topUpUrl: z.string().nullable(),
    potKey: z
      .string()
      .describe(
        "Stable identity for this pot within the account — a currency code, a project id — so " +
          "successive readings line up into a series.",
      ),
    label: z.string(),
    remaining: z.number(),
    currency: z.string(),
    granted: z.number().nullable().describe("What was granted, when the provider reports it."),
    creditExpiresAt: IsoDateTime.nullable().describe(
      "Hard expiry on the credit itself, independent of burn.",
    ),
    observedAt: IsoDateTime,
    burnPerDay: z
      .number()
      .nullable()
      .describe(
        "Spend per day over the observed span. **Null means there is not enough history to " +
          "say** — never 0, which would read as 'nothing is being spent'.",
      ),
    burnSpanDays: z.number(),
    observations: z.number().int(),
    topUps: z
      .number()
      .int()
      .describe(
        "Increases seen between consecutive readings. A top-up is recorded, never netted off " +
          "the burn — subtracting the endpoints of a window containing one reports a negative " +
          "burn and an infinite runway.",
      ),
    runwayDays: z.number().nullable(),
    exhaustedAt: IsoDateTime.nullable(),
    neverEmpties: z.boolean().describe("Nothing has been spent over the observed span."),
    limitedByExpiry: z
      .boolean()
      .describe("The credit's own expiry, not the burn rate, is the binding deadline."),
    urgency: z.enum(["critical", "warning", "ok", "unknown"]),
  }).openapi("CreditPot");

  const CreditPollFailure = strict({
    accountId: Uuid,
    accountName: z.string(),
    pluginId: enums.PluginId,
    error: z.string(),
    helpLabel: z.string().nullable(),
    helpUrl: z
      .string()
      .nullable()
      .describe("Set when the plugin reported a permission gap rather than an outage."),
    failureCount: z.number().int(),
  }).openapi("CreditPollFailure");

  const CreditBurndown = strict({
    pots: z.array(CreditPot),
    failures: z.array(CreditPollFailure),
    pendingAccountIds: z
      .array(Uuid)
      .describe("Credit-capable accounts never yet collected — named rather than omitted."),
    burnWindowDays: z.number().int(),
  }).openapi("CreditBurndown");

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/credits",
    tags: ["Credit burndown"],
    summary: "Prepaid credit balances, burn rate and runway",
    description:
      "Every prepaid pot the organization holds, most urgent first. A provider that bills in " +
      "arrears sends an invoice you can argue with; a prepaid pot that empties simply stops " +
      "answering — so this is an availability number as much as a finance one.\n\n" +
      "The burn rate is measured from the server's own series of readings rather than reported " +
      "by the provider, and it is the sum of the **decreases** between consecutive readings: a " +
      "top-up inside the window is recorded separately, never netted off. The runway is bounded " +
      "by both the burn and the credit's own expiry, whichever comes first.\n\n" +
      "Only providers that expose a balance appear here; most bill in arrears and have no pot.",
    request: { params: OrgIdParam },
    responses: {
      200: {
        description: "The organization's prepaid balances",
        content: { "application/json": { schema: CreditBurndown } },
      },
    },
  });
}
