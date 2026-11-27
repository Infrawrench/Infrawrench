import { f, o, rt } from "@infrawrench/plugin-base";

export const CloudRunServiceResourceType = rt({
  name: "Cloud Run Service",
  id: "cloud-run-service",
  iconKey: "container",
  description: "A Google Cloud Run managed service",
  equivalence: "container-app",
  fields: [
    f("name", "Name"),
    f("region", "Region", { showcase: true, sizing: "region" }),
    f("latestRevision", "Latest Revision", { required: false }),
    f("state", "State", { showcase: true, required: false }),
    f("image", "Container Image", {
      showcase: true,
      required: false,
      editable: false,
      description: "Image of the service's main container, as deployed (tag or digest)",
    }),
    f("containerImages", "Container Images", {
      required: false,
      editable: false,
      description: "Every container image in the revision template, sidecars included",
    }),
    f("ingress", "Ingress", { required: false }),
    f("serviceAccount", "Service Account", {
      required: false,
      description: "Email of the service account the revision template runs as",
    }),
    f("maxInstances", "Max Instances", {
      kind: "number",
      required: false,
      editable: false,
      description:
        "Most instances the service scales out to (the lower of its service and revision limits)",
    }),
    f("network", "VPC Network", {
      kind: "association",
      required: false,
      description: "VPC network for private service access",
      allowLiteral: true,
      resolvableOutputKeys: ["selfLink"],
      resolvableFrom: [
        {
          pluginId: "gcp",
          resourceTypeId: "vpc-network",
          outputKey: "selfLink",
        },
      ],
    }),
  ],
  outputs: [o("url", "Service URL")],
  // The lister writes the revision template's service-account email into
  // `fields.serviceAccount`; service accounts are keyed by that same email.
  dependsOn: [
    { fieldKey: "serviceAccount", targetTypeId: "gcp-service-account", label: "runs as" },
  ],
  // Matched against Artifact Analysis (and other registries') findings. The
  // service list carries no resolved digest (that lives on the revision's
  // containerStatuses), so a tag-deployed service joins by repository + tag.
  runningImages: { imageKeys: ["containerImages", "image"] },
  supportsCreate: true,
  supportsMetrics: true,
  capacityMetrics: [
    // `container/instance_count` summed across states, against the scaling
    // maximum: past it, requests queue and then fail.
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
