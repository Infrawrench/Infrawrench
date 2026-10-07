import type {
  TerraformExportCapability,
  TerraformExportResult,
  TerraformValue,
} from "@infrawrench/plugin-base";
import { fieldString, tf } from "@infrawrench/plugin-base";

/**
 * Terraform mapping for PostHog: provider `PostHog/posthog` (v1.0.24,
 * 2026-10), attribute names from its `docs/resources/*.md`. Every resource
 * takes `project_id` and imports as `<project_id>/<id>`, which is exactly
 * this plugin's external id. The provider takes `api_key` and `host`.
 */
export const posthogTerraformExport: TerraformExportCapability = {
  provider: { name: "posthog", source: "PostHog/posthog", version: "~> 1.0" },
  providerConfig: { api_key: tf.ref("var.posthog_api_key"), host: tf.ref("var.posthog_host") },
  variables: [
    { name: "posthog_api_key", description: "PostHog personal API key", sensitive: true },
    { name: "posthog_host", description: "PostHog API host, e.g. https://us.posthog.com" },
  ],
  supportedResourceTypeIds: ["feature-flag", "dashboard", "cohort", "action"],
  mapResource(resource): TerraformExportResult | null {
    const projectId = fieldString(resource, "projectId");
    if (!projectId || !resource.externalId) return null;
    const attributes: Record<string, TerraformValue> = { project_id: tf.str(projectId) };
    const description = fieldString(resource, "description");
    const tagList = fieldString(resource, "tags").split(", ").filter(Boolean);
    let type = "";
    switch (resource.resourceTypeId) {
      case "feature-flag": {
        type = "posthog_feature_flag";
        attributes["key"] = tf.str(fieldString(resource, "key"));
        const name = fieldString(resource, "name");
        if (name) attributes["name"] = tf.str(name);
        attributes["active"] = tf.bool(resource.fields["active"] === true);
        const filters = fieldString(resource, "filtersJson");
        if (filters) attributes["filters"] = tf.str(filters);
        break;
      }
      case "dashboard":
        type = "posthog_dashboard";
        attributes["name"] = tf.str(fieldString(resource, "name") || resource.displayName);
        if (description) attributes["description"] = tf.str(description);
        attributes["pinned"] = tf.bool(resource.fields["pinned"] === true);
        break;
      case "cohort": {
        type = "posthog_cohort";
        attributes["name"] = tf.str(fieldString(resource, "name") || resource.displayName);
        if (description) attributes["description"] = tf.str(description);
        attributes["is_static"] = tf.bool(resource.fields["isStatic"] === true);
        const filters = fieldString(resource, "filtersJson");
        if (filters) attributes["filters"] = tf.str(filters);
        break;
      }
      case "action": {
        type = "posthog_action";
        attributes["name"] = tf.str(fieldString(resource, "name") || resource.displayName);
        if (description) attributes["description"] = tf.str(description);
        const steps = fieldString(resource, "stepsJson");
        if (steps) attributes["steps_json"] = tf.str(steps);
        break;
      }
      default:
        return null;
    }
    if (tagList.length && resource.resourceTypeId !== "cohort")
      attributes["tags"] = tf.list(tagList.map((t) => tf.str(t)));
    const comments =
      resource.resourceTypeId === "cohort" && resource.fields["isStatic"] === true
        ? ["Static cohort members are not exported; only the cohort itself is."]
        : [];
    return {
      resource: {
        type,
        name: fieldString(resource, "key") || resource.displayName,
        attributes,
        importId: resource.externalId,
        comments,
      },
    };
  },
};
