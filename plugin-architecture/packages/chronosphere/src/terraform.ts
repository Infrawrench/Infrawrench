import type {
  TerraformExportCapability,
  TerraformExportResult,
  TerraformValue,
} from "@infrawrench/plugin-base";
import { fieldString, tf } from "@infrawrench/plugin-base";

/**
 * Terraform mapping for Chronosphere: provider `chronosphereio/chronosphere`
 * (v1.38.0, 2026-10). Attribute names from the provider's
 * `docs/resources/{team,bucket,collection}.md`; resources import by slug and
 * the provider takes `org` and `api_token`. `team_id` and
 * `notification_policy_id` take the referenced object's slug.
 *
 * Monitors, SLOs and shaping rules are not mapped: their conditions,
 * indicators and filters are nested documents the inventory stores as text.
 */
export const chronosphereTerraformExport: TerraformExportCapability = {
  provider: { name: "chronosphere", source: "chronosphereio/chronosphere", version: "~> 1.38" },
  providerConfig: {
    org: tf.ref("var.chronosphere_org"),
    api_token: tf.ref("var.chronosphere_api_token"),
  },
  variables: [
    {
      name: "chronosphere_org",
      description: "Chronosphere organization (the <org> in <org>.chronosphere.io)",
    },
    { name: "chronosphere_api_token", description: "Chronosphere API token", sensitive: true },
  ],
  supportedResourceTypeIds: ["team", "bucket", "collection"],
  mapResource(resource): TerraformExportResult | null {
    const name = fieldString(resource, "name") || resource.displayName;
    const slug = fieldString(resource, "slug") || resource.externalId || "";
    if (!name || !slug) return null;
    const attributes: Record<string, TerraformValue> = { name: tf.str(name), slug: tf.str(slug) };
    const description = fieldString(resource, "description");
    if (description) attributes["description"] = tf.str(description);
    const type = {
      team: "chronosphere_team",
      bucket: "chronosphere_bucket",
      collection: "chronosphere_collection",
    }[resource.resourceTypeId as "team" | "bucket" | "collection"];
    if (!type) return null;
    if (resource.resourceTypeId === "team") {
      const emails = fieldString(resource, "userEmails").split(", ").filter(Boolean);
      if (emails.length) attributes["user_emails"] = tf.list(emails.map((e) => tf.str(e)));
    } else {
      const team = fieldString(resource, "teamSlug");
      if (team) attributes["team_id"] = tf.str(team);
      const policy = fieldString(resource, "notificationPolicySlug");
      if (policy) attributes["notification_policy_id"] = tf.str(policy);
    }
    return { resource: { type, name: slug, attributes, importId: slug } };
  },
};
