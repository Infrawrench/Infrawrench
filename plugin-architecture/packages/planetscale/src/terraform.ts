import type {
  TerraformExportCapability,
  TerraformExportResult,
  TerraformValue,
} from "@infrawrench/plugin-base";
import { fieldBool, fieldString, tf } from "@infrawrench/plugin-base";

/**
 * Terraform mapping for PlanetScale: provider `planetscale/planetscale` v1.
 * Attribute names and import formats verified against the provider's docs
 * (github.com/planetscale/terraform-provider-planetscale/docs/resources,
 * October 2026):
 *   - planetscale_vitess_branch / planetscale_postgres_branch: `organization`,
 *     `database`, `name` required; `parent_branch`, `region`,
 *     `deletion_protected` optional (vitess adds `safe_migrations`).
 *   - planetscale_vitess_branch_password: `organization`, `database`,
 *     `branch` required; `name`, `role`, `cidrs`, `replica` optional.
 *   - planetscale_postgres_branch_role: `organization`, `database`, `branch`
 *     required; `name`, `inherited_roles` optional.
 * Every import id is a JSON object carrying the organization, database,
 * (branch,) and the object's PlanetScale id. There is no database resource
 * in the provider, so ps-database is intentionally skipped.
 * Service token credentials map to provider service_token_id / secret.
 */
export const planetscaleTerraformExport: TerraformExportCapability = {
  provider: { name: "planetscale", source: "planetscale/planetscale", version: "~> 1.8" },
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
  supportedResourceTypeIds: ["ps-branch", "ps-password", "ps-role"],
  mapResource(resource): TerraformExportResult | null {
    const organization = tf.ref("var.planetscale_organization");
    const org = fieldString(resource, "organization");

    switch (resource.resourceTypeId) {
      case "ps-branch": {
        const name = fieldString(resource, "name") || resource.displayName;
        const database = fieldString(resource, "databaseName");
        if (!name || !database) return null;
        const postgres = fieldString(resource, "kind") === "postgresql";
        const attributes: Record<string, TerraformValue> = {
          organization,
          database: tf.str(database),
          name: tf.str(name),
        };
        const parentBranch = fieldString(resource, "parentBranch");
        if (parentBranch) attributes["parent_branch"] = tf.str(parentBranch);
        const region = fieldString(resource, "region");
        if (region) attributes["region"] = tf.str(region);
        if (fieldBool(resource, "deletionProtected")) {
          attributes["deletion_protected"] = tf.bool(true);
        }
        if (!postgres && fieldBool(resource, "safeMigrations")) {
          attributes["safe_migrations"] = tf.bool(true);
        }
        const id = fieldString(resource, "id");
        return {
          resource: {
            type: postgres ? "planetscale_postgres_branch" : "planetscale_vitess_branch",
            name: `${database}/${name}`,
            attributes,
            ...(id && org ? { importId: JSON.stringify({ database, id, organization: org }) } : {}),
            ...(fieldBool(resource, "production")
              ? {
                  comments: [
                    "Production status is not a Terraform attribute: promote the branch",
                    "in PlanetScale (or from Infrawrench) after creating it.",
                  ],
                }
              : {}),
          },
        };
      }
      case "ps-password": {
        const name = fieldString(resource, "name") || resource.displayName;
        const database = fieldString(resource, "databaseName");
        const branch = fieldString(resource, "branchName");
        if (!database || !branch) return null;
        const role = fieldString(resource, "role") || "reader";
        const attributes: Record<string, TerraformValue> = {
          organization,
          database: tf.str(database),
          branch: tf.str(branch),
          role: tf.str(role),
        };
        if (name) attributes["name"] = tf.str(name);
        if (fieldBool(resource, "replica")) attributes["replica"] = tf.bool(true);
        const cidrs = fieldString(resource, "cidrs")
          .split(",")
          .map((c) => c.trim())
          .filter(Boolean);
        if (cidrs.length > 0) attributes["cidrs"] = tf.list(cidrs.map((c) => tf.str(c)));
        return {
          resource: {
            type: "planetscale_vitess_branch_password",
            name: name || `${branch} password`,
            attributes,
            ...branchScopedImport(org, database, branch, resource.externalId),
            comments: [
              "Password plaintext is only available at create time in Terraform —",
              "import existing credentials and rotate if the secret is unknown.",
            ],
          },
        };
      }
      case "ps-role": {
        const database = fieldString(resource, "databaseName");
        const branch = fieldString(resource, "branchName");
        if (!database || !branch) return null;
        const name = fieldString(resource, "name");
        const attributes: Record<string, TerraformValue> = {
          organization,
          database: tf.str(database),
          branch: tf.str(branch),
        };
        if (name) attributes["name"] = tf.str(name);
        const inherited = fieldString(resource, "inheritedRoles")
          .split(",")
          .map((r) => r.trim())
          .filter(Boolean);
        if (inherited.length > 0) {
          attributes["inherited_roles"] = tf.list(inherited.map((r) => tf.str(r)));
        }
        return {
          resource: {
            type: "planetscale_postgres_branch_role",
            name: name || resource.displayName || `${branch} role`,
            attributes,
            ...branchScopedImport(org, database, branch, resource.externalId),
            comments: [
              "The role's password is only available at create time in Terraform:",
              "import existing roles and reset the password if the secret is unknown.",
            ],
          },
        };
      }
      default:
        return null;
    }
  },
};

/** `{database}/{branch}/{id}` external id → the provider's JSON import id. */
function branchScopedImport(
  organization: string,
  database: string,
  branch: string,
  externalId: string | undefined,
): { importId?: string } {
  const parts = (externalId ?? "").split("/");
  const id = parts.length >= 3 ? parts.slice(2).join("/") : "";
  if (!id || !organization) return {};
  return { importId: JSON.stringify({ branch, database, id, organization }) };
}
