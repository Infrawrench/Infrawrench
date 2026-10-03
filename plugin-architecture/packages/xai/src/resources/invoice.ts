import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * A monthly or prepaid top-up invoice for the team. Read-only and needs the
 * optional management key; without it this list is empty.
 *
 * Every amount on the wire is a string of USD cents; the client converts to
 * dollars before storing.
 *
 * Docs: https://docs.x.ai/developers/rest-api-reference/management/billing
 * (GET /v1/billing/teams/{team_id}/invoices)
 */
export const InvoiceResourceType = rt({
  name: "Invoice",
  id: "invoice",
  description:
    "A team invoice with its line items and payment status (requires a management key). Read-only.",
  fields: [
    f("invoiceId", "Invoice ID", { editable: false }),
    f("invoiceNumber", "Invoice Number", { required: false, editable: false }),
    f("status", "Status", {
      kind: "enum",
      required: false,
      editable: false,
      enumValues: ["INVALID", "PENDING", "PAID", "WILL_NEVER_BE_CHARGED", "FAILED"],
    }),
    f("billingCycle", "Billing Cycle", { required: false, editable: false }),
    f("createTime", "Created", { required: false, editable: false }),
    f("chargeTime", "Charge Due", { required: false, editable: false }),
    f("subtotal", "Subtotal (USD)", { kind: "number", required: false, editable: false }),
    f("tax", "Tax (USD)", { kind: "number", required: false, editable: false }),
    f("total", "Total (USD)", { kind: "number", required: false, editable: false }),
    f("lineCount", "Line Items", { kind: "number", required: false, editable: false }),
    f("chargeAttempts", "Charge Attempts", { kind: "number", required: false, editable: false }),
  ],
  outputs: [o("invoiceNumber", "Invoice Number"), o("total", "Total (USD)")],
  pinnable: false,
  supportsDelete: false,
  iconKey: "receipt",
});
