import { f, o, rt } from "@infrawrench/plugin-base";

export const CloudRunServiceResourceType = rt({
  name: "Cloud Run Service",
  id: "cloud-run-service",
  description: "A Google Cloud Run managed service",
  fields: [
    f("name", "Name"),
    f("region", "Region"),
    f("latestRevision", "Latest Revision", { required: false }),
    f("state", "State", { required: false }),
    f("ingress", "Ingress", { required: false }),
    f("serviceAccount", "Service Account", {
      required: false,
      description: "Email of the service account the revision template runs as",
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
  supportsCreate: true,
  supportsMetrics: true,
});
