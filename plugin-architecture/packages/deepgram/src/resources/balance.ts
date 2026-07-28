import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * A prepaid credit balance on a Deepgram project. Read-only.
 *
 * Docs: https://developers.deepgram.com/reference/management-api/balances/list
 */
export const BalanceResourceType = rt({
  name: "Balance",
  plural: "Balances",
  id: "balance",
  description:
    "A prepaid credit balance on a Deepgram project. Read-only — balances are topped up through Deepgram's billing console, not the API.",
  fields: [
    f("amount", "Amount", { kind: "number", editable: false }),
    f("units", "Units", { required: false, editable: false }),
    f("balanceId", "Balance ID", { required: false, editable: false }),
    f("purchaseOrderId", "Purchase", { required: false, editable: false }),
  ],
  outputs: [o("balanceId", "Balance ID"), o("amount", "Amount")],
  parentTypeId: "project",
  showInSidebar: true,
  supportsDelete: false,
  iconKey: "dashboard",
});
