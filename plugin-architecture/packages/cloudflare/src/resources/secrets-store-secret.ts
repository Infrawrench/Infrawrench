import { f, o, rt } from "@infrawrench/plugin-base";

export const SecretsStoreSecretResourceType = rt({
  name: "Secrets Store Secret",
  id: "secrets-store-secret",
  description: "An account-level secret in Cloudflare Secrets Store, shared across services",
  fields: [
    f("name", "Name", { editable: false }),
    f("storeName", "Store", { required: false, editable: false }),
    f("status", "Status", { required: false, editable: false }),
    f("value", "Value", {
      kind: "password",
      required: false,
      description:
        "Secret value. Cloudflare never returns it; leave blank to keep the current one.",
    }),
    f("comment", "Comment", { required: false }),
    f("scopeWorkers", "Usable by Workers", { kind: "boolean", required: false }),
    f("scopeAiGateway", "Usable by AI Gateway", { kind: "boolean", required: false }),
    f("scopeAccess", "Usable by Access", { kind: "boolean", required: false }),
    f("scopeContainers", "Usable by Containers", { kind: "boolean", required: false }),
    f("scopeDex", "Usable by Digital Experience Monitoring", {
      kind: "boolean",
      required: false,
    }),
    f("scopeWebsearch", "Usable by Web Search", { kind: "boolean", required: false }),
    f("created", "Created", { required: false, editable: false }),
    f("modified", "Modified", { required: false, editable: false }),
  ],
  outputs: [o("secretName", "Secret Name"), o("storeId", "Store ID")],
  supportsCreate: true,
  supportsUpdate: true,
  pinnable: false,
  iconKey: "secret",
  secretExportTemplates: [
    {
      id: "secrets-store-binding",
      displayName: "Secrets Store Binding",
      description: "Store id and secret name for a wrangler `[[secrets_store_secrets]]` binding",
      entries: [
        { envKey: "SECRETS_STORE_ID", outputKey: "storeId" },
        { envKey: "SECRET_NAME", outputKey: "secretName" },
      ],
    },
  ],
});
