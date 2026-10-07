import type {
  TerraformExportCapability,
  TerraformExportResult,
  TerraformValue,
} from "@infrawrench/plugin-base";
import { fieldNumber, fieldString, tf } from "@infrawrench/plugin-base";
import { T } from "./resource-types.js";

/**
 * Terraform mapping for the official `aiven/aiven` provider (v4.63, import
 * syntax checked against each resource's registry page, 2026-10). The
 * provider reads `api_token`.
 *
 * Services map to the per-type resource (`aiven_pg`, `aiven_kafka`, …,
 * import `PROJECT/SERVICE_NAME`), with plan, cloud, maintenance window and
 * termination protection; `user_config` is not synced, so advanced settings
 * show up as a diff after import. Kafka connectors and schema subjects are
 * not exported: their config and schema bodies are not in inventory.
 */
const SERVICE_RESOURCE: Record<string, string> = {
  pg: "aiven_pg",
  mysql: "aiven_mysql",
  kafka: "aiven_kafka",
  kafka_connect: "aiven_kafka_connect",
  kafka_mirrormaker: "aiven_kafka_mirrormaker",
  opensearch: "aiven_opensearch",
  clickhouse: "aiven_clickhouse",
  valkey: "aiven_valkey",
  grafana: "aiven_grafana",
  flink: "aiven_flink",
  dragonfly: "aiven_dragonfly",
  thanos: "aiven_thanos",
};

const USER_RESOURCE: Record<string, string> = {
  pg: "aiven_pg_user",
  mysql: "aiven_mysql_user",
  kafka: "aiven_kafka_user",
  valkey: "aiven_valkey_user",
  opensearch: "aiven_opensearch_user",
};

const DATABASE_RESOURCE: Record<string, string> = {
  pg: "aiven_pg_database",
  mysql: "aiven_mysql_database",
};

function base(project: string, service: string): Record<string, TerraformValue> {
  return { project: tf.str(project), service_name: tf.str(service) };
}

export const aivenTerraformExport: TerraformExportCapability = {
  provider: { name: "aiven", source: "aiven/aiven", version: "~> 4.0" },
  providerConfig: { api_token: tf.ref("var.aiven_api_token") },
  variables: [{ name: "aiven_api_token", description: "Aiven API token", sensitive: true }],
  supportedResourceTypeIds: [
    T.project,
    T.service,
    T.user,
    T.database,
    T.pool,
    T.topic,
    T.acl,
    T.integration,
    T.vpc,
  ],
  mapResource(resource): TerraformExportResult | null {
    const project = fieldString(resource, "project");
    const service = fieldString(resource, "serviceName");
    const ext = resource.externalId ?? "";
    switch (resource.resourceTypeId) {
      case T.project: {
        const attrs: Record<string, TerraformValue> = {
          project: tf.str(fieldString(resource, "name")),
        };
        if (fieldString(resource, "billingGroupId"))
          attrs["billing_group"] = tf.str(fieldString(resource, "billingGroupId"));
        if (fieldString(resource, "organizationId"))
          attrs["parent_id"] = tf.str(fieldString(resource, "organizationId"));
        return { resource: { type: "aiven_project", name: ext, attributes: attrs, importId: ext } };
      }
      case T.service: {
        const type = SERVICE_RESOURCE[fieldString(resource, "serviceType")];
        if (!type || !project) return null;
        const attrs: Record<string, TerraformValue> = {
          ...base(project, fieldString(resource, "name")),
          plan: tf.str(fieldString(resource, "plan")),
          cloud_name: tf.str(fieldString(resource, "cloud")),
        };
        if (fieldString(resource, "maintenanceDow")) {
          attrs["maintenance_window_dow"] = tf.str(fieldString(resource, "maintenanceDow"));
          attrs["maintenance_window_time"] = tf.str(fieldString(resource, "maintenanceTime"));
        }
        if (resource.fields["terminationProtection"] === true)
          attrs["termination_protection"] = tf.bool(true);
        if (fieldString(resource, "projectVpcId")) {
          attrs["project_vpc_id"] = tf.str(`${project}/${fieldString(resource, "projectVpcId")}`);
        }
        return {
          resource: {
            type,
            name: fieldString(resource, "name"),
            attributes: attrs,
            importId: ext,
            comments: [
              "user_config (advanced settings) is not exported; copy it from `terraform plan` after import.",
            ],
          },
        };
      }
      case T.user: {
        const type = USER_RESOURCE[fieldString(resource, "serviceType")];
        if (!type) return null;
        return {
          resource: {
            type,
            name: `${service}_${fieldString(resource, "username")}`,
            attributes: {
              ...base(project, service),
              username: tf.str(fieldString(resource, "username")),
            },
            importId: ext,
          },
        };
      }
      case T.database: {
        const type = DATABASE_RESOURCE[fieldString(resource, "serviceType")];
        if (!type) return null;
        return {
          resource: {
            type,
            name: `${service}_${fieldString(resource, "name")}`,
            attributes: {
              ...base(project, service),
              database_name: tf.str(fieldString(resource, "name")),
            },
            importId: ext,
          },
        };
      }
      case T.pool: {
        const attrs: Record<string, TerraformValue> = {
          ...base(project, service),
          pool_name: tf.str(fieldString(resource, "name")),
          database_name: tf.str(fieldString(resource, "database")),
        };
        if (fieldString(resource, "username"))
          attrs["username"] = tf.str(fieldString(resource, "username"));
        if (fieldString(resource, "poolMode"))
          attrs["pool_mode"] = tf.str(fieldString(resource, "poolMode"));
        const size = fieldNumber(resource, "poolSize");
        if (size !== undefined) attrs["pool_size"] = tf.num(size);
        return {
          resource: {
            type: "aiven_connection_pool",
            name: `${service}_${fieldString(resource, "name")}`,
            attributes: attrs,
            importId: ext,
          },
        };
      }
      case T.topic: {
        const partitions = fieldNumber(resource, "partitions");
        const replication = fieldNumber(resource, "replication");
        if (partitions === undefined || replication === undefined) return null;
        return {
          resource: {
            type: "aiven_kafka_topic",
            name: `${service}_${fieldString(resource, "name")}`,
            attributes: {
              ...base(project, service),
              topic_name: tf.str(fieldString(resource, "name")),
              partitions: tf.num(partitions),
              replication: tf.num(replication),
            },
            importId: ext,
          },
        };
      }
      case T.acl:
        return {
          resource: {
            type: "aiven_kafka_acl",
            name: `${service}_acl_${ext.split("/").pop() ?? ""}`,
            attributes: {
              ...base(project, service),
              topic: tf.str(fieldString(resource, "topic")),
              permission: tf.str(fieldString(resource, "permission")),
              username: tf.str(fieldString(resource, "username")),
            },
            importId: ext,
          },
        };
      case T.integration: {
        const attrs: Record<string, TerraformValue> = {
          project: tf.str(project),
          integration_type: tf.str(fieldString(resource, "integrationType")),
        };
        if (fieldString(resource, "source"))
          attrs["source_service_name"] = tf.str(fieldString(resource, "source"));
        if (fieldString(resource, "destination"))
          attrs["destination_service_name"] = tf.str(fieldString(resource, "destination"));
        return {
          resource: {
            type: "aiven_service_integration",
            name: `integration_${ext.split("/").pop() ?? ""}`,
            attributes: attrs,
            importId: ext,
          },
        };
      }
      case T.vpc:
        return {
          resource: {
            type: "aiven_project_vpc",
            name: `${project}_${fieldString(resource, "cloud")}`,
            attributes: {
              project: tf.str(project),
              cloud_name: tf.str(fieldString(resource, "cloud")),
              network_cidr: tf.str(fieldString(resource, "networkCidr")),
            },
            importId: ext,
          },
        };
      default:
        return null;
    }
  },
};
