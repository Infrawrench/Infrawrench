import { f, o, rt } from "@infrawrench/plugin-base";

export const ServiceAccountResourceType = rt({
  name: "Service Account",
  pinnable: false,
  id: "gcp-service-account",
  description: "A Google Cloud IAM service account",
  fields: [
    f("name", "Name"),
    f("email", "Email", { required: false }),
    f("displayName", "Display Name", { required: false }),
    f("disabled", "Disabled", { kind: "boolean", required: false }),
    f("description", "Description", { required: false }),
  ],
  outputs: [
    o("key", "JSON Key File", {
      sensitive: true,
      description:
        "Creates a new JSON credentials file on resolve. Contents match the standard Google application credentials format (gcloud, ADC, client libraries). Each resolve creates a fresh key — old keys keep working until rotated.",
    }),
  ],
  // The IAM serviceAccounts.list response carries no creation date, no last
  // authentication and no role bindings, so this declares the role and nothing
  // else: the review lists the account, joins its recorded owner, and says
  // "unknown" about everything it cannot see. Key age would need
  // serviceAccounts.keys.list per account — an extra call this contract
  // forbids.
  principalRole: { role: "service-account" },
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
});
