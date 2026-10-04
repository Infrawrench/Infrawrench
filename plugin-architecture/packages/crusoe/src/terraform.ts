import type {
  ResourceInstance,
  TerraformExportCapability,
  TerraformExportResult,
  TerraformValue,
} from "@infrawrench/plugin-base";
import { fieldNumber, fieldString, tf } from "@infrawrench/plugin-base";
import { externalOf, parseFirewallTargets, splitList } from "./mappers.js";

/**
 * Terraform mapping for Crusoe Cloud: provider `crusoecloud/crusoe`.
 * Attribute names verified against the provider's generated docs
 * (`crusoecloud/terraform-provider-crusoe`, `docs/resources/*.md`, v1.5.0,
 * 2026-10). The provider block takes no credentials: it reads
 * `CRUSOE_ACCESS_KEY_ID` / `CRUSOE_SECRET_KEY` (or `~/.crusoe/config`) from
 * the environment, so nothing secret is ever written here. Imports use the
 * provider's `<id>,<project_id>` form so they land in the right project.
 */

function scoped(resource: ResourceInstance): { projectId: string; id: string } | null {
  const ext = resource.externalId ?? externalOf(resource.id);
  const slash = ext.indexOf("/");
  if (slash <= 0) return null;
  return { projectId: ext.slice(0, slash), id: ext.slice(slash + 1) };
}

function block(
  resource: ResourceInstance,
  type: string,
  attributes: Record<string, TerraformValue>,
  comments?: string[],
): TerraformExportResult | null {
  const ids = scoped(resource);
  if (!ids) return null;
  return {
    resource: {
      type,
      name: fieldString(resource, "name") || resource.displayName,
      attributes: { ...attributes, project_id: tf.str(ids.projectId) },
      importId: `${ids.id},${ids.projectId}`,
      ...(comments?.length ? { comments } : {}),
    },
  };
}

function withSshKeyVariable(result: TerraformExportResult | null): TerraformExportResult | null {
  if (!result) return null;
  return {
    ...result,
    variables: [
      {
        name: "crusoe_ssh_public_key",
        description: "SSH public key Crusoe grants access to on new VMs",
      },
    ],
  };
}

function targets(value: string): TerraformValue {
  return tf.list(
    parseFirewallTargets(value).map((t) =>
      tf.map(t.cidr ? { cidr: tf.str(t.cidr) } : { resource_id: tf.str(t.resource_id ?? "") }),
    ),
  );
}

export const crusoeTerraformExport: TerraformExportCapability = {
  provider: { name: "crusoe", source: "crusoecloud/crusoe", version: "~> 1.5" },
  providerConfig: {},
  variables: [],
  supportedResourceTypeIds: [
    "project",
    "vm",
    "disk",
    "vpc-network",
    "vpc-subnet",
    "firewall-rule",
    "kubernetes-cluster",
    "node-pool",
  ],
  mapResource(resource): TerraformExportResult | null {
    const name = fieldString(resource, "name") || resource.displayName;
    switch (resource.resourceTypeId) {
      case "project":
        return {
          resource: {
            type: "crusoe_project",
            name,
            attributes: { name: tf.str(name) },
            importId: resource.externalId ?? externalOf(resource.id),
          },
        };
      case "vm": {
        const type = fieldString(resource, "type");
        if (!type) return null;
        const location = fieldString(resource, "location");
        return withSshKeyVariable(
          block(
            resource,
            "crusoe_compute_instance",
            {
              name: tf.str(name),
              type: tf.str(type),
              ...(location ? { location: tf.str(location) } : {}),
              ssh_key: tf.ref("var.crusoe_ssh_public_key"),
            },
            [
              "Crusoe does not report which image a VM was created from: set `image`",
              "(for example ubuntu22.04-nvidia-sxm-docker:latest) before applying.",
            ],
          ),
        );
      }
      case "disk": {
        const size = fieldNumber(resource, "sizeGib");
        const location = fieldString(resource, "location");
        if (!size || !location) return null;
        const type = fieldString(resource, "type");
        return block(resource, "crusoe_storage_disk", {
          name: tf.str(name),
          size: tf.str(`${size}GiB`),
          location: tf.str(location),
          ...(type ? { type: tf.str(type) } : {}),
        });
      }
      case "vpc-network": {
        const cidr = fieldString(resource, "cidr");
        if (!cidr) return null;
        return block(resource, "crusoe_vpc_network", { name: tf.str(name), cidr: tf.str(cidr) });
      }
      case "vpc-subnet": {
        const cidr = fieldString(resource, "cidr");
        const location = fieldString(resource, "location");
        const network = fieldString(resource, "networkId");
        if (!cidr || !location || !network) return null;
        return block(resource, "crusoe_vpc_subnet", {
          name: tf.str(name),
          cidr: tf.str(cidr),
          location: tf.str(location),
          network: tf.str(network),
          ...(resource.fields["natGateway"] === true ? { nat_gateway_enabled: tf.bool(true) } : {}),
        });
      }
      case "firewall-rule": {
        const network = fieldString(resource, "networkId");
        const direction = fieldString(resource, "direction");
        const action = fieldString(resource, "action");
        if (!network || !direction || !action) return null;
        return block(resource, "crusoe_vpc_firewall_rule", {
          name: tf.str(name),
          network: tf.str(network),
          direction: tf.str(direction),
          action: tf.str(action),
          protocols: tf.str(splitList(fieldString(resource, "protocols")).join(",")),
          source_ports: tf.str(splitList(fieldString(resource, "sourcePorts")).join(",")),
          destination_ports: tf.str(splitList(fieldString(resource, "destinationPorts")).join(",")),
          sources: targets(fieldString(resource, "sources")),
          destinations: targets(fieldString(resource, "destinations")),
        });
      }
      case "kubernetes-cluster": {
        const version = fieldString(resource, "version");
        const location = fieldString(resource, "location");
        if (!version || !location) return null;
        const subnet = fieldString(resource, "subnetId");
        return block(resource, "crusoe_kubernetes_cluster", {
          name: tf.str(name),
          version: tf.str(version),
          location: tf.str(location),
          ...(subnet ? { subnet_id: tf.str(subnet) } : {}),
          ...(resource.fields["private"] === true ? { private: tf.bool(true) } : {}),
        });
      }
      case "node-pool": {
        const cluster = fieldString(resource, "clusterId");
        const type = fieldString(resource, "type");
        if (!cluster || !type) return null;
        return withSshKeyVariable(
          block(resource, "crusoe_kubernetes_node_pool", {
            name: tf.str(name),
            cluster_id: tf.str(cluster),
            type: tf.str(type),
            instance_count: tf.num(fieldNumber(resource, "count") ?? 0),
            ssh_key: tf.ref("var.crusoe_ssh_public_key"),
          }),
        );
      }
      default:
        return null;
    }
  },
};
