import type {
  ResourceInstance,
  TerraformExportCapability,
  TerraformExportResult,
  TerraformValue,
} from "@infrawrench/plugin-base";
import { fieldNumber, fieldString, tf } from "@infrawrench/plugin-base";

/**
 * Terraform mapping for provider `UpCloudLtd/upcloud` (~> 5.0, docs checked
 * 2026-09). Import ids are the UUID (or the address for a floating IP; the
 * provider documents these in each resource's `import.sh` example). The
 * provider reads `UPCLOUD_TOKEN` or `UPCLOUD_USERNAME`/`UPCLOUD_PASSWORD`
 * from the environment, so nothing secret goes in the provider block.
 */

const labelMap = (r: ResourceInstance): TerraformValue | null => {
  const entries: Record<string, TerraformValue> = {};
  for (const pair of fieldString(r, "labels")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)) {
    const i = pair.indexOf("=");
    entries[i < 0 ? pair : pair.slice(0, i)] = tf.str(i < 0 ? "" : pair.slice(i + 1));
  }
  return Object.keys(entries).length ? tf.map(entries) : null;
};

function block(
  type: string,
  r: ResourceInstance,
  attributes: Record<string, TerraformValue>,
  comments?: string[],
  importId = r.externalId,
): TerraformExportResult {
  const labels = labelMap(r);
  if (labels) attributes["labels"] = labels;
  return {
    resource: {
      type,
      name: r.displayName || r.externalId || type,
      attributes,
      importId,
      ...(comments?.length ? { comments } : {}),
    },
  };
}

const DB_TYPES: Record<string, string> = {
  pg: "upcloud_managed_database_postgresql",
  mysql: "upcloud_managed_database_mysql",
  valkey: "upcloud_managed_database_valkey",
  opensearch: "upcloud_managed_database_opensearch",
};

export const upcloudTerraformExport: TerraformExportCapability = {
  provider: { name: "upcloud", source: "UpCloudLtd/upcloud", version: "~> 5.0" },
  providerConfig: {},
  variables: [],
  supportedResourceTypeIds: [
    "server",
    "storage",
    "network",
    "router",
    "floating-ip",
    "kubernetes-cluster",
    "node-group",
    "database",
    "load-balancer",
    "object-storage",
  ],
  mapResource(r): TerraformExportResult | null {
    const zone = fieldString(r, "region");
    switch (r.resourceTypeId) {
      case "server": {
        const plan = fieldString(r, "plan");
        if (!zone || !plan) return null;
        return block(
          "upcloud_server",
          r,
          {
            hostname: tf.str(fieldString(r, "hostname") || r.displayName),
            title: tf.str(fieldString(r, "title") || r.displayName),
            zone: tf.str(zone),
            plan: tf.str(plan),
            firewall: tf.bool(r.fields["firewall"] === true),
            metadata: tf.bool(r.fields["metadata"] === true),
            network_interface: tf.block({ type: tf.str("public") }),
          },
          [
            "Add a template block for the boot disk and the other network_interface blocks before applying.",
          ],
        );
      }
      case "storage": {
        const size = fieldNumber(r, "sizeGb");
        if (!zone || size === undefined) return null;
        return block("upcloud_storage", r, {
          title: tf.str(fieldString(r, "title") || r.displayName),
          size: tf.num(size),
          zone: tf.str(zone),
          tier: tf.str(fieldString(r, "tier") || "maxiops"),
          encrypt: tf.bool(r.fields["encrypted"] === true),
        });
      }
      case "network": {
        const cidr = fieldString(r, "cidr");
        if (!zone || !cidr) return null;
        const attrs: Record<string, TerraformValue> = {
          name: tf.str(fieldString(r, "name") || r.displayName),
          zone: tf.str(zone),
          ip_network: tf.block({
            address: tf.str(cidr),
            dhcp: tf.bool(r.fields["dhcp"] === true),
            family: tf.str("IPv4"),
          }),
        };
        const router = fieldString(r, "router");
        if (router) attrs["router"] = tf.str(router);
        return block("upcloud_network", r, attrs);
      }
      case "router":
        return block("upcloud_router", r, {
          name: tf.str(fieldString(r, "name") || r.displayName),
        });
      case "floating-ip": {
        const attrs: Record<string, TerraformValue> = { zone: tf.str(zone) };
        return block(
          "upcloud_floating_ip_address",
          r,
          attrs,
          ["Set mac_address to attach it to a server interface."],
          fieldString(r, "address"),
        );
      }
      case "kubernetes-cluster": {
        const network = fieldString(r, "network");
        if (!zone || !network) return null;
        const filter = fieldString(r, "controlPlaneIpFilter")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        return block("upcloud_kubernetes_cluster", r, {
          name: tf.str(fieldString(r, "name") || r.displayName),
          zone: tf.str(zone),
          network: tf.str(network),
          control_plane_ip_filter: tf.list((filter.length ? filter : ["0.0.0.0/0"]).map(tf.str)),
          ...(fieldString(r, "plan") ? { plan: tf.str(fieldString(r, "plan")) } : {}),
        });
      }
      case "node-group": {
        const [clusterId] = (r.externalId ?? "").split("/");
        if (!clusterId) return null;
        const out = block("upcloud_kubernetes_node_group", r, {
          cluster: tf.str(clusterId),
          name: tf.str(fieldString(r, "name")),
          plan: tf.str(fieldString(r, "plan")),
          node_count: tf.num(fieldNumber(r, "count") ?? 1),
        });
        // The provider documents no import id for node groups.
        out.resource.importId = undefined;
        return out;
      }
      case "database": {
        const type = DB_TYPES[fieldString(r, "type")];
        const plan = fieldString(r, "plan");
        if (!type || !zone || !plan) return null;
        return block(type, r, {
          name: tf.str(r.displayName.toLowerCase().replace(/[^a-z0-9-]+/g, "-")),
          title: tf.str(fieldString(r, "title") || r.displayName),
          plan: tf.str(plan),
          zone: tf.str(zone),
          powered: tf.bool(r.fields["powered"] !== false),
          termination_protection: tf.bool(r.fields["terminationProtection"] === true),
        });
      }
      case "load-balancer": {
        const plan = fieldString(r, "plan");
        if (!zone || !plan) return null;
        return block(
          "upcloud_loadbalancer",
          r,
          {
            name: tf.str(fieldString(r, "name") || r.displayName),
            plan: tf.str(plan),
            zone: tf.str(zone),
          },
          [
            "Frontends, backends and members are separate upcloud_loadbalancer_* resources; add a networks block for the private network.",
          ],
        );
      }
      case "object-storage": {
        const region = fieldString(r, "region");
        if (!region) return null;
        return block("upcloud_managed_object_storage", r, {
          name: tf.str(fieldString(r, "name") || r.displayName),
          region: tf.str(region),
          configured_status: tf.str(fieldString(r, "configuredStatus") || "started"),
        });
      }
      default:
        return null;
    }
  },
};
