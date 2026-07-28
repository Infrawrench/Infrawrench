import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * The developer account behind the access token — `GET /account`.
 *
 * The USD balances (`free_balance`, `purchased_balance`, `total_balance`) are
 * the live numbers. `balance_seconds` is deprecated and always returns 0, so
 * it is deliberately not modelled here.
 */
export const AccountResourceType = rt({
  name: "Account",
  plural: "Account",
  id: "account",
  description: "The Rev AI developer account, its USD balances, and the Speech playground",
  fields: [
    f("email", "Email", { required: false }),
    f("region", "Deployment", { required: false }),
    f("endpoint", "API Endpoint", { required: false }),
    f("freeBalance", "Free Balance (USD)", { kind: "number", required: false }),
    f("purchasedBalance", "Purchased Balance (USD)", { kind: "number", required: false }),
    f("totalBalance", "Total Balance (USD)", { kind: "number", required: false }),
    f("invoicedBalance", "Invoiced Balance (USD)", { kind: "number", required: false }),
    f("hipaaEnabled", "HIPAA Enabled", { kind: "boolean", required: false }),
  ],
  outputs: [o("endpoint", "API Endpoint"), o("email", "Account Email")],
  supportsDelete: false,
  iconKey: "account",
});
