import { f, o, rt } from "@infrawrench/plugin-base";

export const CloudFunctionResourceType = rt({
  name: "Cloud Function",
  id: "cloud-function",
  description: "A Google Cloud Function (2nd gen)",
  fields: [
    f("name", "Name"),
    f("region", "Region"),
    f("runtime", "Runtime", { required: false }),
    f("state", "State", { required: false }),
    f("stateMessage", "State Message", { required: false }),
    f("availableMemory", "Memory", { required: false }),
    f("timeout", "Timeout", { required: false }),
    f("ingress", "Ingress", { required: false }),
    f("image", "Image", { required: false }),
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
});
