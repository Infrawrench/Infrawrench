import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * A Metronome customer: the party usage is metered for and invoices are
 * issued to. Read-only here; customers are provisioned by the product that
 * sends Metronome its usage events.
 *
 * Docs: https://docs.metronome.com/api-reference/customers/list-customers
 */
export const CustomerResourceType = rt({
  name: "Customer",
  plural: "Customers",
  id: "customer",
  description:
    "A customer in Metronome, with its ingest aliases, custom fields and recent invoices. Usage and revenue per customer can be imported as a business metric.",
  fields: [
    f("customerId", "Customer ID", { editable: false }),
    f("name", "Name", { editable: false }),
    f("ingestAliases", "Ingest Aliases", { required: false, editable: false }),
    f("salesforceAccountId", "Salesforce Account ID", { required: false, editable: false }),
    f("billableStatus", "Billable Status", { required: false, editable: false }),
    f("customFields", "Custom Fields", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
    f("updatedAt", "Updated", { required: false, editable: false }),
  ],
  outputs: [
    o("customerId", "Customer ID", {
      description:
        "The Metronome customer id, accepted in place of an ingest alias in usage events.",
    }),
    o("ingestAlias", "Primary Ingest Alias", {
      description: "The first alias usage events can carry for this customer.",
    }),
  ],
  supportsCreate: false,
  supportsDelete: false,
  iconKey: "user",
});
