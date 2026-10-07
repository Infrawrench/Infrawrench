import type {
  TerraformExportCapability,
  TerraformExportResult,
  TerraformValue,
} from "@infrawrench/plugin-base";
import { fieldNumber, fieldString, tf } from "@infrawrench/plugin-base";
import { parseTags } from "./mappers.js";

/**
 * Terraform mapping for Honeycomb: provider `honeycombio/honeycombio`.
 *
 * Attribute names verified against the provider's own docs
 * (honeycombio/terraform-provider-honeycombio `docs/resources/*.md`, release
 * v0.55.1, 2026-10). The provider takes `api_key` (a configuration key, which
 * is per environment), `api_key_id` / `api_key_secret` (a management key, for
 * `honeycombio_environment`) and `api_url`. Environment-scoped blocks only
 * apply against the environment whose configuration key the provider holds,
 * so a bundle spanning environments needs one provider alias per environment.
 *
 * Mapped: environments, datasets, columns, derived columns, SLOs, marker
 * settings and email/Slack/PagerDuty/webhook recipients. Triggers, burn
 * alerts and boards are left out: their blocks need the full query JSON,
 * recipient blocks and panel layouts, which the inventory does not store.
 * API keys cannot be imported (the provider says so) and markers are events,
 * not configuration.
 */

function slugOf(path: string, index: number): string {
  return path.split("/")[index] ?? "";
}

function optionalString(attrs: Record<string, TerraformValue>, key: string, value: string) {
  if (value) attrs[key] = tf.str(value);
}

const ENV_COMMENT = "Applies to the environment whose configuration key the provider holds.";

export const honeycombTerraformExport: TerraformExportCapability = {
  provider: { name: "honeycombio", source: "honeycombio/honeycombio", version: "~> 0.55" },
  providerConfig: {
    api_key: tf.ref("var.honeycomb_api_key"),
    api_key_id: tf.ref("var.honeycomb_key_id"),
    api_key_secret: tf.ref("var.honeycomb_key_secret"),
    api_url: tf.ref("var.honeycomb_api_url"),
  },
  variables: [
    {
      name: "honeycomb_api_key",
      description: "Honeycomb configuration key for the environment being managed",
      sensitive: true,
    },
    { name: "honeycomb_key_id", description: "Honeycomb management key ID" },
    {
      name: "honeycomb_key_secret",
      description: "Honeycomb management key secret",
      sensitive: true,
    },
    {
      name: "honeycomb_api_url",
      description: "https://api.honeycomb.io (US) or https://api.eu1.honeycomb.io (EU)",
    },
  ],
  supportedResourceTypeIds: [
    "environment",
    "dataset",
    "column",
    "derived-column",
    "slo",
    "marker-setting",
    "recipient",
  ],
  mapResource(resource): TerraformExportResult | null {
    const ext = resource.externalId ?? "";
    switch (resource.resourceTypeId) {
      case "environment": {
        const name = fieldString(resource, "name") || resource.displayName;
        if (!name) return null;
        const attributes: Record<string, TerraformValue> = { name: tf.str(name) };
        optionalString(attributes, "description", fieldString(resource, "description"));
        optionalString(attributes, "color", fieldString(resource, "color"));
        const id = fieldString(resource, "environmentId");
        return {
          resource: {
            type: "honeycombio_environment",
            name,
            attributes,
            ...(id ? { importId: id } : {}),
            comments: ["Managed with the management key (api_key_id / api_key_secret)."],
          },
        };
      }
      case "dataset": {
        const name = fieldString(resource, "name") || resource.displayName;
        if (!name) return null;
        const attributes: Record<string, TerraformValue> = { name: tf.str(name) };
        optionalString(attributes, "description", fieldString(resource, "description"));
        const depth = fieldNumber(resource, "expandJsonDepth");
        if (depth !== undefined) attributes["expand_json_depth"] = tf.num(depth);
        if (resource.fields["deleteProtected"] === false) {
          attributes["delete_protected"] = tf.bool(false);
        }
        return {
          resource: {
            type: "honeycombio_dataset",
            name,
            attributes,
            importId: slugOf(ext, 1),
            comments: [ENV_COMMENT],
          },
        };
      }
      case "column": {
        const keyName = fieldString(resource, "keyName");
        const dataset = fieldString(resource, "dataset");
        if (!keyName || !dataset) return null;
        const attributes: Record<string, TerraformValue> = {
          name: tf.str(keyName),
          dataset: tf.str(dataset),
        };
        optionalString(attributes, "type", fieldString(resource, "type"));
        optionalString(attributes, "description", fieldString(resource, "description"));
        if (resource.fields["hidden"] === true) attributes["hidden"] = tf.bool(true);
        return {
          resource: {
            type: "honeycombio_column",
            name: `${dataset}_${keyName}`,
            attributes,
            importId: `${dataset}/${keyName}`,
            comments: [ENV_COMMENT],
          },
        };
      }
      case "derived-column": {
        const alias = fieldString(resource, "alias");
        const expression = fieldString(resource, "expression");
        if (!alias || !expression) return null;
        const dataset = fieldString(resource, "dataset");
        const attributes: Record<string, TerraformValue> = {
          alias: tf.str(alias),
          expression: tf.str(expression),
        };
        if (dataset) attributes["dataset"] = tf.str(dataset);
        optionalString(attributes, "description", fieldString(resource, "description"));
        return {
          resource: {
            type: "honeycombio_derived_column",
            name: alias,
            attributes,
            importId: dataset ? `${dataset}/${alias}` : alias,
            comments: [dataset ? ENV_COMMENT : `Environment-wide (no dataset). ${ENV_COMMENT}`],
          },
        };
      }
      case "slo": {
        const name = fieldString(resource, "name") || resource.displayName;
        const sli = fieldString(resource, "sli");
        const target = fieldNumber(resource, "targetPercent");
        const period = fieldNumber(resource, "timePeriodDays");
        if (!name || !sli || target === undefined || period === undefined) return null;
        const attributes: Record<string, TerraformValue> = {
          name: tf.str(name),
          sli: tf.str(sli),
          target_percentage: tf.num(target),
          time_period: tf.num(period),
        };
        const datasets = fieldString(resource, "datasets")
          .split(",")
          .map((d) => d.trim())
          .filter(Boolean);
        if (datasets.length > 0) attributes["datasets"] = tf.list(datasets.map((d) => tf.str(d)));
        optionalString(attributes, "description", fieldString(resource, "description"));
        const tags = parseTags(fieldString(resource, "tags"));
        if (tags.length > 0) {
          attributes["tags"] = tf.map(
            Object.fromEntries(tags.map((t) => [t.key ?? "", tf.str(t.value ?? "")])),
          );
        }
        const dataset = fieldString(resource, "dataset");
        const id = ext.split("/").pop() ?? "";
        return {
          resource: {
            type: "honeycombio_slo",
            name,
            attributes,
            importId: dataset ? `${dataset}/${id}` : id,
            comments: [ENV_COMMENT],
          },
        };
      }
      case "marker-setting": {
        const type = fieldString(resource, "type");
        const color = fieldString(resource, "color");
        if (!type || !color) return null;
        const dataset = fieldString(resource, "dataset");
        const attributes: Record<string, TerraformValue> = {
          type: tf.str(type),
          color: tf.str(color),
        };
        if (dataset) attributes["dataset"] = tf.str(dataset);
        return {
          resource: {
            type: "honeycombio_marker_setting",
            name: `${dataset || "all"}_${type}`,
            attributes,
            comments: [ENV_COMMENT],
          },
        };
      }
      case "recipient": {
        const type = fieldString(resource, "type");
        const target = fieldString(resource, "target");
        if (!target) return null;
        const importId = ext;
        if (type === "email") {
          return {
            resource: {
              type: "honeycombio_email_recipient",
              name: target,
              attributes: { address: tf.str(target) },
              importId,
            },
          };
        }
        if (type === "slack") {
          return {
            resource: {
              type: "honeycombio_slack_recipient",
              name: target,
              attributes: { channel: tf.str(target) },
              importId,
            },
          };
        }
        if (type === "webhook") {
          const url = fieldString(resource, "url");
          if (!url) return null;
          return {
            resource: {
              type: "honeycombio_webhook_recipient",
              name: target,
              attributes: { name: tf.str(target), url: tf.str(url) },
              importId,
              comments: ["The webhook secret, headers and templates are not carried over."],
            },
          };
        }
        if (type === "pagerduty") {
          const variable = `honeycomb_pagerduty_key_${target.replace(/[^A-Za-z0-9_]/g, "_").toLowerCase()}`;
          return {
            resource: {
              type: "honeycombio_pagerduty_recipient",
              name: target,
              attributes: {
                integration_name: tf.str(target),
                integration_key: tf.ref(`var.${variable}`),
              },
              importId,
            },
            variables: [
              {
                name: variable,
                description: `PagerDuty integration key for ${target}`,
                sensitive: true,
              },
            ],
          };
        }
        return null;
      }
      default:
        return null;
    }
  },
};
