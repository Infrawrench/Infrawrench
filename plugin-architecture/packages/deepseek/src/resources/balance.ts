import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * The account's prepaid credit balance, one row per currency. Read-only —
 * DeepSeek tops up through its own console and exposes no billing mutation,
 * no invoice list, and no usage time series.
 *
 * ⚠️ Every amount in `balance_infos[]` is a **string**, not a number
 * (`"110.00"`), so the client parses them before doing any arithmetic.
 *
 * Docs: https://api-docs.deepseek.com/api/get-user-balance
 */
export const BalanceResourceType = rt({
  name: "Balance",
  plural: "Balances",
  id: "balance",
  description:
    "Prepaid credit balance for this DeepSeek account, split into granted and topped-up amounts. Read-only — DeepSeek has no billing or usage API, only this endpoint.",
  fields: [
    f("currency", "Currency", { kind: "enum", editable: false, enumValues: ["CNY", "USD"] }),
    f("totalBalance", "Total Balance", { kind: "number", editable: false }),
    f("grantedBalance", "Granted Balance", { kind: "number", required: false, editable: false }),
    f("toppedUpBalance", "Topped-up Balance", { kind: "number", required: false, editable: false }),
    f("isAvailable", "Sufficient for API Calls", {
      kind: "boolean",
      required: false,
      editable: false,
    }),
  ],
  outputs: [
    o("currency", "Currency"),
    o("totalBalance", "Total Balance"),
    o("isAvailable", "Balance Available"),
  ],
  supportsCreate: false,
  supportsDelete: false,
  iconKey: "dashboard",
});
