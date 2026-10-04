import type {
  TerraformExportCapability,
  TerraformExportResult,
  TerraformValue,
} from "@infrawrench/plugin-base";
import { fieldString, tf } from "@infrawrench/plugin-base";

/**
 * Terraform mapping for Sentry: provider `jianyuan/sentry`.
 *
 * Verified against the provider's docs (jianyuan/terraform-provider-sentry,
 * `docs/index.md`, `docs/resources/{project,team,key}.md`, release v0.15.8,
 * 2026-10): the provider takes `token` and `base_url`
 * (`https://<host>/api/`, defaulting to sentry.io); `sentry_team` takes
 * `organization` and `name` (+ `slug`) and imports as `org/team`;
 * `sentry_project` takes `organization`, `teams`, `name`, `platform`
 * (+ `slug`) and imports as `org/project`; `sentry_key` takes
 * `organization`, `project`, `name` and the rate limit, and imports as
 * `org/project/key-id`.
 *
 * Alerts,
 * monitors and cron/uptime monitors are not mapped: the stored inventory
 * carries summaries of their conditions, not the full documents.
 */
export const sentryTerraformExport: TerraformExportCapability = {
  provider: { name: "sentry", source: "jianyuan/sentry", version: "~> 0.15" },
  providerConfig: {
    token: tf.ref("var.sentry_token"),
    base_url: tf.ref("var.sentry_base_url"),
  },
  variables: [
    { name: "sentry_token", description: "Sentry auth token", sensitive: true },
    {
      name: "sentry_base_url",
      description:
        "Sentry API base URL, e.g. https://sentry.io/api/ or https://sentry.example.com/api/",
    },
  ],
  supportedResourceTypeIds: ["team", "project", "client-key"],
  mapResource(resource): TerraformExportResult | null {
    const orgSlug = fieldString(resource, "organization");
    if (!orgSlug) return null;
    const org = tf.str(orgSlug);
    switch (resource.resourceTypeId) {
      case "team": {
        const slug = fieldString(resource, "slug") || resource.externalId || "";
        if (!slug) return null;
        return {
          resource: {
            type: "sentry_team",
            name: slug,
            attributes: {
              organization: org,
              name: tf.str(fieldString(resource, "name") || slug),
              slug: tf.str(slug),
            },
            importId: `${orgSlug}/${slug}`,
          },
        };
      }
      case "project": {
        const slug = fieldString(resource, "slug") || resource.externalId || "";
        const teams = fieldString(resource, "teams")
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean);
        const platform = fieldString(resource, "platform");
        if (!slug || teams.length === 0) return null;
        const attributes: Record<string, TerraformValue> = {
          organization: org,
          name: tf.str(fieldString(resource, "name") || slug),
          slug: tf.str(slug),
          teams: tf.list(teams.map((t) => tf.str(t))),
          platform: tf.str(platform || "other"),
        };
        return {
          resource: {
            type: "sentry_project",
            name: slug,
            attributes,
            importId: `${orgSlug}/${slug}`,
          },
        };
      }
      case "client-key": {
        const project = fieldString(resource, "projectSlug");
        const keyId = fieldString(resource, "keyId");
        if (!project || !keyId) return null;
        const attributes: Record<string, TerraformValue> = {
          organization: org,
          project: tf.str(project),
          name: tf.str(fieldString(resource, "name") || resource.displayName),
        };
        const count = Number(resource.fields["rateLimitCount"]);
        const window = Number(resource.fields["rateLimitWindow"]);
        if (Number.isFinite(count) && Number.isFinite(window) && count > 0 && window > 0) {
          attributes["rate_limit_count"] = tf.num(count);
          attributes["rate_limit_window"] = tf.num(window);
        }
        return {
          resource: {
            type: "sentry_key",
            name: `${project}_${keyId}`,
            attributes,
            importId: `${orgSlug}/${project}/${keyId}`,
          },
        };
      }
      default:
        return null;
    }
  },
};
