/**
 * Billing profiles: `/api/org/:orgId/billing-profiles`, the endpoint
 * definitions.
 *
 * The reusable invoice settings customers are assigned to. Same permission
 * family as the customers themselves, for the same reason: a profile holds a
 * third party's legal entity and tax ID and the org's own bank details. Reads
 * are `invoices:read`; every write is `invoices:write`, because editing a
 * profile only ever reaches drafts (an approved invoice carries its own copy)
 * and so is revisable preparation, not issuing.
 *
 * The body is the shared schema the billing profile editor validates with
 * (`@infrawrench/ui/schemas`).
 */
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
import { BillingProfileInput, BillingProfileTaxRate } from "@infrawrench/ui/schemas";
import { InvalidRequestMessage, RequiredPermission, SuccessDescription } from "../../annotations";
import { withApiDefaults } from "../../domain";
import { BadRequest, Conflict, NotFound } from "../../errors";
import { OrgAuth } from "../../middleware-tags";
import { IsoDateTime, Ok, OrgIdParams, OrgParams, Uuid } from "../../schemas/common";
import { BillingProfileBank } from "../../schemas/invoicing";

export const BillingProfile = Schema.Struct({
  id: Uuid,
  name: Schema.String,
  legalName: Schema.NullOr(Schema.String),
  address: Schema.NullOr(Schema.String),
  taxId: Schema.NullOr(Schema.String),
  poNumber: Schema.NullOr(Schema.String),
  toEmails: Schema.Array(Schema.String),
  ccEmails: Schema.Array(Schema.String),
  currency: Schema.NullOr(Schema.String),
  paymentTermsDays: Schema.NullOr(Schema.Int),
  numberPrefix: Schema.String,
  numberIncludesYear: Schema.Boolean,
  numberStart: Schema.Int,
  taxRates: Schema.Array(BillingProfileTaxRate),
  bank: Schema.NullOr(BillingProfileBank),
  footer: Schema.NullOr(Schema.String),
  logo: Schema.NullOr(Schema.String),
  managedAccountIds: Schema.Array(Uuid).annotate({
    description: "Live customers assigned to this profile.",
  }),
  createdByUserId: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
}).annotate({
  identifier: "BillingProfile",
  description:
    "Reusable invoice settings: addressee, recipients, tax, payment terms, remittance details " +
    "and numbering, shared by every customer assigned to it. The profile wins where it sets a " +
    "field and the customer fills the gaps; recipients are the union of both.\n\n" +
    "Drafts follow a profile edit. **Approved invoices do not**: approval writes a resolved copy " +
    "onto the invoice (`Invoice.billing`), so a new bank account or tax rate reaches the next " +
    "invoice and no issued one.",
});

export class BillingProfilesGroup extends HttpApiGroup.make("billingProfiles")
  .add(
    HttpApiEndpoint.get("list", "/", {
      params: OrgParams,
      success: Schema.Array(BillingProfile),
    })
      .annotate(RequiredPermission, "invoices:read")
      .annotate(OpenApi.Summary, "List billing profiles")
      .annotate(SuccessDescription, "Profiles, name-sorted"),
    HttpApiEndpoint.post("create", "/", {
      params: OrgParams,
      payload: BillingProfileInput,
      success: BillingProfile,
      error: [BadRequest, Conflict],
    })
      .annotate(RequiredPermission, "invoices:write")
      .annotate(OpenApi.Summary, "Create a billing profile")
      .annotate(SuccessDescription, "Created")
      .annotate(InvalidRequestMessage, "Invalid billing profile"),
    HttpApiEndpoint.get("get", "/:id", {
      params: OrgIdParams,
      success: BillingProfile,
      error: NotFound,
    })
      .annotate(RequiredPermission, "invoices:read")
      .annotate(OpenApi.Summary, "Get a billing profile")
      .annotate(SuccessDescription, "The profile"),
    HttpApiEndpoint.put("update", "/:id", {
      params: OrgIdParams,
      payload: BillingProfileInput,
      success: BillingProfile,
      error: [BadRequest, NotFound, Conflict],
    })
      .annotate(RequiredPermission, "invoices:write")
      .annotate(OpenApi.Summary, "Update a billing profile")
      .annotate(
        OpenApi.Description,
        "A full replace, except `logo`, which is left as saved when absent. Draft invoices of the " +
          "assigned customers follow the change; approved invoices keep the copy frozen onto them.",
      )
      .annotate(SuccessDescription, "Updated")
      .annotate(InvalidRequestMessage, "Invalid billing profile"),
    HttpApiEndpoint.delete("delete", "/:id", {
      params: OrgIdParams,
      success: Ok,
      error: [NotFound, Conflict],
    })
      .annotate(RequiredPermission, "invoices:write")
      .annotate(OpenApi.Summary, "Delete a billing profile")
      .annotate(
        OpenApi.Description,
        "Refused with 409, naming them, while live customers are assigned: removing a profile " +
          "out from under a customer would change the address, tax and numbering of its next invoice.",
      )
      .annotate(SuccessDescription, "Deleted"),
  )
  .prefix("/api/org/:orgId/billing-profiles")
  .middleware(OrgAuth)
  .annotate(OpenApi.Title, "Billing Profiles") {}

export class BillingProfilesApi extends withApiDefaults(
  HttpApi.make("billingProfiles").add(BillingProfilesGroup),
) {}
