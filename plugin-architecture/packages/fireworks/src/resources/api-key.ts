import { f, o, rt } from "@infrawrench/plugin-base";

export const ApiKeyResourceType = rt({
  name: "API Key",
  id: "api-key",
  description:
    "An API key belonging to a user in this Fireworks account. The plaintext value is returned once, at creation, and never again.",
  fields: [
    f("displayName", "Display Name"),
    f("keyId", "Key ID"),
    f("userId", "User", { required: false }),
    f("email", "Owner Email", { required: false }),
    f("prefix", "Prefix", { required: false }),
    f("secure", "Plaintext Unknown to Fireworks", { kind: "boolean", required: false }),
    f("lastUsed", "Last Used", { required: false }),
    f("createTime", "Created", { required: false }),
    f("expireTime", "Expires", { required: false }),
  ],
  outputs: [o("keyId", "Key ID"), o("prefix", "Key Prefix")],
  expiryFields: [
    { fieldKey: "expireTime", from: "expiry", kind: "api-token", label: "Key expires" },
  ],
  // `lastUsed` is declared above but the lister never writes it, so it is
  // deliberately NOT wired as `lastUsedKey`: a rule over a field nothing fills
  // would report every key as unknown anyway, and declaring it would claim we
  // look at something we don't.
  principalRole: { role: "key", createdKey: "createTime", parentKey: "email" },
  supportsCreate: true,
  iconKey: "key",
});
