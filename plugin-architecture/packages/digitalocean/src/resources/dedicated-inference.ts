import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const DedicatedInferenceResourceType: ResourceTypeDefinition = {
  id: "dedicated-inference",
  displayName: "Dedicated Inference",
  pluralDisplayName: "Dedicated Inferences",
  description:
    "A DigitalOcean Dedicated Inference deployment — GPU-backed always-on model serving for steady request volume, strict latency SLOs, or bring-your-own-model. Per-GPU billing.",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    { key: "region", label: "Region", kind: "string", required: true },
    { key: "vpcUuid", label: "VPC", kind: "string", required: false, editable: false },
    {
      key: "enablePublicEndpoint",
      label: "Public Endpoint",
      kind: "string",
      required: false,
      description: "Whether the deployment exposes a public inference endpoint",
    },
    {
      key: "modelCount",
      label: "Models",
      kind: "number",
      required: false,
      editable: false,
    },
    {
      key: "modelSummary",
      label: "Deployed Models",
      kind: "string",
      required: false,
      editable: false,
    },
    {
      key: "publicEndpoint",
      label: "Public FQDN",
      kind: "string",
      required: false,
      editable: false,
    },
    {
      key: "privateEndpoint",
      label: "Private FQDN",
      kind: "string",
      required: false,
      editable: false,
    },
    { key: "status", label: "Status", kind: "string", required: false, editable: false },
  ],
  outputs: [
    {
      key: "publicEndpointUrl",
      label: "Public Endpoint URL",
      sensitive: false,
      description: "Public HTTPS endpoint for inference requests",
    },
    {
      key: "privateEndpointUrl",
      label: "Private Endpoint URL",
      sensitive: false,
      description: "Private VPC HTTPS endpoint for inference requests",
    },
  ],
  dashboardPinnable: true,
  supportsCreate: true,
  iconKey: "gpu",
};
