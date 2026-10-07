import type {
  TerraformExportCapability,
  TerraformExportResult,
  TerraformValue,
} from "@infrawrench/plugin-base";
import { fieldNumber, fieldString, tf } from "@infrawrench/plugin-base";
import { T } from "./resource-types.js";

/**
 * Terraform mapping for Tiger Cloud: provider `timescale/timescale` (v2.14,
 * docs/resources/*.md, verified 2026-10). The provider is configured with the
 * same client credential plus the project id.
 *
 * Mapped: services (`timescale_service`, imported by service id), VPCs
 * (`timescale_vpcs`, imported by name, which is what its ImportState reads)
 * and VPC peerings (`timescale_peering_connection`, imported as
 * `peering_id,vpc_id`). Read replica sets, exporters, IP allow lists and
 * backups are left out: the provider models read replicas as services with
 * `read_replica_source` and has no allow-list resource.
 */
export const timescaleTerraformExport: TerraformExportCapability = {
  provider: { name: "timescale", source: "timescale/timescale", version: "~> 2.14" },
  providerConfig: {
    access_key: tf.ref("var.timescale_access_key"),
    secret_key: tf.ref("var.timescale_secret_key"),
    project_id: tf.ref("var.timescale_project_id"),
  },
  variables: [
    { name: "timescale_access_key", description: "Tiger Cloud client credential public key" },
    {
      name: "timescale_secret_key",
      description: "Tiger Cloud client credential secret key",
      sensitive: true,
    },
    { name: "timescale_project_id", description: "Tiger Cloud project id" },
  ],
  supportedResourceTypeIds: [T.service, T.vpc, T.peering],
  mapResource(resource): TerraformExportResult | null {
    switch (resource.resourceTypeId) {
      case T.service: {
        const serviceId = fieldString(resource, "serviceId");
        if (!serviceId) return null;
        const attributes: Record<string, TerraformValue> = {
          name: tf.str(fieldString(resource, "name") || resource.displayName),
        };
        const region = fieldString(resource, "region");
        if (region) attributes["region_code"] = tf.str(region);
        const cpu = fieldNumber(resource, "cpuMillis");
        const mem = fieldNumber(resource, "memoryGb");
        if (cpu !== undefined) attributes["milli_cpu"] = tf.num(cpu);
        if (mem !== undefined) attributes["memory_gb"] = tf.num(mem);
        const ha = Number(fieldString(resource, "haReplicas"));
        if (Number.isFinite(ha)) attributes["ha_replicas"] = tf.num(ha);
        const sync = Number(fieldString(resource, "syncReplicas"));
        if (Number.isFinite(sync) && sync > 0) attributes["sync_replicas"] = tf.num(sync);
        const env = fieldString(resource, "environment");
        if (env) attributes["environment_tag"] = tf.str(env);
        if (typeof resource.fields["poolerEnabled"] === "boolean") {
          attributes["connection_pooler_enabled"] = tf.bool(resource.fields["poolerEnabled"]);
        }
        if (resource.fields["dataTiering"] === true) {
          attributes["data_tiering_enabled"] = tf.bool(true);
        }
        const vpc = fieldString(resource, "vpcId");
        if (vpc && /^\d+$/.test(vpc)) attributes["vpc_id"] = tf.num(Number(vpc));
        if (resource.fields["status"] === "PAUSED") attributes["paused"] = tf.bool(true);
        return {
          resource: {
            type: "timescale_service",
            name: resource.displayName,
            attributes,
            importId: serviceId,
            comments: [
              "The password is not exported; set password_wo from a variable if Terraform should own it.",
            ],
          },
        };
      }
      case T.vpc: {
        const name = fieldString(resource, "name");
        const cidr = fieldString(resource, "cidr");
        const region = fieldString(resource, "region");
        if (!name || !cidr || !region) return null;
        return {
          resource: {
            type: "timescale_vpcs",
            name,
            attributes: {
              name: tf.str(name),
              cidr: tf.str(cidr),
              region_code: tf.str(region),
            },
            importId: name,
          },
        };
      }
      case T.peering: {
        const vpcId = fieldString(resource, "vpcId");
        const account = fieldString(resource, "peerAccountId");
        const peerVpc = fieldString(resource, "peerVpcId");
        const region = fieldString(resource, "peerRegion");
        const peeringId = (resource.externalId ?? "").split("/")[2];
        if (!vpcId || !account || !peerVpc || !region || !peeringId) return null;
        return {
          resource: {
            type: "timescale_peering_connection",
            name: `${peerVpc}_${vpcId}`,
            attributes: {
              timescale_vpc_id: tf.num(Number(vpcId)),
              peer_account_id: tf.str(account),
              peer_region_code: tf.str(region),
              peer_vpc_id: tf.str(peerVpc),
            },
            importId: `${peeringId},${vpcId}`,
          },
        };
      }
      default:
        return null;
    }
  },
};
