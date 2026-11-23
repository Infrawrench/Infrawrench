import { f, o, rt } from "@infrawrench/plugin-base";

export const CloudFunctionResourceType = rt({
  name: "Cloud Function",
  id: "cloud-function",
  iconKey: "function",
  description: "A Google Cloud Function (2nd gen)",
  equivalence: "serverless-function",
  fields: [
    f("name", "Name"),
    f("region", "Region", { showcase: true, sizing: "region" }),
    f("runtime", "Runtime", { showcase: true, required: false }),
    f("state", "State", { showcase: true, required: false }),
    f("stateMessage", "State Message", { required: false }),
    f("availableMemory", "Memory", { required: false }),
    f("timeout", "Timeout", { required: false }),
    f("ingress", "Ingress", { required: false }),
    f("image", "Image", { showcase: true, required: false }),
    f("lastModifier", "Last Modifier", { required: false }),
    f("latestRevision", "Latest Revision", { required: false }),
    f("serviceAccount", "Service Account", { required: false }),
    f("entryPoint", "Entry Point", { required: false }),
    f("sourceLocation", "Source Location", { required: false }),
    f("sourceBucket", "Source Bucket", {
      required: false,
      description: "Cloud Storage bucket holding the deployed source archive",
    }),
    f("environment", "Environment", { required: false }),
    f("buildId", "Build ID", { required: false }),
    f("minInstances", "Min Instances", { required: false }),
    f("maxInstances", "Max Instances", { required: false }),
    f("concurrency", "Concurrency", { required: false }),
  ],
  outputs: [
    o("url", "Trigger URL"),
    o("serviceUrl", "Cloud Run Service URL"),
    o("cloudRunServiceName", "Cloud Run Service Name"),
  ],
  // `sourceLocation` is a `gs://bucket/object` URI that matches nothing; the
  // lister keeps the bucket half separately, which is a gcs-bucket external id.
  dependsOn: [
    { fieldKey: "serviceAccount", targetTypeId: "gcp-service-account", label: "runs as" },
    { fieldKey: "sourceBucket", targetTypeId: "gcs-bucket", label: "source in" },
  ],
  supportsCreate: true,
  supportsMetrics: true,
  capacityMetrics: [
    // `serviceConfig.maxInstanceCount` caps the underlying Cloud Run service's
    // `container/instance_count`. The lister fills 100 when the API leaves it
    // out (the 2nd gen default, https://cloud.google.com/run/docs/configuring/max-instances,
    // read 2026-11-23); 0 means no maximum, which states no row.
    {
      seriesLabel: "Container Instances",
      limit: { field: "maxInstances" },
      unit: "instances",
      label: "Instances",
    },
    // `run.googleapis.com/container/memory/utilizations` ("Container memory
    // utilization distribution across all container instances", a fraction of
    // each container's memory limit), charted as its p95 0..100; an instance
    // that reaches its limit is stopped:
    // https://docs.cloud.google.com/monitoring/api/metrics_gcp_p_z, read 2026-11-23
    {
      seriesLabel: "Memory Utilization (p95)",
      limit: { constant: 100 },
      unit: "%",
      label: "Memory",
    },
  ],
});
