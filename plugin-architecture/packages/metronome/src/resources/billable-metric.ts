import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * A billable metric: how Metronome turns raw usage events into a number
 * (event filters, property filters, an aggregation). Read-only here; the
 * definition is edited in Metronome, where changing it reprices invoices.
 *
 * Docs: https://docs.metronome.com/api-reference/billable-metrics/list-all-billable-metrics
 */
export const BillableMetricResourceType = rt({
  name: "Billable Metric",
  plural: "Billable Metrics",
  id: "billable-metric",
  description:
    "A Metronome billable metric: the event filters, property filters and aggregation that turn usage events into a billed quantity. Its daily usage can be imported as a business metric.",
  fields: [
    f("metricId", "Metric ID", { editable: false }),
    f("name", "Name", { editable: false }),
    f("aggregationType", "Aggregation", { required: false, editable: false }),
    f("aggregationKey", "Aggregation Key", { required: false, editable: false }),
    f("eventTypes", "Event Types", { required: false, editable: false }),
    f("excludedEventTypes", "Excluded Event Types", { required: false, editable: false }),
    f("groupKeys", "Group Keys", { required: false, editable: false }),
    f("sql", "SQL", { required: false, editable: false }),
  ],
  outputs: [
    o("metricId", "Metric ID", {
      description: "The billable metric id Metronome's usage API filters by.",
    }),
  ],
  supportsCreate: false,
  supportsDelete: false,
  iconKey: "dashboard",
});
