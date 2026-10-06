import type {
  TerraformExportCapability,
  TerraformExportResult,
  TerraformValue,
} from "@infrawrench/plugin-base";
import { fieldNumber, fieldString, tf } from "@infrawrench/plugin-base";

/**
 * Terraform mapping for the official `heroku/heroku` provider (v5.4,
 * docs in github.com/heroku/terraform-provider-heroku/docs, verified 2026-10).
 *
 *   - heroku_app: `name`, `region` required; `stack`, `organization { name }`.
 *     Import by name or id.
 *   - heroku_formation: `app_id`, `type`, `quantity`, `size`. Import `app:type`.
 *   - heroku_addon: `app_id`, `plan` (`service:plan`). Import by add-on id.
 *   - heroku_domain: `app_id`, `hostname` (+ `sni_endpoint_id`). Import `app:hostname`.
 *   - heroku_pipeline: `name`, `owner { id, type }`. Import by id.
 *   - heroku_pipeline_coupling: `app_id`, `pipeline`, `stage`. Import by id.
 *   - heroku_space: `name`, `organization`, `region`, `shield`. Import by name.
 *   - heroku_drain: `app_id`, `url`. Import `app:drain-id`.
 *
 * Config vars are left out (values are never synced) and so are SSL
 * certificates (the private key is not readable). `app_id` takes the app's
 * UUID, as the provider asks.
 */
export const herokuTerraformExport: TerraformExportCapability = {
  provider: { name: "heroku", source: "heroku/heroku", version: "~> 5.4" },
  providerConfig: { api_key: tf.ref("var.heroku_api_key") },
  variables: [
    {
      name: "heroku_api_key",
      description: "Heroku API key (Account settings, API Key, or heroku authorizations:create)",
      sensitive: true,
    },
  ],
  supportedResourceTypeIds: [
    "app",
    "formation",
    "add-on",
    "domain",
    "pipeline",
    "pipeline-coupling",
    "space",
    "log-drain",
  ],
  mapResource(r): TerraformExportResult | null {
    const appId = fieldString(r, "appId");
    const appName = fieldString(r, "appName");
    switch (r.resourceTypeId) {
      case "app": {
        const name = fieldString(r, "name") || r.displayName;
        const region = fieldString(r, "region");
        if (!name || !region) return null;
        const attributes: Record<string, TerraformValue> = {
          name: tf.str(name),
          region: tf.str(region),
        };
        const stack = fieldString(r, "buildStack") || fieldString(r, "stack");
        if (stack) attributes["stack"] = tf.str(stack);
        const team = fieldString(r, "team");
        if (team) {
          const org: Record<string, TerraformValue> = { name: tf.str(team) };
          const space = fieldString(r, "space");
          if (space) org["space"] = tf.str(space);
          attributes["organization"] = tf.block(org);
        }
        return {
          resource: {
            type: "heroku_app",
            name,
            attributes,
            importId: name,
            comments: [
              "Config vars are not exported; add config_vars or heroku_config before applying.",
            ],
          },
        };
      }
      case "formation": {
        const type = fieldString(r, "type");
        const quantity = fieldNumber(r, "quantity");
        const size = fieldString(r, "size");
        if (!appId || !type || quantity === undefined || !size) return null;
        return {
          resource: {
            type: "heroku_formation",
            name: `${appName} ${type}`,
            attributes: {
              app_id: tf.str(appId),
              type: tf.str(type),
              quantity: tf.num(quantity),
              size: tf.str(size),
            },
            importId: `${appName || appId}:${type}`,
          },
        };
      }
      case "add-on": {
        const service = fieldString(r, "service");
        const plan = fieldString(r, "plan");
        if (!appId || !service || !plan) return null;
        const planId = plan.includes(":") ? plan : `${service}:${plan}`;
        return {
          resource: {
            type: "heroku_addon",
            name: fieldString(r, "name") || r.displayName,
            attributes: { app_id: tf.str(appId), plan: tf.str(planId) },
            importId: r.externalId,
          },
        };
      }
      case "domain": {
        const hostname = fieldString(r, "hostname");
        if (!appId || !hostname || fieldString(r, "kind") === "heroku") return null;
        const attributes: Record<string, TerraformValue> = {
          app_id: tf.str(appId),
          hostname: tf.str(hostname),
        };
        const sni = fieldString(r, "sniEndpointId");
        if (sni) attributes["sni_endpoint_id"] = tf.str(sni);
        return {
          resource: {
            type: "heroku_domain",
            name: hostname,
            attributes,
            importId: `${appName || appId}:${hostname}`,
          },
        };
      }
      case "pipeline": {
        const ownerId = fieldString(r, "ownerId");
        const ownerType = fieldString(r, "ownerType");
        const name = fieldString(r, "name") || r.displayName;
        if (!ownerId || !ownerType) return null;
        return {
          resource: {
            type: "heroku_pipeline",
            name,
            attributes: {
              name: tf.str(name),
              owner: tf.block({ id: tf.str(ownerId), type: tf.str(ownerType) }),
            },
            importId: r.externalId,
          },
        };
      }
      case "pipeline-coupling": {
        const pipeline = fieldString(r, "pipelineId");
        const stage = fieldString(r, "stage");
        if (!appId || !pipeline || !stage) return null;
        return {
          resource: {
            type: "heroku_pipeline_coupling",
            name: `${appName} ${stage}`,
            attributes: { app_id: tf.str(appId), pipeline: tf.str(pipeline), stage: tf.str(stage) },
            importId: r.externalId,
          },
        };
      }
      case "space": {
        const name = fieldString(r, "name") || r.displayName;
        const team = fieldString(r, "team");
        const region = fieldString(r, "region");
        if (!team || !region) return null;
        const attributes: Record<string, TerraformValue> = {
          name: tf.str(name),
          organization: tf.str(team),
          region: tf.str(region),
        };
        if (r.fields["shield"] === true) attributes["shield"] = tf.bool(true);
        return { resource: { type: "heroku_space", name, attributes, importId: name } };
      }
      case "log-drain": {
        const url = fieldString(r, "url");
        // Drain URLs with embedded credentials stay out of the HCL.
        if (!appId || !url || fieldString(r, "addon") || /\/\/[^/]*@/.test(url)) return null;
        const drainId = (r.externalId ?? "").split("/").pop() ?? "";
        return {
          resource: {
            type: "heroku_drain",
            name: `${appName} drain`,
            attributes: { app_id: tf.str(appId), url: tf.str(url) },
            importId: `${appName || appId}:${drainId}`,
          },
        };
      }
      default:
        return null;
    }
  },
};
