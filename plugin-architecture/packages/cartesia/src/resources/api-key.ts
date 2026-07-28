import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * A Cartesia API key. Listing keys needs the *admin* key (`sk_car_admin_…`),
 * not the ordinary `sk_car_…` synthesis key — without one this type simply
 * lists empty rather than failing the account.
 * Source: GET https://api.cartesia.ai/api-keys
 * https://docs.cartesia.ai/api-reference/api-keys/list
 */
export const ApiKeyResourceType = rt({
  name: "API Key",
  id: "api-key",
  description:
    "An API key issued for this Cartesia organization. Requires an admin API key on the account; the key material itself is never returned by the API",
  fields: [
    f("keyId", "Key ID"),
    f("description", "Description", { required: false }),
    f("creatorEmail", "Created By", { required: false }),
    f("creatorStillInOrg", "Creator Still in Org", { kind: "boolean", required: false }),
    f("createdAt", "Created", { required: false }),
  ],
  outputs: [o("keyId", "Key ID")],
  iconKey: "key",
});
