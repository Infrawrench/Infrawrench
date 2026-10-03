import { f, rt } from "@infrawrench/plugin-base";
import { SCW_REGIONS } from "../locations.js";

export const SecretResourceType = rt({
  id: "secret",
  name: "Secret",
  pinnable: false,
  description: "A Scaleway Secret Manager secret (metadata only; values are never read)",
  fields: [
    f("name", "Name"),
    f("region", "Region", { kind: "enum", enumValues: SCW_REGIONS }),
    f("path", "Path", { required: false }),
    f("type", "Type", { required: false }),
    f("status", "Status", { required: false }),
    f("versionCount", "Versions", { kind: "number", required: false }),
    f("description", "Description", { required: false }),
    f("protected", "Protected", { kind: "boolean", required: false }),
    f("managed", "Managed by Scaleway", { kind: "boolean", required: false }),
    f("updatedAt", "Last Updated", { required: false }),
  ],
  outputs: [],
  expiryFields: [
    {
      fieldKey: "updatedAt",
      from: "created",
      kind: "secret-version",
      label: "Secret due for rotation",
    },
  ],
  iconKey: "secret",
});
