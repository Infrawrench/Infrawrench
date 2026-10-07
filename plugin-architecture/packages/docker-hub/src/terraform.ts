import type {
  TerraformExportCapability,
  TerraformExportResult,
  TerraformValue,
} from "@infrawrench/plugin-base";
import { fieldBool, fieldString, tf } from "@infrawrench/plugin-base";

/**
 * Terraform mapping for Docker's official `docker/docker` provider (0.7,
 * registry docs read 2026-10): `docker_hub_repository` (import id
 * `<namespace>/<name>`), `docker_org_team` and `docker_org_member` (import id
 * `<org>/<user>`). Team members are left to `docker_org_team_member`, which
 * needs one block per member; tokens are not exported (their secrets cannot
 * be recovered and a new token would be minted).
 */
export const dockerHubTerraformExport: TerraformExportCapability = {
  provider: { name: "docker", source: "docker/docker", version: "~> 0.7" },
  providerConfig: {
    username: tf.ref("var.dockerhub_username"),
    password: tf.ref("var.dockerhub_token"),
  },
  variables: [
    {
      name: "dockerhub_username",
      description: "Docker ID, or the organization name for an organization access token",
    },
    {
      name: "dockerhub_token",
      description: "Docker Hub personal or organization access token",
      sensitive: true,
    },
  ],
  supportedResourceTypeIds: ["dockerhub-repository", "dockerhub-team", "dockerhub-member"],
  mapResource(resource): TerraformExportResult | null {
    switch (resource.resourceTypeId) {
      case "dockerhub-repository": {
        const namespace = fieldString(resource, "namespace");
        const name = fieldString(resource, "name");
        if (!namespace || !name) return null;
        const attributes: Record<string, TerraformValue> = {
          namespace: tf.str(namespace),
          name: tf.str(name),
          private: tf.bool(fieldBool(resource, "isPrivate")),
        };
        const description = fieldString(resource, "description");
        if (description) attributes["description"] = tf.str(description);
        const full = fieldString(resource, "fullDescription");
        if (full) attributes["full_description"] = tf.str(full);
        if (fieldBool(resource, "immutableTags")) {
          const rules = fieldString(resource, "immutableTagsRules")
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
          attributes["immutable_tags_settings"] = tf.map({
            enabled: tf.bool(true),
            rules: tf.list(rules.map(tf.str)),
          });
        }
        return {
          resource: {
            type: "docker_hub_repository",
            name: `${namespace}_${name}`,
            attributes,
            importId: `${namespace}/${name}`,
          },
        };
      }
      case "dockerhub-team": {
        const org = fieldString(resource, "organization");
        const name = fieldString(resource, "name");
        if (!org || !name) return null;
        const attributes: Record<string, TerraformValue> = {
          org_name: tf.str(org),
          team_name: tf.str(name),
        };
        const description = fieldString(resource, "description");
        if (description) attributes["team_description"] = tf.str(description);
        return { resource: { type: "docker_org_team", name: `${org}_${name}`, attributes } };
      }
      case "dockerhub-member": {
        const org = fieldString(resource, "organization");
        const user = fieldString(resource, "username");
        const role = fieldString(resource, "role");
        if (!org || !user || !role) return null;
        return {
          resource: {
            type: "docker_org_member",
            name: `${org}_${user}`,
            attributes: { org_name: tf.str(org), user_name: tf.str(user), role: tf.str(role) },
            importId: `${org}/${user}`,
          },
        };
      }
      default:
        return null;
    }
  },
};
