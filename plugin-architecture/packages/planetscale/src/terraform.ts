import type {
  TerraformExportCapability,
  TerraformExportResult,
  TerraformValue,
} from "@infrawrench/plugin-base";
import { fieldBool, fieldString, tf } from "@infrawrench/plugin-base";

/**
 * Terraform mapping for PlanetScale — provider `planetscale/planetscale` v1.
 * Attribute names verified against PlanetScale docs + registry
 * (registry.terraform.io/providers/planetscale/planetscale,
 *  planetscale.com/docs/terraform):
 *   - planetscale_vitess_branch: `organization`, `database`, `name` required.
 *   - planetscale_vitess_branch_password: `organization`, `database`, `branch`,
 *     `role` required; `name` optional.
 * There is no managed `planetscale_*_database` resource in v1 — databases are
 * created outside Terraform or via the API; ps-database is intentionally skipped.
 * Service token credentials map to provider service_token_id / secret.
 */
export const planetscaleTerraformExport: TerraformExportCapability = {
  provider: { name: "planetscale", source: "planetscale/planetscale", version: "~> 1.0" },
  providerConfig: {
    service_token_id: tf.ref("var.planetscale_service_token_id"),
    service_token: tf.ref("var.planetscale_service_token_secret"),
  },
  variables: [
    {
      name: "planetscale_service_token_id",
      description: "PlanetScale service token ID (psc_…)",
    },
    {
      name: "planetscale_service_token_secret",
      description: "PlanetScale service token secret",
      sensitive: true,
    },
    {
      name: "planetscale_organization",
      description: "PlanetScale organization slug",
    },
  ],
  supportedResourceTypeIds: ["ps-branch", "ps-password"],
  mapResource(resource): TerraformExportResult | null {
    const organization = tf.ref("var.planetscale_organization");

    switch (resource.resourceTypeId) {
      case "ps-branch": {
        const name = fieldString(resource, "name") || resource.displayName;
        const database = fieldString(resource, "databaseName");
        if (!name || !database) return null;
        const attributes: Record<string, TerraformValue> = {
          organization,
          database: tf.str(database),
          name: tf.str(name),
        };
        const parentBranch = fieldString(resource, "parentBranch");
        if (parentBranch) attributes["parent_branch"] = tf.str(parentBranch);
        const region = fieldString(resource, "region");
        if (region) attributes["region"] = tf.str(region);
        if (fieldBool(resource, "production")) {
          return {
            resource: {
              type: "planetscale_vitess_branch",
              name: `${database}/${name}`,
              attributes,
              importId: resource.externalId ?? `${database}/${name}`,
              comments: [
                "Production branch flag is read-only in Terraform — enforce via",
                "PlanetScale dashboard or branch protection settings.",
              ],
            },
          };
        }
        return {
          resource: {
            type: "planetscale_vitess_branch",
            name: `${database}/${name}`,
            attributes,
            importId: resource.externalId ?? `${database}/${name}`,
          },
        };
      }
      case "ps-password": {
        const name = fieldString(resource, "name") || resource.displayName;
        const database = fieldString(resource, "databaseName");
        const branch = fieldString(resource, "branchName");
        if (!database || !branch) return null;
        const role = fieldString(resource, "role") ?? "reader";
        const attributes: Record<string, TerraformValue> = {
          organization,
          database: tf.str(database),
          branch: tf.str(branch),
          role: tf.str(role),
        };
        if (name) attributes["name"] = tf.str(name);
        // externalId is `{database}/{branch}/{passwordId}` — import uses password id.
        const parts = (resource.externalId ?? "").split("/");
        const passwordId = parts.length >= 3 ? parts.slice(2).join("/") : resource.externalId;
        return {
          resource: {
            type: "planetscale_vitess_branch_password",
            name: name || `${branch} password`,
            attributes,
            ...(passwordId ? { importId: passwordId } : {}),
            comments: [
              "Password plaintext is only available at create time in Terraform —",
              "import existing credentials and rotate if the secret is unknown.",
            ],
          },
        };
      }
      default:
        return null;
    }
  },
};
