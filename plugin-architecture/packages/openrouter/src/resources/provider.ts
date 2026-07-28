import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * An upstream inference provider OpenRouter can route to.
 *
 * Docs: https://openrouter.ai/openapi.json  (GET /providers)
 */
export const ProviderResourceType = rt({
  name: "Provider",
  id: "provider",
  description: "An upstream inference provider OpenRouter routes to, with its data-residency info",
  fields: [
    f("slug", "Slug"),
    f("name", "Name", { required: false }),
    f("headquarters", "Headquarters", { required: false }),
    f("datacenters", "Datacenters", { required: false }),
    f("privacyPolicyUrl", "Privacy Policy", { required: false }),
    f("termsOfServiceUrl", "Terms of Service", { required: false }),
    f("statusPageUrl", "Status Page", { required: false }),
  ],
  outputs: [o("slug", "Provider Slug"), o("name", "Provider Name")],
  supportsDelete: false,
  iconKey: "server",
});
