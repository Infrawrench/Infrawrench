import { f, o, rt } from "@infrawrench/plugin-base";

export const DedicatedInferenceResourceType = rt({
  name: "Dedicated Inference",
  id: "dedicated-inference",
  description:
    "A DigitalOcean Dedicated Inference deployment — GPU-backed always-on model serving for steady request volume, strict latency SLOs, or bring-your-own-model. Per-GPU billing.",
  fields: [
    f("name", "Name"),
    f("region", "Region"),
    f("vpcUuid", "VPC", { required: false, editable: false }),
    f("enablePublicEndpoint", "Public Endpoint", {
      required: false,
      description: "Whether the deployment exposes a public inference endpoint",
    }),
    f("modelCount", "Models", { kind: "number", required: false, editable: false }),
    f("modelSummary", "Deployed Models", { required: false, editable: false }),
    f("publicEndpoint", "Public FQDN", { required: false, editable: false }),
    f("privateEndpoint", "Private FQDN", { required: false, editable: false }),
    f("status", "Status", { required: false, editable: false }),
  ],
  outputs: [
    o("publicEndpointUrl", "Public Endpoint URL", {
      description: "Public HTTPS endpoint for inference requests",
    }),
    o("privateEndpointUrl", "Private Endpoint URL", {
      description: "Private VPC HTTPS endpoint for inference requests",
    }),
  ],
  // The lister records `vpc_uuid`; a VPC's externalId is that same uuid.
  dependsOn: [{ fieldKey: "vpcUuid", targetTypeId: "vpc", label: "in VPC" }],
  supportsCreate: true,
  iconKey: "gpu",
});
