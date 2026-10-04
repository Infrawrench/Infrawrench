import type {
  TerraformExportCapability,
  TerraformExportResult,
  TerraformValue,
} from "@infrawrench/plugin-base";
import { fieldString, tf } from "@infrawrench/plugin-base";
import { parseRuleSpec } from "./mappers.js";
import { T } from "./resource-types.js";

function slug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/**
 * Terraform mapping for Redis Cloud: provider `RedisLabs/rediscloud`.
 *
 * Attribute names verified against the provider's own docs
 * (RedisLabs/terraform-provider-rediscloud `docs/resources/*.md`, release
 * v2.19.1, 2026-10). The provider reads `api_key` (account key) and
 * `secret_key` (user key).
 *
 * Mapped: ACL rules (`name`, `rule`), ACL roles (`rule { name, database {
 * subscription, database } }`), ACL users (`name`, `role`, password as a
 * variable), Essentials subscriptions (`name`, `plan_id`,
 * `payment_method_id`) and Pro databases (`rediscloud_subscription_database`,
 * imported as `{subscription}/{database}`). Pro subscriptions are not: the
 * resource needs a `creation_plan` block describing the original sizing,
 * which inventory does not record. Essentials databases, peerings and
 * private connectivity are left for a later pass.
 */
export const redisCloudTerraformExport: TerraformExportCapability = {
  provider: { name: "rediscloud", source: "RedisLabs/rediscloud", version: "~> 2.0" },
  providerConfig: {
    api_key: tf.ref("var.rediscloud_api_key"),
    secret_key: tf.ref("var.rediscloud_secret_key"),
  },
  variables: [
    { name: "rediscloud_api_key", description: "Redis Cloud account key", sensitive: true },
    { name: "rediscloud_secret_key", description: "Redis Cloud user key", sensitive: true },
  ],
  supportedResourceTypeIds: [T.aclRule, T.aclRole, T.aclUser, T.subscription, T.database],
  mapResource(resource): TerraformExportResult | null {
    const name = fieldString(resource, "name") || resource.displayName;
    switch (resource.resourceTypeId) {
      case T.aclRule: {
        if (resource.fields["isDefault"] === true) return null;
        const rule = fieldString(resource, "rule");
        if (!rule) return null;
        return {
          resource: {
            type: "rediscloud_acl_rule",
            name,
            attributes: { name: tf.str(name), rule: tf.str(rule) },
            importId: resource.externalId,
          },
        };
      }
      case T.aclRole: {
        const spec = parseRuleSpec(resource.fields["ruleSpec"]);
        if (spec.length === 0) return null;
        const rules: TerraformValue[] = spec.map((r) =>
          tf.block({
            name: tf.str(r.ruleName),
            database: tf.list(
              r.databases.map((key) => {
                const [sub, db] = key.split("/");
                return tf.block({ subscription: tf.str(sub ?? ""), database: tf.num(Number(db)) });
              }),
            ),
          }),
        );
        return {
          resource: {
            type: "rediscloud_acl_role",
            name,
            attributes: { name: tf.str(name), rule: tf.list(rules) },
            importId: resource.externalId,
          },
        };
      }
      case T.aclUser: {
        const role = fieldString(resource, "role");
        if (!role) return null;
        const variable = `rediscloud_acl_user_${slug(name)}_password`;
        return {
          resource: {
            type: "rediscloud_acl_user",
            name,
            attributes: {
              name: tf.str(name),
              role: tf.str(role),
              password: tf.ref(`var.${variable}`),
            },
            importId: resource.externalId,
          },
          variables: [
            { name: variable, description: `Password for ACL user ${name}`, sensitive: true },
          ],
        };
      }
      case T.subscription: {
        if (fieldString(resource, "plan") !== "Essentials") return null;
        const planId = fieldString(resource, "planId");
        if (!planId) return null;
        const attributes: Record<string, TerraformValue> = {
          name: tf.str(name),
          plan_id: tf.num(Number(planId)),
        };
        const pm = fieldString(resource, "paymentMethodId");
        if (pm) attributes["payment_method_id"] = tf.str(pm);
        return {
          resource: {
            type: "rediscloud_essentials_subscription",
            name,
            attributes,
            importId: resource.externalId?.replace(/^ess-/, ""),
          },
        };
      }
      case T.database: {
        if (fieldString(resource, "plan") !== "Pro") return null;
        const subscriptionId = fieldString(resource, "subscriptionId");
        const dataset = Number(resource.fields["datasetSizeGb"]);
        const ops = Number(resource.fields["throughputOpsPerSec"]);
        if (!subscriptionId || !Number.isFinite(dataset) || !Number.isFinite(ops)) return null;
        const attributes: Record<string, TerraformValue> = {
          subscription_id: tf.str(subscriptionId),
          name: tf.str(name),
          dataset_size_in_gb: tf.num(dataset),
          throughput_measurement_by: tf.str("operations-per-second"),
          throughput_measurement_value: tf.num(ops),
        };
        const persistence = fieldString(resource, "dataPersistence");
        if (persistence) attributes["data_persistence"] = tf.str(persistence);
        const eviction = fieldString(resource, "dataEvictionPolicy");
        if (eviction) attributes["data_eviction"] = tf.str(eviction);
        if (typeof resource.fields["replication"] === "boolean") {
          attributes["replication"] = tf.bool(resource.fields["replication"]);
        }
        if (typeof resource.fields["enableTls"] === "boolean") {
          attributes["enable_tls"] = tf.bool(resource.fields["enableTls"]);
        }
        const ips = fieldString(resource, "sourceIps")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        if (ips.length) attributes["source_ips"] = tf.list(ips.map((ip) => tf.str(ip)));
        return {
          resource: {
            type: "rediscloud_subscription_database",
            name,
            attributes,
            importId: `${subscriptionId}/${resource.externalId ?? ""}`,
            comments: [
              "Modules, alerts and backup settings are not carried over.",
              "Import first and review `terraform plan` before applying.",
            ],
          },
        };
      }
      default:
        return null;
    }
  },
};
