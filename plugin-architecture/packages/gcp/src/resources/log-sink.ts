import { f, rt } from "@infrawrench/plugin-base";

export const LogSinkResourceType = rt({
  name: "Log Sink",
  pinnable: false,
  id: "log-sink",
  description: "A Google Cloud Logging sink (log router)",
  fields: [
    f("name", "Name"),
    f("destination", "Destination", { required: false }),
    f("destinationBucket", "Destination Bucket", {
      required: false,
      description: "Cloud Storage bucket this sink writes to, when it routes to GCS",
    }),
    f("destinationDataset", "Destination Dataset", {
      required: false,
      description: "BigQuery dataset this sink writes to, as project:dataset",
    }),
    f("destinationTopic", "Destination Topic", {
      required: false,
      description: "Pub/Sub topic this sink publishes to, as its full resource name",
    }),
    f("filter", "Filter", { required: false }),
    f("disabled", "Disabled", { kind: "boolean", required: false }),
    f("writerIdentity", "Writer Identity", { required: false }),
  ],
  outputs: [],
  // `destination` itself is a service-qualified URI that matches nothing. The
  // lister splits out the tail per destination kind, in the form that kind is
  // keyed by: a bucket by bare name, a dataset by `project:dataset`, a topic by
  // its `projects/<p>/topics/<t>` resource name. Only one is ever set.
  dependsOn: [
    { fieldKey: "destinationBucket", targetTypeId: "gcs-bucket", label: "exports to" },
    { fieldKey: "destinationDataset", targetTypeId: "bigquery-dataset", label: "exports to" },
    { fieldKey: "destinationTopic", targetTypeId: "pubsub-topic", label: "exports to" },
  ],
  supportsCreate: true,
});
