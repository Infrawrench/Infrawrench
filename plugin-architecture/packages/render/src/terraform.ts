import type {
  ResourceInstance,
  TerraformExportCapability,
  TerraformExportResult,
  TerraformValue,
} from "@infrawrench/plugin-base";
import { fieldBool, fieldNumber, fieldString, tf } from "@infrawrench/plugin-base";

/**
 * Terraform mapping for Render: the official `render-oss/render` provider
 * (v1.9, docs in github.com/render-oss/terraform-provider-render/docs,
 * verified 2026-10). Every resource imports by its Render id.
 *
 *   - render_web_service / render_private_service / render_background_worker:
 *     `name`, `plan`, `region`, `runtime_source` required.
 *   - render_cron_job: the same plus `schedule`.
 *   - render_static_site: `name`, `repo_url`, `branch`, `build_command`.
 *   - runtime_source: exactly one of `native_runtime` {runtime, repo_url,
 *     branch, build_command}, `docker` {repo_url, branch} or `image`
 *     {image_url}.
 *   - render_postgres: `name`, `plan`, `region`, `version`.
 *   - render_keyvalue: `name`, `region`, `max_memory_policy` (+ `plan`).
 *   - render_env_group: `name`; values are never synced, so `env_vars` is
 *     left for the user to fill in (Terraform would otherwise delete them).
 *
 * Projects are skipped: `render_project` requires its whole `environments`
 * map, which lives on separate inventory rows.
 */

const SERVICE_TF_TYPES: Record<string, string> = {
  web_service: "render_web_service",
  private_service: "render_private_service",
  background_worker: "render_background_worker",
  cron_job: "render_cron_job",
};

const NATIVE_RUNTIMES = new Set(["node", "python", "ruby", "go", "rust", "elixir"]);

function runtimeSource(r: ResourceInstance): TerraformValue | null {
  const runtime = fieldString(r, "runtime");
  const repo = fieldString(r, "repo");
  const branch = fieldString(r, "branch");
  const image = fieldString(r, "imagePath");
  if (runtime === "image" || (!repo && image)) {
    return image ? tf.map({ image: tf.map({ image_url: tf.str(image) }) }) : null;
  }
  if (!repo || !branch) return null;
  if (runtime === "docker") {
    return tf.map({ docker: tf.map({ repo_url: tf.str(repo), branch: tf.str(branch) }) });
  }
  if (!NATIVE_RUNTIMES.has(runtime)) return null;
  return tf.map({
    native_runtime: tf.map({
      runtime: tf.str(runtime),
      repo_url: tf.str(repo),
      branch: tf.str(branch),
      build_command: tf.str(fieldString(r, "buildCommand") || ""),
      ...(autoDeploy(r) ? { auto_deploy_trigger: tf.str(autoDeploy(r)!) } : {}),
    }),
  });
}

function autoDeploy(r: ResourceInstance): string | undefined {
  const v = fieldString(r, "autoDeploy");
  return v ? v : undefined;
}

function mapService(r: ResourceInstance): TerraformExportResult | null {
  const name = fieldString(r, "name") || r.displayName;
  const type = fieldString(r, "serviceType");
  if (type === "static_site") {
    const repo = fieldString(r, "repo");
    const branch = fieldString(r, "branch");
    if (!repo || !branch) return null;
    const attributes: Record<string, TerraformValue> = {
      name: tf.str(name),
      repo_url: tf.str(repo),
      branch: tf.str(branch),
      build_command: tf.str(fieldString(r, "buildCommand") || ""),
    };
    const publish = fieldString(r, "publishPath");
    if (publish) attributes["publish_path"] = tf.str(publish);
    const root = fieldString(r, "rootDir");
    if (root) attributes["root_directory"] = tf.str(root);
    return {
      resource: {
        type: "render_static_site",
        name,
        attributes,
        importId: r.externalId,
        comments: ["Headers, routes and custom domains are not reconstructed."],
      },
    };
  }
  const tfType = SERVICE_TF_TYPES[type];
  const plan = fieldString(r, "plan");
  const region = fieldString(r, "region");
  const source = runtimeSource(r);
  if (!tfType || !plan || !region || !source) return null;
  const attributes: Record<string, TerraformValue> = {
    name: tf.str(name),
    plan: tf.str(plan),
    region: tf.str(region),
    runtime_source: source,
  };
  const start = fieldString(r, "startCommand");
  if (start) attributes["start_command"] = tf.str(start);
  const pre = fieldString(r, "preDeployCommand");
  if (pre && type !== "cron_job") attributes["pre_deploy_command"] = tf.str(pre);
  const root = fieldString(r, "rootDir");
  if (root) attributes["root_directory"] = tf.str(root);
  const health = fieldString(r, "healthCheckPath");
  if (health && type === "web_service") attributes["health_check_path"] = tf.str(health);
  const env = fieldString(r, "environmentId");
  if (env) attributes["environment_id"] = tf.str(env);
  if (type === "cron_job") {
    const schedule = fieldString(r, "schedule");
    if (!schedule) return null;
    attributes["schedule"] = tf.str(schedule);
  } else if (fieldBool(r, "autoscalingEnabled")) {
    const min = fieldNumber(r, "autoscalingMin");
    const max = fieldNumber(r, "autoscalingMax");
    if (min !== undefined && max !== undefined) {
      const cpu = fieldNumber(r, "autoscalingCpuPercent");
      const mem = fieldNumber(r, "autoscalingMemoryPercent");
      attributes["autoscaling"] = tf.map({
        enabled: tf.bool(true),
        min: tf.num(min),
        max: tf.num(max),
        criteria: tf.map({
          cpu: tf.map({ enabled: tf.bool(cpu !== undefined), percentage: tf.num(cpu ?? 70) }),
          memory: tf.map({ enabled: tf.bool(mem !== undefined), percentage: tf.num(mem ?? 70) }),
        }),
      });
    }
  } else {
    const n = fieldNumber(r, "numInstances");
    if (n !== undefined) attributes["num_instances"] = tf.num(n);
  }
  return {
    resource: {
      type: tfType,
      name,
      attributes,
      importId: r.externalId,
      comments: [
        "Environment variables, secret files, disks and custom domains are not reconstructed;",
        "add env_vars, disk and custom_domains after import or Terraform will remove them.",
      ],
    },
  };
}

export const renderTerraformExport: TerraformExportCapability = {
  provider: { name: "render", source: "render-oss/render", version: "~> 1.9" },
  providerConfig: {
    api_key: tf.ref("var.render_api_key"),
    owner_id: tf.ref("var.render_owner_id"),
  },
  variables: [
    {
      name: "render_api_key",
      description: "Render API key (Account Settings, API Keys)",
      sensitive: true,
    },
    {
      name: "render_owner_id",
      description: "Render workspace id (usr-… or tea-…)",
    },
  ],
  supportedResourceTypeIds: ["service", "postgres", "key-value", "env-group"],
  mapResource(resource): TerraformExportResult | null {
    const name = fieldString(resource, "name") || resource.displayName;
    switch (resource.resourceTypeId) {
      case "service":
        return mapService(resource);
      case "postgres": {
        const plan = fieldString(resource, "plan");
        const region = fieldString(resource, "region");
        const version = fieldString(resource, "version");
        if (!plan || !region || !version || fieldString(resource, "role") === "replica") {
          return null;
        }
        const attributes: Record<string, TerraformValue> = {
          name: tf.str(name),
          plan: tf.str(plan),
          region: tf.str(region),
          version: tf.str(version),
        };
        const db = fieldString(resource, "databaseName");
        if (db) attributes["database_name"] = tf.str(db);
        const user = fieldString(resource, "databaseUser");
        if (user) attributes["database_user"] = tf.str(user);
        const disk = fieldNumber(resource, "diskSizeGB");
        if (disk !== undefined) attributes["disk_size_gb"] = tf.num(disk);
        if (fieldBool(resource, "highAvailabilityEnabled")) {
          attributes["high_availability_enabled"] = tf.bool(true);
        }
        const env = fieldString(resource, "environmentId");
        if (env) attributes["environment_id"] = tf.str(env);
        const cidrs = fieldString(resource, "allowedCidrs");
        if (cidrs) {
          attributes["ip_allow_list"] = tf.list(
            cidrs
              .split(",")
              .map((c) => c.trim())
              .filter(Boolean)
              .map((c) => tf.map({ cidr_block: tf.str(c), description: tf.str("") })),
          );
        }
        return {
          resource: { type: "render_postgres", name, attributes, importId: resource.externalId },
        };
      }
      case "key-value": {
        const region = fieldString(resource, "region");
        const policy = fieldString(resource, "maxmemoryPolicy");
        if (!region || !policy) return null;
        const attributes: Record<string, TerraformValue> = {
          name: tf.str(name),
          region: tf.str(region),
          max_memory_policy: tf.str(policy),
        };
        const plan = fieldString(resource, "plan");
        if (plan) attributes["plan"] = tf.str(plan);
        const persistence = fieldString(resource, "persistenceMode");
        if (persistence) attributes["persistence_mode"] = tf.str(persistence);
        const env = fieldString(resource, "environmentId");
        if (env) attributes["environment_id"] = tf.str(env);
        return {
          resource: { type: "render_keyvalue", name, attributes, importId: resource.externalId },
        };
      }
      case "env-group": {
        const attributes: Record<string, TerraformValue> = { name: tf.str(name) };
        const env = fieldString(resource, "environmentId");
        if (env) attributes["environment_id"] = tf.str(env);
        return {
          resource: {
            type: "render_env_group",
            name,
            attributes,
            importId: resource.externalId,
            comments: [
              "Variable values are not synced into Infrawrench; add env_vars and secret_files",
              "before applying, or Terraform will remove the group's variables.",
            ],
          },
        };
      }
      default:
        return null;
    }
  },
};
