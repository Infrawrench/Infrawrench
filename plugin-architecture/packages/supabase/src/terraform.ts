import type {
  TerraformExportCapability,
  TerraformExportResult,
  TerraformValue,
} from "@infrawrench/plugin-base";
import { fieldBool, fieldString, tf } from "@infrawrench/plugin-base";

/**
 * Terraform mapping for Supabase: provider `supabase/supabase` (1.11.0,
 * September 2026). Attribute names and import ids verified against the
 * provider's docs (github.com/supabase/terraform-provider-supabase/docs):
 *   - supabase_project: `organization_id` (the org slug), `name`, `region`,
 *     `database_password` required; `instance_size` optional. Import id: ref.
 *   - supabase_settings is not emitted: the export maps one resource to one
 *     block, and the project block is the one worth importing. Its settings
 *     are JSON strings (`network = {"restrictions": [...]}`) if added later.
 *   - supabase_branch: `parent_project_ref` and `git_branch` required,
 *     `persistent` and `region` optional. Import id: the branch UUID, which
 *     the inventory does not keep (the external id uses the branch ref), so
 *     branches are emitted without an import id.
 *   - supabase_apikey: `project_ref`, `name` required, `description`
 *     optional. Import id: `{ref}/{name}`. Legacy anon/service_role keys are
 *     not API-key objects and are skipped.
 * Edge functions are deliberately skipped: the provider resource deploys
 * from local files (`entrypoint` is a path on the machine running
 * Terraform), which an inventory cannot supply.
 */
export const supabaseTerraformExport: TerraformExportCapability = {
  provider: { name: "supabase", source: "supabase/supabase", version: "~> 1.11" },
  providerConfig: { access_token: tf.ref("var.supabase_access_token") },
  variables: [
    {
      name: "supabase_access_token",
      description: "Supabase personal access token (sbp_…)",
      sensitive: true,
    },
  ],
  supportedResourceTypeIds: ["supabase-project", "supabase-branch", "supabase-api-key"],
  mapResource(resource): TerraformExportResult | null {
    switch (resource.resourceTypeId) {
      case "supabase-project": {
        const ref = fieldString(resource, "ref") || resource.externalId || "";
        const name = fieldString(resource, "name") || resource.displayName;
        const org = fieldString(resource, "organizationSlug");
        const region = fieldString(resource, "region");
        if (!ref || !org || !region) return null;
        const varName = `supabase_db_password_${ref}`;
        const attributes: Record<string, TerraformValue> = {
          organization_id: tf.str(org),
          name: tf.str(name),
          region: tf.str(region),
          database_password: tf.ref(`var.${varName}`),
        };
        const size = fieldString(resource, "computeSize");
        if (size) attributes["instance_size"] = tf.str(size);
        return {
          resource: {
            type: "supabase_project",
            name,
            attributes,
            importId: ref,
            comments: [
              "database_password is only used at create time; after an import, set it",
              "to the project's current password or Terraform will not change it.",
            ],
          },
          variables: [
            { name: varName, description: `Database password for ${name}`, sensitive: true },
          ],
        };
      }
      case "supabase-branch": {
        const parent = fieldString(resource, "parentRef");
        const gitBranch = fieldString(resource, "gitBranch");
        if (!parent || !gitBranch || fieldBool(resource, "isDefault")) return null;
        const attributes: Record<string, TerraformValue> = {
          parent_project_ref: tf.str(parent),
          git_branch: tf.str(gitBranch),
        };
        if (fieldBool(resource, "persistent")) attributes["persistent"] = tf.bool(true);
        return {
          resource: {
            type: "supabase_branch",
            name: fieldString(resource, "name") || resource.displayName,
            attributes,
            comments: ["Import with the branch UUID from `supabase branches list`."],
          },
        };
      }
      case "supabase-api-key": {
        const ref = fieldString(resource, "projectRef");
        const name = fieldString(resource, "name") || resource.displayName;
        const type = fieldString(resource, "type");
        if (!ref || !name || type === "legacy") return null;
        const attributes: Record<string, TerraformValue> = {
          project_ref: tf.str(ref),
          name: tf.str(name),
        };
        const description = fieldString(resource, "description");
        if (description) attributes["description"] = tf.str(description);
        return {
          resource: {
            type: "supabase_apikey",
            name,
            attributes,
            importId: `${ref}/${name}`,
          },
        };
      }
      default:
        return null;
    }
  },
};
