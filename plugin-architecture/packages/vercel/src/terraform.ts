import type {
  TerraformExportCapability,
  TerraformExportResult,
  TerraformValue,
} from "@infrawrench/plugin-base";
import { fieldBool, fieldString, tf } from "@infrawrench/plugin-base";

/** Extract `prj_…` from `{accountId}:vercel-project:{projectId}`. */
function projectIdFromParent(parentResourceId: string | undefined): string {
  if (!parentResourceId) return "";
  const prefix = ":vercel-project:";
  const idx = parentResourceId.indexOf(prefix);
  if (idx < 0) return "";
  return parentResourceId.slice(idx + prefix.length);
}

/** Parse comma-/space-separated Vercel env `target` labels into TF target values. */
function parseEnvTargets(raw: string): string[] {
  const normalized = raw.toLowerCase();
  const targets: string[] = [];
  if (normalized.includes("production")) targets.push("production");
  if (normalized.includes("preview")) targets.push("preview");
  if (normalized.includes("development")) targets.push("development");
  return targets;
}

/**
 * Terraform mapping for Vercel — provider `vercel/vercel`.
 * Attribute names verified against the provider docs
 * (registry.terraform.io/providers/vercel/vercel):
 *   - vercel_project: `name` required; framework, root_directory, build_command,
 *     output_directory, serverless_function_region optional.
 *   - vercel_project_domain: `project_id` + `domain` required (project-scoped only).
 *   - vercel_project_environment_variable: `project_id`, `key`, `sensitive` required;
 *     `value`/`value_wo` for the secret payload; `target` is a set.
 * Account-level domains listed without a project link are not mappable — the
 * provider only exposes project domains. The API token is `var.vercel_api_token`.
 */
export const vercelTerraformExport: TerraformExportCapability = {
  provider: { name: "vercel", source: "vercel/vercel", version: "~> 4.0" },
  providerConfig: {
    api_token: tf.ref("var.vercel_api_token"),
    team: tf.ref("var.vercel_team_id"),
  },
  variables: [
    {
      name: "vercel_api_token",
      description: "Vercel access token (Account → Tokens)",
      sensitive: true,
    },
    {
      name: "vercel_team_id",
      description: "Optional Vercel team slug or ID when resources are team-scoped",
    },
  ],
  supportedResourceTypeIds: ["vercel-project", "vercel-domain", "vercel-env-var"],
  mapResource(resource): TerraformExportResult | null {
    switch (resource.resourceTypeId) {
      case "vercel-project": {
        const name = fieldString(resource, "name") || resource.displayName;
        if (!name) return null;
        const attributes: Record<string, TerraformValue> = { name: tf.str(name) };
        const framework = fieldString(resource, "framework");
        if (framework) attributes["framework"] = tf.str(framework);
        const rootDirectory = fieldString(resource, "rootDirectory");
        if (rootDirectory) attributes["root_directory"] = tf.str(rootDirectory);
        const buildCommand = fieldString(resource, "buildCommand");
        if (buildCommand) attributes["build_command"] = tf.str(buildCommand);
        const outputDirectory = fieldString(resource, "outputDirectory");
        if (outputDirectory) attributes["output_directory"] = tf.str(outputDirectory);
        const region = fieldString(resource, "serverlessFunctionRegion");
        if (region) attributes["serverless_function_region"] = tf.str(region);
        if (fieldBool(resource, "live")) attributes["auto_assign_custom_domains"] = tf.bool(true);
        return {
          resource: {
            type: "vercel_project",
            name,
            attributes,
            importId: resource.externalId,
          },
        };
      }
      case "vercel-domain": {
        // The lister stores account-level domains without a project association.
        const name = fieldString(resource, "name") || resource.displayName;
        if (!name) return null;
        const projectId = projectIdFromParent(resource.parentResourceId);
        if (!projectId) {
          return {
            resource: {
              type: "vercel_project_domain",
              name,
              attributes: {
                domain: tf.str(name),
                project_id: tf.ref("var.vercel_project_id"),
              },
              importId: name,
              comments: [
                "This domain is listed at the account level — attach it to a project",
                "with vercel_project_domain.project_id. Set var.vercel_project_id or replace",
                "the reference with vercel_project.<name>.id.",
              ],
            },
            variables: [
              {
                name: "vercel_project_id",
                description: "Vercel project ID (prj_…) that owns this domain",
              },
            ],
          };
        }
        return {
          resource: {
            type: "vercel_project_domain",
            name,
            attributes: {
              domain: tf.str(name),
              project_id: tf.str(projectId),
            },
            importId: `${projectId}/${name}`,
          },
        };
      }
      case "vercel-env-var": {
        const key = fieldString(resource, "key");
        const projectId = projectIdFromParent(resource.parentResourceId);
        if (!key || !projectId) return null;
        const attributes: Record<string, TerraformValue> = {
          project_id: tf.str(projectId),
          key: tf.str(key),
          // Never inline secret values — reference a variable instead.
          value: tf.ref("var.vercel_env_value"),
          sensitive: tf.bool(fieldString(resource, "type") === "secret"),
        };
        const targetRaw = fieldString(resource, "target");
        const targets = targetRaw
          ? parseEnvTargets(targetRaw)
          : ["production", "preview", "development"];
        if (targets.length > 0) {
          attributes["target"] = tf.list(targets.map((t) => tf.str(t)));
        }
        const gitBranch = fieldString(resource, "gitBranch");
        if (gitBranch) attributes["git_branch"] = tf.str(gitBranch);
        const importId = resource.externalId?.includes("/")
          ? `${projectId}/${resource.externalId}`
          : `${projectId}/${key}`;
        return {
          resource: {
            type: "vercel_project_environment_variable",
            name: `${key} env`,
            attributes,
            importId,
            comments: [
              "Set var.vercel_env_value to the desired value before apply — exported",
              "configs never embed secret env values from Infrawrench.",
            ],
          },
          variables: [
            {
              name: "vercel_env_value",
              description: `Value for Vercel env var ${key}`,
              sensitive: true,
            },
          ],
        };
      }
      default:
        return null;
    }
  },
};
