import type {
  TerraformExportCapability,
  TerraformExportResult,
  TerraformValue,
} from "@infrawrench/plugin-base";
import { fieldString, tf } from "@infrawrench/plugin-base";

/**
 * Terraform mapping for New Relic: provider `newrelic/newrelic`.
 *
 * Verified against the provider's docs (newrelic/terraform-provider-newrelic,
 * `website/docs/index.html.markdown` and `website/docs/r/alert_policy.html.markdown`,
 * release v3.100.1, 2026-10): the provider takes `account_id`, `api_key` and
 * `region` (`US`, `EU` or `JP`); `newrelic_alert_policy` takes `name`,
 * `incident_preference` and `account_id`, and imports as `<id>:<account_id>`.
 *
 * Only alert policies are mapped. NRQL conditions need signal, expiration and
 * term blocks the stored inventory does not carry in full; dashboards and
 * monitors are documents or scripts that are not stored at all.
 */
export const newRelicTerraformExport: TerraformExportCapability = {
  provider: { name: "newrelic", source: "newrelic/newrelic", version: "~> 3.0" },
  providerConfig: {
    account_id: tf.ref("var.newrelic_account_id"),
    api_key: tf.ref("var.newrelic_api_key"),
    region: tf.ref("var.newrelic_region"),
  },
  variables: [
    { name: "newrelic_account_id", description: "Default New Relic account ID" },
    { name: "newrelic_api_key", description: "New Relic user key (NRAK-...)", sensitive: true },
    { name: "newrelic_region", description: "New Relic region: US, EU or JP" },
  ],
  supportedResourceTypeIds: ["alert-policy"],
  mapResource(resource): TerraformExportResult | null {
    if (resource.resourceTypeId !== "alert-policy") return null;
    const name = fieldString(resource, "name") || resource.displayName;
    const policyId = fieldString(resource, "policyId");
    const nrAccountId = fieldString(resource, "nrAccountId");
    if (!name || !policyId || !nrAccountId) return null;
    const attributes: Record<string, TerraformValue> = {
      name: tf.str(name),
      account_id: tf.num(Number(nrAccountId)),
    };
    const preference = fieldString(resource, "incidentPreference");
    if (preference) attributes["incident_preference"] = tf.str(preference);
    return {
      resource: {
        type: "newrelic_alert_policy",
        name,
        attributes,
        importId: `${policyId}:${nrAccountId}`,
      },
    };
  },
};
