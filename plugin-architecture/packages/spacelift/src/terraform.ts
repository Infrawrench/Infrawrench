import type {
  ResourceInstance,
  TerraformExportCapability,
  TerraformExportResult,
  TerraformValue,
} from "@infrawrench/plugin-base";
import { fieldBool, fieldString, sanitizeTerraformName, tf } from "@infrawrench/plugin-base";
import { labelList } from "./mappers.js";

/**
 * Terraform mapping for Spacelift itself: the official
 * `spacelift-io/spacelift` provider (v1.55, arguments and import ids from its
 * docs/resources/*.md, 2026-10). Stack, space, context, policy and module
 * import by id; environment variables by `context/<context id>/<name>`.
 * Mounted files are left out (their content is write-only and the provider
 * wants it base64-encoded), as are worker pools (created from a CSR the
 * inventory cannot hold). The provider reads its endpoint and API key from
 * variables.
 */

function opt(attrs: Record<string, TerraformValue>, key: string, value: string): void {
  if (value) attrs[key] = tf.str(value);
}

function labels(attrs: Record<string, TerraformValue>, r: ResourceInstance): void {
  const l = labelList(fieldString(r, "labels"));
  if (l.length > 0) attrs["labels"] = tf.list(l.map((x) => tf.str(x)));
}

function mapStack(r: ResourceInstance): TerraformExportResult | null {
  const name = fieldString(r, "name") || r.displayName;
  const repository = fieldString(r, "repository");
  const branch = fieldString(r, "branch");
  if (!name || !repository || !branch) return null;
  const attrs: Record<string, TerraformValue> = {
    name: tf.str(name),
    repository: tf.str(repository),
    branch: tf.str(branch),
  };
  opt(attrs, "space_id", fieldString(r, "space"));
  opt(attrs, "description", fieldString(r, "description"));
  opt(attrs, "project_root", fieldString(r, "projectRoot"));
  opt(attrs, "runner_image", fieldString(r, "runnerImage"));
  opt(attrs, "worker_pool_id", fieldString(r, "workerPoolId"));
  for (const [field, attr] of [
    ["autodeploy", "autodeploy"],
    ["autoretry", "autoretry"],
    ["protectFromDeletion", "protect_from_deletion"],
    ["managesState", "manage_state"],
  ] as const) {
    if (r.fields[field] !== undefined) attrs[attr] = tf.bool(fieldBool(r, field));
  }
  const vendor = fieldString(r, "vendor");
  const version = fieldString(r, "toolVersion");
  const comments: string[] = [];
  if (vendor === "Terraform" || vendor === "OpenTofu") {
    if (version) attrs["terraform_version"] = tf.str(version);
    attrs["terraform_workflow_tool"] = tf.str(
      vendor === "OpenTofu" ? "OPEN_TOFU" : "TERRAFORM_FOSS",
    );
  } else if (vendor) {
    comments.push(`This is a ${vendor} stack: add its ${vendor.toLowerCase()} block by hand.`);
  }
  labels(attrs, r);
  return {
    resource: {
      type: "spacelift_stack",
      name,
      attributes: attrs,
      importId: r.externalId,
      ...(comments.length > 0 ? { comments } : {}),
    },
  };
}

export const spaceliftTerraformExport: TerraformExportCapability = {
  provider: { name: "spacelift", source: "spacelift-io/spacelift", version: "~> 1.55" },
  providerConfig: {
    api_key_endpoint: tf.ref("var.spacelift_api_key_endpoint"),
    api_key_id: tf.ref("var.spacelift_api_key_id"),
    api_key_secret: tf.ref("var.spacelift_api_key_secret"),
  },
  variables: [
    {
      name: "spacelift_api_key_endpoint",
      description: "Spacelift account URL, e.g. https://acme.app.spacelift.io",
    },
    { name: "spacelift_api_key_id", description: "Spacelift API key ID" },
    { name: "spacelift_api_key_secret", description: "Spacelift API key secret", sensitive: true },
  ],
  supportedResourceTypeIds: ["stack", "space", "context", "context-variable", "policy", "module"],
  mapResource(r): TerraformExportResult | null {
    const name = fieldString(r, "name") || r.displayName;
    switch (r.resourceTypeId) {
      case "stack":
        return mapStack(r);
      case "space": {
        if (!name) return null;
        const attrs: Record<string, TerraformValue> = { name: tf.str(name) };
        opt(attrs, "parent_space_id", fieldString(r, "parentSpace"));
        opt(attrs, "description", fieldString(r, "description"));
        if (r.fields["inheritEntities"] !== undefined)
          attrs["inherit_entities"] = tf.bool(fieldBool(r, "inheritEntities"));
        labels(attrs, r);
        return {
          resource: { type: "spacelift_space", name, attributes: attrs, importId: r.externalId },
        };
      }
      case "context": {
        if (!name) return null;
        const attrs: Record<string, TerraformValue> = { name: tf.str(name) };
        opt(attrs, "space_id", fieldString(r, "space"));
        opt(attrs, "description", fieldString(r, "description"));
        labels(attrs, r);
        return {
          resource: { type: "spacelift_context", name, attributes: attrs, importId: r.externalId },
        };
      }
      case "context-variable": {
        const contextId = fieldString(r, "contextId");
        if (!name || !contextId || fieldString(r, "type") === "file") return null;
        const attrs: Record<string, TerraformValue> = {
          context_id: tf.str(contextId),
          name: tf.str(name),
        };
        const secret = fieldBool(r, "writeOnly");
        const variables: TerraformExportResult["variables"] = [];
        if (secret) {
          const v = `spacelift_${sanitizeTerraformName(`${contextId}_${name}`).toLowerCase()}`;
          attrs["value"] = tf.ref(`var.${v}`);
          variables.push({
            name: v,
            description: `Value of ${name} in context ${contextId}`,
            sensitive: true,
          });
        } else {
          attrs["value"] = tf.str(fieldString(r, "value"));
        }
        attrs["write_only"] = tf.bool(secret);
        opt(attrs, "description", fieldString(r, "description"));
        return {
          resource: {
            type: "spacelift_environment_variable",
            name: `${contextId}_${name}`,
            attributes: attrs,
            importId: `context/${contextId}/${name}`,
          },
          ...(variables.length > 0 ? { variables } : {}),
        };
      }
      case "policy": {
        const body = fieldString(r, "body");
        const type = fieldString(r, "type");
        if (!name || !body || !type) return null;
        const attrs: Record<string, TerraformValue> = {
          name: tf.str(name),
          type: tf.str(type),
          body: tf.str(body),
        };
        opt(attrs, "space_id", fieldString(r, "space"));
        opt(attrs, "description", fieldString(r, "description"));
        labels(attrs, r);
        return {
          resource: { type: "spacelift_policy", name, attributes: attrs, importId: r.externalId },
        };
      }
      case "module": {
        const repository = fieldString(r, "repository");
        const branch = fieldString(r, "branch");
        if (!repository || !branch) return null;
        const attrs: Record<string, TerraformValue> = {
          repository: tf.str(repository),
          branch: tf.str(branch),
        };
        opt(attrs, "name", fieldString(r, "name"));
        opt(attrs, "terraform_provider", fieldString(r, "terraformProvider"));
        opt(attrs, "space_id", fieldString(r, "space"));
        opt(attrs, "description", fieldString(r, "description"));
        labels(attrs, r);
        return {
          resource: {
            type: "spacelift_module",
            name: name || repository,
            attributes: attrs,
            importId: r.externalId,
          },
        };
      }
      default:
        return null;
    }
  },
};
