import type {
  ResourceInstance,
  TerraformExportCapability,
  TerraformExportResult,
  TerraformValue,
} from "@infrawrench/plugin-base";
import {
  fieldBool,
  fieldNumber,
  fieldString,
  sanitizeTerraformName,
  tf,
} from "@infrawrench/plugin-base";

/**
 * Terraform mapping for Buildkite: the official provider `buildkite/buildkite`
 * (registry.terraform.io/providers/buildkite/buildkite, v1.40, attribute names
 * and import ids verified against its docs/resources/*.md, 2026-10).
 *
 * The provider addresses most objects by GraphQL id, which the REST API also
 * returns, so the listers store `graphqlId` (and the cluster's and pipeline's
 * GraphQL ids on their children). Import ids:
 *   - pipeline, cluster, pipeline template: the GraphQL id;
 *   - cluster queue: `<cluster uuid>/<queue key>`;
 *   - pipeline schedule: `<pipeline slug>/<schedule uuid>`;
 *   - cluster secret: `<cluster uuid>/<secret uuid>`.
 * Agent tokens have no import in the provider and their value is only shown
 * at creation, so they are left out; test suites need a `team_owner_id` the
 * REST API does not return.
 */

function opt(
  attrs: Record<string, TerraformValue>,
  key: string,
  value: string | number | boolean | undefined,
): void {
  if (value === undefined || value === "") return;
  attrs[key] =
    typeof value === "number"
      ? tf.num(value)
      : typeof value === "boolean"
        ? tf.bool(value)
        : tf.str(value);
}

function mapPipeline(r: ResourceInstance): TerraformExportResult | null {
  const name = fieldString(r, "name") || r.displayName;
  const repository = fieldString(r, "repository");
  if (!name || !repository) return null;
  const attrs: Record<string, TerraformValue> = {
    name: tf.str(name),
    repository: tf.str(repository),
  };
  opt(attrs, "slug", fieldString(r, "slug"));
  opt(attrs, "description", fieldString(r, "description"));
  opt(attrs, "cluster_id", fieldString(r, "clusterGraphqlId"));
  opt(attrs, "default_branch", fieldString(r, "defaultBranch"));
  opt(attrs, "branch_configuration", fieldString(r, "branchConfiguration"));
  attrs["skip_intermediate_builds"] = tf.bool(fieldBool(r, "skipQueuedBranchBuilds"));
  opt(
    attrs,
    "skip_intermediate_builds_branch_filter",
    fieldString(r, "skipQueuedBranchBuildsFilter"),
  );
  attrs["cancel_intermediate_builds"] = tf.bool(fieldBool(r, "cancelRunningBranchBuilds"));
  opt(
    attrs,
    "cancel_intermediate_builds_branch_filter",
    fieldString(r, "cancelRunningBranchBuildsFilter"),
  );
  if (r.fields["allowRebuilds"] !== undefined) {
    attrs["allow_rebuilds"] = tf.bool(fieldBool(r, "allowRebuilds"));
  }
  const visibility = fieldString(r, "visibility");
  if (visibility) attrs["visibility"] = tf.str(visibility.toUpperCase());
  opt(attrs, "default_timeout_in_minutes", fieldNumber(r, "defaultTimeoutMinutes"));
  opt(attrs, "maximum_timeout_in_minutes", fieldNumber(r, "maximumTimeoutMinutes"));
  opt(attrs, "emoji", fieldString(r, "emoji"));
  opt(attrs, "color", fieldString(r, "color"));
  const tags = fieldString(r, "tags")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  if (tags.length > 0) attrs["tags"] = tf.list(tags.map((t) => tf.str(t)));
  const steps = fieldString(r, "configuration");
  if (steps) attrs["steps"] = tf.str(steps);
  if (fieldBool(r, "archived")) attrs["archived"] = tf.bool(true);
  return {
    resource: {
      type: "buildkite_pipeline",
      name,
      attributes: attrs,
      importId: fieldString(r, "graphqlId") || r.externalId,
      ...(steps
        ? {}
        : {
            comments: [
              "Steps were not synced for this pipeline; the provider defaults to `buildkite-agent pipeline upload`.",
            ],
          }),
    },
  };
}

function mapCluster(r: ResourceInstance): TerraformExportResult | null {
  const name = fieldString(r, "name") || r.displayName;
  if (!name) return null;
  const attrs: Record<string, TerraformValue> = { name: tf.str(name) };
  opt(attrs, "description", fieldString(r, "description"));
  opt(attrs, "emoji", fieldString(r, "emoji"));
  opt(attrs, "color", fieldString(r, "color"));
  const importId = fieldString(r, "graphqlId");
  return {
    resource: {
      type: "buildkite_cluster",
      name,
      attributes: attrs,
      ...(importId ? { importId } : {}),
    },
  };
}

function mapQueue(r: ResourceInstance): TerraformExportResult | null {
  const clusterGid = fieldString(r, "clusterGraphqlId");
  const key = fieldString(r, "key");
  if (!clusterGid || !key) return null;
  const attrs: Record<string, TerraformValue> = {
    cluster_id: tf.str(clusterGid),
    key: tf.str(key),
  };
  opt(attrs, "description", fieldString(r, "description"));
  opt(attrs, "retry_agent_affinity", fieldString(r, "retryAgentAffinity"));
  if (fieldBool(r, "dispatchPaused")) attrs["dispatch_paused"] = tf.bool(true);
  const shape = fieldString(r, "instanceShape");
  if (shape) attrs["hosted_agents"] = tf.map({ instance_shape: tf.str(shape) });
  const clusterId = fieldString(r, "clusterId");
  return {
    resource: {
      type: "buildkite_cluster_queue",
      name: `${fieldString(r, "clusterName") || "cluster"}_${key}`,
      attributes: attrs,
      ...(clusterId ? { importId: `${clusterId}/${key}` } : {}),
    },
  };
}

function mapSchedule(r: ResourceInstance): TerraformExportResult | null {
  const pipelineGid = fieldString(r, "pipelineGraphqlId");
  const cronline = fieldString(r, "cronline");
  const branch = fieldString(r, "branch");
  const label = fieldString(r, "label") || r.displayName;
  if (!pipelineGid || !cronline || !branch || !label) return null;
  const attrs: Record<string, TerraformValue> = {
    pipeline_id: tf.str(pipelineGid),
    label: tf.str(label),
    cronline: tf.str(cronline),
    branch: tf.str(branch),
  };
  opt(attrs, "commit", fieldString(r, "commit"));
  opt(attrs, "message", fieldString(r, "message"));
  if (r.fields["enabled"] !== undefined) attrs["enabled"] = tf.bool(fieldBool(r, "enabled"));
  const env: Record<string, TerraformValue> = {};
  for (const line of fieldString(r, "env").split("\n")) {
    const eq = line.indexOf("=");
    if (eq > 0) env[line.slice(0, eq).trim()] = tf.str(line.slice(eq + 1));
  }
  if (Object.keys(env).length > 0) attrs["env"] = tf.map(env);
  const slug = fieldString(r, "pipelineSlug");
  const id = fieldString(r, "scheduleId");
  return {
    resource: {
      type: "buildkite_pipeline_schedule",
      name: `${slug}_${label}`,
      attributes: attrs,
      ...(slug && id ? { importId: `${slug}/${id}` } : {}),
    },
  };
}

function mapTemplate(r: ResourceInstance): TerraformExportResult | null {
  const name = fieldString(r, "name") || r.displayName;
  const configuration = fieldString(r, "configuration");
  if (!name || !configuration) return null;
  const attrs: Record<string, TerraformValue> = {
    name: tf.str(name),
    configuration: tf.str(configuration),
  };
  opt(attrs, "description", fieldString(r, "description"));
  attrs["available"] = tf.bool(fieldBool(r, "available"));
  const importId = fieldString(r, "graphqlId");
  return {
    resource: {
      type: "buildkite_pipeline_template",
      name,
      attributes: attrs,
      ...(importId ? { importId } : {}),
    },
  };
}

function mapSecret(r: ResourceInstance): TerraformExportResult | null {
  const clusterId = fieldString(r, "clusterId");
  const key = fieldString(r, "key");
  if (!clusterId || !key) return null;
  const varName = `buildkite_secret_${sanitizeTerraformName(key).toLowerCase()}`;
  const attrs: Record<string, TerraformValue> = {
    cluster_id: tf.str(clusterId),
    key: tf.str(key),
    value_wo: tf.ref(`var.${varName}`),
    value_wo_version: tf.str("1"),
  };
  opt(attrs, "description", fieldString(r, "description"));
  opt(attrs, "policy", fieldString(r, "policy"));
  const id = fieldString(r, "secretId");
  return {
    resource: {
      type: "buildkite_cluster_secret",
      name: key,
      attributes: attrs,
      ...(id ? { importId: `${clusterId}/${id}` } : {}),
      comments: ["Buildkite never returns secret values: supply it through the variable."],
    },
    variables: [
      { name: varName, description: `Value of the ${key} cluster secret`, sensitive: true },
    ],
  };
}

export const buildkiteTerraformExport: TerraformExportCapability = {
  provider: { name: "buildkite", source: "buildkite/buildkite", version: "~> 1.40" },
  providerConfig: {
    api_token: tf.ref("var.buildkite_api_token"),
    organization: tf.ref("var.buildkite_organization"),
  },
  variables: [
    {
      name: "buildkite_api_token",
      description:
        "Buildkite API access token with GraphQL access and write_pipelines, write_suites",
      sensitive: true,
    },
    { name: "buildkite_organization", description: "Buildkite organization slug" },
  ],
  supportedResourceTypeIds: [
    "pipeline",
    "cluster",
    "queue",
    "schedule",
    "pipeline-template",
    "cluster-secret",
  ],
  mapResource(resource): TerraformExportResult | null {
    switch (resource.resourceTypeId) {
      case "pipeline":
        return mapPipeline(resource);
      case "cluster":
        return mapCluster(resource);
      case "queue":
        return mapQueue(resource);
      case "schedule":
        return mapSchedule(resource);
      case "pipeline-template":
        return mapTemplate(resource);
      case "cluster-secret":
        return mapSecret(resource);
      default:
        return null;
    }
  },
};
