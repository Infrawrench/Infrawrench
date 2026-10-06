import type {
  ResourceInstance,
  TerraformExportCapability,
  TerraformExportResult,
  TerraformValue,
} from "@infrawrench/plugin-base";
import { fieldBool, sanitizeTerraformName, tf } from "@infrawrench/plugin-base";
import { splitScoped } from "./api.js";
import { HOOK_EVENTS, GROUP_ONLY_HOOK_EVENTS } from "./mappers.js";

/**
 * Terraform mapping for the GitLab-maintained provider `gitlabhq/gitlab`
 * (registry.terraform.io/providers/gitlabhq/gitlab, 19.4.x). Argument names
 * and import ids were checked against the provider's `docs/resources/*.md`
 * on gitlab-org/terraform-provider-gitlab (2026-10):
 *
 * - gitlab_group: `name`, `path`, `parent_id`, `description`, `visibility_level`; import by id.
 * - gitlab_project: `name`, `namespace_id`, `description`, `visibility_level`,
 *   `default_branch`, `ci_config_path`; import by id or path.
 * - gitlab_project_variable / gitlab_group_variable: import `<owner>:<key>:<scope>`.
 *   Values are never inlined: each becomes a sensitive variable.
 * - gitlab_pipeline_schedule: `ref` must be a full ref (`refs/heads/main`); import `<project>:<id>`.
 * - gitlab_branch_protection: `push_access_level` / `merge_access_level` take
 *   `no one`, `developer`, `maintainer`, `admin`; import `<project>:<branch>`.
 * - gitlab_deploy_key: import `<project>:<id>`; the public key body is a variable
 *   because only its fingerprint is synced.
 * - gitlab_project_deploy_token / gitlab_group_deploy_token: import `<owner>:<id>`.
 * - gitlab_project_environment: import `<project>:<id>`.
 * - gitlab_project_hook / gitlab_group_hook: one boolean per event; import `<owner>:<id>`.
 * - gitlab_release: import `<project>:<tag>`.
 * - gitlab_project_membership / gitlab_group_membership: role names in lowercase; import `<owner>:<user id>`.
 *
 * Not exported: pipelines, packages, container repositories (artifacts, not
 * configuration) and runners (gitlab_user_runner cannot adopt an existing
 * runner's token, and the owning group or project is not recorded per runner).
 */

const BRANCH_LEVEL_TF: Record<string, string> = {
  "no one": "no one",
  "developers + maintainers": "developer",
  maintainers: "maintainer",
  administrators: "admin",
};

const MEMBER_LEVEL_TF: Record<string, string> = {
  "no access": "no one",
  "minimal access": "minimal",
  guest: "guest",
  planner: "planner",
  reporter: "reporter",
  "security manager": "security_manager",
  developer: "developer",
  maintainer: "maintainer",
  owner: "owner",
};

/** A stored string field, or undefined when absent or empty. */
function fieldString(resource: ResourceInstance, key: string): string | undefined {
  const v = resource.fields[key];
  return v === undefined || v === null || v === "" ? undefined : String(v);
}

/** A stored boolean field, or undefined when it was never synced. */
function tri(resource: ResourceInstance, key: string): boolean | undefined {
  const v = resource.fields[key];
  return v === undefined ? undefined : fieldBool(resource, key);
}

function owner(resource: ResourceInstance): { id: string; rest: string } | null {
  const ext = resource.externalId ?? "";
  const { scope, rest } = splitScoped(ext);
  if (!scope || !rest) return null;
  return { id: scope, rest };
}

function varName(resource: ResourceInstance, suffix: string): string {
  return sanitizeTerraformName(`${resource.displayName}_${suffix}`).toLowerCase();
}

function mapVariable(
  resource: ResourceInstance,
  kind: "project" | "group",
): TerraformExportResult | null {
  const o = owner(resource);
  const key = fieldString(resource, "key");
  if (!o || !key) return null;
  const scope = fieldString(resource, "environmentScope") || "*";
  const valueVar = varName(resource, "value");
  const attributes: Record<string, TerraformValue> = {
    [kind]: tf.str(o.id),
    key: tf.str(key),
    value: tf.ref(`var.${valueVar}`),
    environment_scope: tf.str(scope),
    variable_type: tf.str(fieldString(resource, "variableType") || "env_var"),
    protected: tf.bool(fieldBool(resource, "protected")),
    masked: tf.bool(fieldBool(resource, "masked")),
  };
  const raw = tri(resource, "raw");
  if (raw !== undefined) attributes["raw"] = tf.bool(raw);
  const description = fieldString(resource, "description");
  if (description) attributes["description"] = tf.str(description);
  return {
    resource: {
      type: kind === "project" ? "gitlab_project_variable" : "gitlab_group_variable",
      name: `${key}_${scope}`,
      attributes,
      importId: `${o.id}:${key}:${scope}`,
    },
    variables: [
      { name: valueVar, description: `Value of GitLab CI/CD variable ${key}`, sensitive: true },
    ],
  };
}

function mapHook(
  resource: ResourceInstance,
  kind: "project" | "group",
): TerraformExportResult | null {
  const o = owner(resource);
  const url = fieldString(resource, "url");
  if (!o || !url) return null;
  const on = new Set(
    (fieldString(resource, "events") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
  const attributes: Record<string, TerraformValue> = {
    [kind]: tf.str(o.id),
    url: tf.str(url),
  };
  for (const event of HOOK_EVENTS) {
    if (kind === "project" && GROUP_ONLY_HOOK_EVENTS.has(event)) continue;
    attributes[`${event}_events`] = tf.bool(on.has(event));
  }
  const ssl = tri(resource, "enableSslVerification");
  if (ssl !== undefined) attributes["enable_ssl_verification"] = tf.bool(ssl);
  const filter = fieldString(resource, "pushEventsBranchFilter");
  if (filter) attributes["push_events_branch_filter"] = tf.str(filter);
  const name = fieldString(resource, "name");
  if (name) attributes["name"] = tf.str(name);
  const description = fieldString(resource, "description");
  if (description) attributes["description"] = tf.str(description);
  return {
    resource: {
      type: kind === "project" ? "gitlab_project_hook" : "gitlab_group_hook",
      name: resource.displayName,
      attributes,
      importId: `${o.id}:${o.rest}`,
      ...(fieldBool(resource, "tokenSet")
        ? {
            comments: [
              "This webhook has a secret token; GitLab never returns it. Add `token` before apply.",
            ],
          }
        : {}),
    },
  };
}

function mapMember(
  resource: ResourceInstance,
  kind: "project" | "group",
): TerraformExportResult | null {
  const o = owner(resource);
  const role = (fieldString(resource, "accessLevel") ?? "").toLowerCase();
  const level = MEMBER_LEVEL_TF[role];
  if (!o || !level) return null;
  const attributes: Record<string, TerraformValue> = {
    [kind === "project" ? "project" : "group_id"]:
      kind === "project" ? tf.str(o.id) : tf.num(Number(o.id)),
    user_id: tf.num(Number(o.rest)),
    access_level: tf.str(level),
  };
  const expires = fieldString(resource, "expiresAt");
  if (expires) attributes["expires_at"] = tf.str(expires.slice(0, 10));
  return {
    resource: {
      type: kind === "project" ? "gitlab_project_membership" : "gitlab_group_membership",
      name: resource.displayName,
      attributes,
      importId: `${o.id}:${o.rest}`,
    },
  };
}

function mapDeployToken(
  resource: ResourceInstance,
  kind: "project" | "group",
): TerraformExportResult | null {
  const o = owner(resource);
  const name = fieldString(resource, "name");
  const scopes = (fieldString(resource, "scopes") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!o || !name || scopes.length === 0 || fieldBool(resource, "revoked")) return null;
  const attributes: Record<string, TerraformValue> = {
    [kind]: tf.str(o.id),
    name: tf.str(name),
    scopes: tf.list(scopes.map(tf.str)),
  };
  const username = fieldString(resource, "username");
  if (username) attributes["username"] = tf.str(username);
  const expires = fieldString(resource, "expiresAt");
  if (expires) attributes["expires_at"] = tf.str(expires);
  return {
    resource: {
      type: kind === "project" ? "gitlab_project_deploy_token" : "gitlab_group_deploy_token",
      name,
      attributes,
      importId: `${o.id}:${o.rest}`,
    },
  };
}

export const gitlabTerraformExport: TerraformExportCapability = {
  provider: { name: "gitlab", source: "gitlabhq/gitlab", version: "~> 19.4" },
  providerConfig: {
    token: tf.ref("var.gitlab_token"),
    base_url: tf.ref("var.gitlab_base_url"),
  },
  variables: [
    {
      name: "gitlab_token",
      description: "GitLab personal or group access token with the api scope",
      sensitive: true,
    },
    {
      name: "gitlab_base_url",
      description:
        "GitLab API URL, e.g. https://gitlab.com/api/v4/ or https://gitlab.example.com/api/v4/",
    },
  ],
  supportedResourceTypeIds: [
    "group",
    "project",
    "project-variable",
    "group-variable",
    "pipeline-schedule",
    "protected-branch",
    "deploy-key",
    "deploy-token",
    "group-deploy-token",
    "environment",
    "project-webhook",
    "group-webhook",
    "release",
    "project-member",
    "group-member",
  ],
  mapResource(resource): TerraformExportResult | null {
    switch (resource.resourceTypeId) {
      case "group": {
        const name = fieldString(resource, "name");
        const fullPath = fieldString(resource, "fullPath");
        if (!name || !fullPath || !resource.externalId) return null;
        const attributes: Record<string, TerraformValue> = {
          name: tf.str(name),
          path: tf.str(fullPath.split("/").pop() ?? fullPath),
        };
        const parent = fieldString(resource, "parentId");
        if (parent) attributes["parent_id"] = tf.num(Number(parent));
        const description = fieldString(resource, "description");
        if (description) attributes["description"] = tf.str(description);
        const visibility = fieldString(resource, "visibility");
        if (visibility) attributes["visibility_level"] = tf.str(visibility);
        return {
          resource: {
            type: "gitlab_group",
            name: fullPath,
            attributes,
            importId: resource.externalId,
          },
        };
      }
      case "project": {
        const name = fieldString(resource, "name");
        const path = fieldString(resource, "pathWithNamespace");
        if (!name || !path || !resource.externalId) return null;
        const attributes: Record<string, TerraformValue> = {
          name: tf.str(name),
          path: tf.str(path.split("/").pop() ?? path),
        };
        const ns = fieldString(resource, "namespaceId");
        if (ns) attributes["namespace_id"] = tf.num(Number(ns));
        const description = fieldString(resource, "description");
        if (description) attributes["description"] = tf.str(description);
        const visibility = fieldString(resource, "visibility");
        if (visibility) attributes["visibility_level"] = tf.str(visibility);
        const branch = fieldString(resource, "defaultBranch");
        if (branch) attributes["default_branch"] = tf.str(branch);
        const ci = fieldString(resource, "ciConfigPath");
        if (ci) attributes["ci_config_path"] = tf.str(ci);
        if (fieldBool(resource, "archived")) attributes["archived"] = tf.bool(true);
        return {
          resource: {
            type: "gitlab_project",
            name: path,
            attributes,
            importId: resource.externalId,
          },
        };
      }
      case "project-variable":
        return mapVariable(resource, "project");
      case "group-variable":
        return mapVariable(resource, "group");
      case "pipeline-schedule": {
        const o = owner(resource);
        const description = fieldString(resource, "description");
        const cron = fieldString(resource, "cron");
        const ref = fieldString(resource, "ref");
        if (!o || !description || !cron || !ref) return null;
        const attributes: Record<string, TerraformValue> = {
          project: tf.str(o.id),
          description: tf.str(description),
          cron: tf.str(cron),
          ref: tf.str(ref.startsWith("refs/") ? ref : `refs/heads/${ref}`),
        };
        const tz = fieldString(resource, "cronTimezone");
        if (tz) attributes["cron_timezone"] = tf.str(tz);
        const active = tri(resource, "active");
        if (active !== undefined) attributes["active"] = tf.bool(active);
        return {
          resource: {
            type: "gitlab_pipeline_schedule",
            name: description,
            attributes,
            importId: `${o.id}:${o.rest}`,
            ...(ref.startsWith("refs/")
              ? {}
              : { comments: ["If this schedule runs a tag, change ref to refs/tags/<tag>."] }),
          },
        };
      }
      case "protected-branch": {
        const o = owner(resource);
        if (!o) return null;
        const attributes: Record<string, TerraformValue> = {
          project: tf.str(o.id),
          branch: tf.str(o.rest),
        };
        const push = BRANCH_LEVEL_TF[(fieldString(resource, "pushAccess") ?? "").toLowerCase()];
        if (push) attributes["push_access_level"] = tf.str(push);
        const merge = BRANCH_LEVEL_TF[(fieldString(resource, "mergeAccess") ?? "").toLowerCase()];
        if (merge) attributes["merge_access_level"] = tf.str(merge);
        const force = tri(resource, "allowForcePush");
        if (force !== undefined) attributes["allow_force_push"] = tf.bool(force);
        if (fieldBool(resource, "codeOwnerApprovalRequired")) {
          attributes["code_owner_approval_required"] = tf.bool(true);
        }
        return {
          resource: {
            type: "gitlab_branch_protection",
            name: resource.displayName,
            attributes,
            importId: `${o.id}:${o.rest}`,
          },
        };
      }
      case "deploy-key": {
        const o = owner(resource);
        const title = fieldString(resource, "title");
        if (!o || !title) return null;
        const keyVar = varName(resource, "public_key");
        const attributes: Record<string, TerraformValue> = {
          project: tf.str(o.id),
          title: tf.str(title),
          key: tf.ref(`var.${keyVar}`),
          can_push: tf.bool(fieldBool(resource, "canPush")),
        };
        const expires = fieldString(resource, "expiresAt");
        if (expires) attributes["expires_at"] = tf.str(expires);
        return {
          resource: {
            type: "gitlab_deploy_key",
            name: title,
            attributes,
            importId: `${o.id}:${o.rest}`,
          },
          variables: [{ name: keyVar, description: `Public SSH key of deploy key ${title}` }],
        };
      }
      case "deploy-token":
        return mapDeployToken(resource, "project");
      case "group-deploy-token":
        return mapDeployToken(resource, "group");
      case "environment": {
        const o = owner(resource);
        const name = fieldString(resource, "name");
        if (!o || !name) return null;
        const attributes: Record<string, TerraformValue> = {
          project: tf.str(o.id),
          name: tf.str(name),
        };
        const url = fieldString(resource, "externalUrl");
        if (url) attributes["external_url"] = tf.str(url);
        const tier = fieldString(resource, "tier");
        if (tier) attributes["tier"] = tf.str(tier);
        const description = fieldString(resource, "description");
        if (description) attributes["description"] = tf.str(description);
        return {
          resource: {
            type: "gitlab_project_environment",
            name,
            attributes,
            importId: `${o.id}:${o.rest}`,
          },
        };
      }
      case "project-webhook":
        return mapHook(resource, "project");
      case "group-webhook":
        return mapHook(resource, "group");
      case "release": {
        const o = owner(resource);
        if (!o) return null;
        const attributes: Record<string, TerraformValue> = {
          project: tf.str(o.id),
          tag_name: tf.str(o.rest),
        };
        const name = fieldString(resource, "name");
        if (name) attributes["name"] = tf.str(name);
        const description = fieldString(resource, "description");
        if (description) attributes["description"] = tf.str(description);
        return {
          resource: {
            type: "gitlab_release",
            name: o.rest,
            attributes,
            importId: `${o.id}:${o.rest}`,
          },
        };
      }
      case "project-member":
        return mapMember(resource, "project");
      case "group-member":
        return mapMember(resource, "group");
      default:
        return null;
    }
  },
};
