import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const ServiceAccountResourceType: ResourceTypeDefinition = {
  id: "gcp-service-account",
  displayName: "Service Account",
  pluralDisplayName: "Service Accounts",
  description: "A Google Cloud IAM service account",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    { key: "email", label: "Email", kind: "string", required: false },
    { key: "displayName", label: "Display Name", kind: "string", required: false },
    { key: "disabled", label: "Disabled", kind: "boolean", required: false },
    { key: "description", label: "Description", kind: "string", required: false },
  ],
  outputs: [
    {
      key: "key",
      label: "JSON Key File",
      sensitive: true,
      description:
        "Creates a new JSON credentials file on resolve. Contents match the standard Google application credentials format (gcloud, ADC, client libraries). Each resolve creates a fresh key — old keys keep working until rotated.",
    },
  ],
  dashboardPinnable: false,
  supportsCreate: true,
  credentialFormats: [
    {
      id: "json-key",
      label: "JSON Key File",
      description:
        "Standard Google application credentials. Used by gcloud, client libraries, etc.",
      mediaType: "json",
      filenameTemplate: "{resource}.json",
    },
    {
      id: "p12-key",
      label: "PKCS#12 Key",
      description:
        "PKCS#12 bundle. Password is 'notasecret'. Rarely needed outside legacy clients.",
      mediaType: "binary-base64",
      filenameTemplate: "{resource}.p12",
    },
  ],
};
