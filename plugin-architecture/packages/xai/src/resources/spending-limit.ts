import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * The team's postpaid monthly spending limit, together with the current
 * billing period's invoice preview. One row per team.
 *
 * Only the soft limit is user-settable (`POST .../postpaid/spending-limits`);
 * xAI derives the hard limit itself. Prepaid credit is always consumed first
 * and the soft limit caps postpaid usage on top of it, so setting it to 0
 * restricts the team to prepaid credit only.
 *
 * Docs: https://docs.x.ai/developers/rest-api-reference/management/billing
 * (GET/POST /v1/billing/teams/{team_id}/postpaid/spending-limits,
 *  GET /v1/billing/teams/{team_id}/postpaid/invoice/preview)
 *
 * The Metrics tab charts the team's spend, total and costliest line items,
 * from POST /v1/billing/teams/{team_id}/usage.
 */
export const SpendingLimitResourceType = rt({
  name: "Spending Limit",
  id: "spending-limit",
  description:
    "The team's postpaid monthly spending limit and this billing period's running invoice (requires a management key). The soft limit is editable.",
  fields: [
    f("softLimit", "Monthly Spending Limit (USD)", {
      kind: "number",
      description:
        "Postpaid usage stops once prepaid credit is exhausted and this much has been spent this month. Set 0 to use prepaid credit only.",
    }),
    f("effectiveLimit", "Effective Limit (USD)", {
      kind: "number",
      required: false,
      editable: false,
    }),
    f("hardLimit", "Hard Limit (USD)", { kind: "number", required: false, editable: false }),
    f("hardLimitOverride", "Hard Limit Override (USD)", {
      kind: "number",
      required: false,
      editable: false,
    }),
    f("billingCycle", "Billing Cycle", { required: false, editable: false }),
    f("currentSpend", "Current Period Total (USD)", {
      kind: "number",
      required: false,
      editable: false,
    }),
    f("prepaidCredits", "Prepaid Credits (USD)", {
      kind: "number",
      required: false,
      editable: false,
    }),
    f("prepaidCreditsUsed", "Prepaid Credits Used (USD)", {
      kind: "number",
      required: false,
      editable: false,
    }),
  ],
  outputs: [o("softLimit", "Monthly Spending Limit (USD)"), o("currentSpend", "Current Spend")],
  supportsMetrics: true,
  supportsUpdate: true,
  supportsDelete: false,
  iconKey: "dashboard",
});
