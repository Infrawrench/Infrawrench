import type {
  ResourceInstance,
  TerraformExportCapability,
  TerraformExportResult,
  TerraformValue,
} from "@infrawrench/plugin-base";
import { fieldBool, fieldString, sanitizeTerraformName, tf } from "@infrawrench/plugin-base";
import { TEAM_ACCESS_FLAGS, camel } from "./mappers.js";

/**
 * Terraform mapping for HCP Terraform itself: the official `hashicorp/tfe`
 * provider (v0.81, argument names and import ids from
 * hashicorp/terraform-provider-tfe `website/docs/r/*.html.markdown`, 2026-10).
 *
 * Import ids:
 *   - workspace, project, variable set, agent pool: the object id;
 *   - workspace variable: `<org>/<workspace name>/<var id>`;
 *   - variable set variable: `<org>/<varset id>/<var id>`;
 *   - team: `<org>/<team id>`; organization run task: `<org>/<task name>`.
 * Sensitive variable values and run task HMAC keys are never returned by the
 * API, so they become variables. Workspace execution mode and agent pool are
 * left out: the provider deprecated them on `tfe_workspace` in favour of
 * `tfe_workspace_settings`.
 */

function opt(attrs: Record<string, TerraformValue>, key: string, value: string | undefined): void {
  if (value) attrs[key] = tf.str(value);
}

function bools(
  r: ResourceInstance,
  attrs: Record<string, TerraformValue>,
  map: Record<string, string>,
): void {
  for (const [field, attr] of Object.entries(map)) {
    if (r.fields[field] !== undefined) attrs[attr] = tf.bool(fieldBool(r, field));
  }
}

function org(r: ResourceInstance): TerraformValue {
  const o = fieldString(r, "organization");
  return o ? tf.str(o) : tf.ref("var.tfe_organization");
}

function variable(
  r: ResourceInstance,
  owner: { attr: "workspace_id" | "variable_set_id"; id: string },
  importId: string | undefined,
): TerraformExportResult | null {
  const key = fieldString(r, "key");
  if (!key || !owner.id) return null;
  const attrs: Record<string, TerraformValue> = {
    key: tf.str(key),
    category: tf.str(fieldString(r, "category") || "terraform"),
    [owner.attr]: tf.str(owner.id),
  };
  const sensitive = fieldBool(r, "sensitive");
  const variables: TerraformExportResult["variables"] = [];
  if (sensitive) {
    const name = `tfe_var_${sanitizeTerraformName(`${r.displayName}_${key}`).toLowerCase()}`;
    attrs["value"] = tf.ref(`var.${name}`);
    attrs["sensitive"] = tf.bool(true);
    variables.push({
      name,
      description: `Value of the sensitive variable ${key}`,
      sensitive: true,
    });
  } else {
    attrs["value"] = tf.str(fieldString(r, "value"));
  }
  bools(r, attrs, { hcl: "hcl" });
  opt(attrs, "description", fieldString(r, "description"));
  return {
    resource: {
      type: "tfe_variable",
      name: key,
      attributes: attrs,
      ...(importId ? { importId } : {}),
    },
    ...(variables.length > 0 ? { variables } : {}),
  };
}

export const tfeTerraformExport: TerraformExportCapability = {
  provider: { name: "tfe", source: "hashicorp/tfe", version: "~> 0.81" },
  providerConfig: {
    hostname: tf.ref("var.tfe_hostname"),
    token: tf.ref("var.tfe_token"),
  },
  variables: [
    {
      name: "tfe_hostname",
      description: "HCP Terraform or Terraform Enterprise hostname, e.g. app.terraform.io",
    },
    {
      name: "tfe_token",
      description: "API token with access to the organization",
      sensitive: true,
    },
    {
      name: "tfe_organization",
      description: "Organization name, used where a resource did not record it",
    },
  ],
  supportedResourceTypeIds: [
    "workspace",
    "project",
    "variable",
    "variable-set",
    "varset-variable",
    "agent-pool",
    "team",
    "run-task",
  ],
  mapResource(r): TerraformExportResult | null {
    const name = fieldString(r, "name") || r.displayName;
    const o = fieldString(r, "organization");
    switch (r.resourceTypeId) {
      case "workspace": {
        if (!name) return null;
        const attrs: Record<string, TerraformValue> = { name: tf.str(name), organization: org(r) };
        opt(attrs, "project_id", fieldString(r, "projectId"));
        opt(attrs, "description", fieldString(r, "description"));
        opt(attrs, "terraform_version", fieldString(r, "terraformVersion"));
        opt(attrs, "working_directory", fieldString(r, "workingDirectory"));
        opt(attrs, "auto_destroy_activity_duration", fieldString(r, "autoDestroyActivityDuration"));
        bools(r, attrs, {
          autoApply: "auto_apply",
          autoApplyRunTrigger: "auto_apply_run_trigger",
          assessmentsEnabled: "assessments_enabled",
          allowDestroyPlan: "allow_destroy_plan",
          speculativeEnabled: "speculative_enabled",
          fileTriggersEnabled: "file_triggers_enabled",
          queueAllRuns: "queue_all_runs",
        });
        return {
          resource: {
            type: "tfe_workspace",
            name,
            attributes: attrs,
            importId: fieldString(r, "workspaceId") || r.externalId,
            ...(fieldString(r, "vcsRepo")
              ? {
                  comments: [
                    "The VCS connection (vcs_repo) needs an OAuth token id: add it by hand.",
                  ],
                }
              : {}),
          },
        };
      }
      case "project": {
        if (!name) return null;
        const attrs: Record<string, TerraformValue> = { name: tf.str(name), organization: org(r) };
        opt(attrs, "description", fieldString(r, "description"));
        opt(attrs, "auto_destroy_activity_duration", fieldString(r, "autoDestroyActivityDuration"));
        return {
          resource: { type: "tfe_project", name, attributes: attrs, importId: r.externalId },
        };
      }
      case "variable": {
        const ws = fieldString(r, "workspaceId");
        const wsName = fieldString(r, "workspaceName");
        const id = fieldString(r, "variableId");
        return variable(
          r,
          { attr: "workspace_id", id: ws },
          o && wsName && id ? `${o}/${wsName}/${id}` : undefined,
        );
      }
      case "varset-variable": {
        const vs = fieldString(r, "varsetId");
        const id = fieldString(r, "variableId");
        return variable(
          r,
          { attr: "variable_set_id", id: vs },
          o && vs && id ? `${o}/${vs}/${id}` : undefined,
        );
      }
      case "variable-set": {
        if (!name) return null;
        const attrs: Record<string, TerraformValue> = { name: tf.str(name), organization: org(r) };
        opt(attrs, "description", fieldString(r, "description"));
        bools(r, attrs, { global: "global", priority: "priority" });
        return {
          resource: { type: "tfe_variable_set", name, attributes: attrs, importId: r.externalId },
        };
      }
      case "agent-pool": {
        if (!name) return null;
        const attrs: Record<string, TerraformValue> = { name: tf.str(name), organization: org(r) };
        bools(r, attrs, { organizationScoped: "organization_scoped" });
        return {
          resource: { type: "tfe_agent_pool", name, attributes: attrs, importId: r.externalId },
        };
      }
      case "team": {
        if (!name) return null;
        const attrs: Record<string, TerraformValue> = { name: tf.str(name), organization: org(r) };
        opt(attrs, "visibility", fieldString(r, "visibility"));
        opt(attrs, "sso_team_id", fieldString(r, "ssoTeamId"));
        bools(r, attrs, { allowMemberTokenManagement: "allow_member_token_management" });
        const access: Record<string, TerraformValue> = {};
        for (const k of TEAM_ACCESS_FLAGS) {
          const field = camel(k);
          if (r.fields[field] !== undefined)
            access[k.replace(/-/g, "_")] = tf.bool(fieldBool(r, field));
        }
        if (Object.keys(access).length > 0) attrs["organization_access"] = tf.block(access);
        return {
          resource: {
            type: "tfe_team",
            name,
            attributes: attrs,
            ...(o && r.externalId ? { importId: `${o}/${r.externalId}` } : {}),
          },
        };
      }
      case "run-task": {
        const url = fieldString(r, "url");
        if (!name || !url) return null;
        const attrs: Record<string, TerraformValue> = {
          name: tf.str(name),
          organization: org(r),
          url: tf.str(url),
          category: tf.str("task"),
        };
        opt(attrs, "description", fieldString(r, "description"));
        bools(r, attrs, { enabled: "enabled" });
        return {
          resource: {
            type: "tfe_organization_run_task",
            name,
            attributes: attrs,
            ...(o ? { importId: `${o}/${name}` } : {}),
            comments: [
              "The API never returns the HMAC key: set hmac_key yourself if the task uses one.",
            ],
          },
        };
      }
      default:
        return null;
    }
  },
};
