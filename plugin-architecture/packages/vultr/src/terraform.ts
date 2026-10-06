import type {
  ResourceInstance,
  TerraformExportCapability,
  TerraformExportResult,
  TerraformValue,
} from "@infrawrench/plugin-base";
import { fieldNumber, fieldString, tf } from "@infrawrench/plugin-base";

/**
 * Terraform mapping for provider `vultr/vultr` (v2.32.0, 2026-07). Argument
 * names checked against `website/docs/r/*.html.markdown` in the provider
 * repository: vultr_instance (`plan`, `region`, `os_id`/`snapshot_id`/
 * `app_id`, `tags`, `backups`), vultr_block_storage (`size_gb`,
 * `block_type`, `attached_to_instance`), vultr_kubernetes (inline
 * `node_pools` block), vultr_database, vultr_load_balancer
 * (`forwarding_rules` blocks), vultr_firewall_group, vultr_vpc,
 * vultr_reserved_ip, vultr_dns_domain, vultr_dns_record (import id
 * `domain,record-id`), vultr_object_storage, vultr_ssh_key,
 * vultr_startup_script. The key is `var.vultr_api_key`.
 */

const list = (r: ResourceInstance, key: string): TerraformValue | null => {
  const items = fieldString(r, key)
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  return items.length ? tf.list(items.map(tf.str)) : null;
};

function block(
  type: string,
  r: ResourceInstance,
  attributes: Record<string, TerraformValue>,
  comments?: string[],
  importId = r.externalId,
): TerraformExportResult {
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

export const vultrTerraformExport: TerraformExportCapability = {
  provider: { name: "vultr", source: "vultr/vultr", version: "~> 2.32" },
  providerConfig: { api_key: tf.ref("var.vultr_api_key") },
  variables: [{ name: "vultr_api_key", description: "Vultr API key", sensitive: true }],
  supportedResourceTypeIds: [
    "instance",
    "block-storage",
    "kubernetes-cluster",
    "database",
    "load-balancer",
    "firewall-group",
    "vpc",
    "reserved-ip",
    "domain",
    "dns-record",
    "object-storage",
    "ssh-key",
    "startup-script",
  ],
  mapResource(r): TerraformExportResult | null {
    switch (r.resourceTypeId) {
      case "instance": {
        const region = fieldString(r, "region");
        const plan = fieldString(r, "plan");
        if (!region || !plan) return null;
        const attrs: Record<string, TerraformValue> = {
          label: tf.str(fieldString(r, "label") || r.displayName),
          region: tf.str(region),
          plan: tf.str(plan),
          backups: tf.str(r.fields["backupsEnabled"] === true ? "enabled" : "disabled"),
          enable_ipv6: tf.bool(r.fields["ipv6Enabled"] === true),
          ddos_protection: tf.bool(r.fields["ddosProtection"] === true),
        };
        const hostname = fieldString(r, "hostname");
        if (hostname) attrs["hostname"] = tf.str(hostname);
        const fw = fieldString(r, "firewallGroupId");
        if (fw) attrs["firewall_group_id"] = tf.str(fw);
        const tags = list(r, "tags");
        if (tags) attrs["tags"] = tags;
        return block("vultr_instance", r, attrs, [
          "Set os_id, app_id, image_id or snapshot_id to the source the instance was deployed from; changing it reinstalls the instance.",
          "ssh_key_ids and user_data are not exported.",
        ]);
      }
      case "block-storage": {
        const region = fieldString(r, "region");
        const size = fieldNumber(r, "sizeGb");
        if (!region || size === undefined) return null;
        const attrs: Record<string, TerraformValue> = {
          region: tf.str(region),
          size_gb: tf.num(size),
        };
        const label = fieldString(r, "label");
        if (label) attrs["label"] = tf.str(label);
        const type = fieldString(r, "blockType");
        if (type) attrs["block_type"] = tf.str(type);
        const attached = fieldString(r, "attachedInstanceId");
        if (attached) attrs["attached_to_instance"] = tf.str(attached);
        return block("vultr_block_storage", r, attrs);
      }
      case "kubernetes-cluster": {
        const region = fieldString(r, "region");
        const version = fieldString(r, "version");
        if (!region || !version) return null;
        const pool: Record<string, TerraformValue> = {
          node_quantity: tf.num(fieldNumber(r, "nodeCount") ?? 1),
          plan: tf.str(fieldString(r, "nodePlan")),
          label: tf.str("default"),
        };
        return block(
          "vultr_kubernetes",
          r,
          {
            label: tf.str(fieldString(r, "label") || r.displayName),
            region: tf.str(region),
            version: tf.str(version),
            ha_controlplanes: tf.bool(r.fields["haControlPlanes"] === true),
            node_pools: tf.block(pool),
          },
          [
            "node_pools describes the first pool only; add vultr_kubernetes_node_pools resources for the others.",
          ],
        );
      }
      case "database": {
        const engine = fieldString(r, "engine");
        const version = fieldString(r, "version");
        const region = fieldString(r, "region");
        const plan = fieldString(r, "plan");
        if (!engine || !version || !region || !plan) return null;
        const attrs: Record<string, TerraformValue> = {
          label: tf.str(fieldString(r, "label") || r.displayName),
          database_engine: tf.str(engine),
          database_engine_version: tf.str(version),
          region: tf.str(region),
          plan: tf.str(plan),
        };
        const trusted = list(r, "trustedIps");
        if (trusted) attrs["trusted_ips"] = trusted;
        const dow = fieldString(r, "maintenanceDow");
        if (dow) attrs["maintenance_dow"] = tf.str(dow);
        const time = fieldString(r, "maintenanceTime");
        if (time) attrs["maintenance_time"] = tf.str(time);
        const vpc = fieldString(r, "vpcId");
        if (vpc) attrs["vpc_id"] = tf.str(vpc);
        return block("vultr_database", r, attrs);
      }
      case "load-balancer": {
        const region = fieldString(r, "region");
        if (!region) return null;
        const attrs: Record<string, TerraformValue> = {
          region: tf.str(region),
          balancing_algorithm: tf.str(fieldString(r, "balancingAlgorithm") || "roundrobin"),
          ssl_redirect: tf.bool(r.fields["sslRedirect"] === true),
          proxy_protocol: tf.bool(r.fields["proxyProtocol"] === true),
        };
        const label = fieldString(r, "label");
        if (label) attrs["label"] = tf.str(label);
        const instances = list(r, "instanceIds");
        if (instances) attrs["attached_instances"] = instances;
        return block("vultr_load_balancer", r, attrs, [
          "Add forwarding_rules blocks for each listener; they are not part of the synced inventory.",
        ]);
      }
      case "firewall-group":
        return block(
          "vultr_firewall_group",
          r,
          {
            description: tf.str(fieldString(r, "description") || r.displayName),
          },
          ["Rules are separate vultr_firewall_rule resources."],
        );
      case "vpc": {
        const region = fieldString(r, "region");
        if (!region) return null;
        const attrs: Record<string, TerraformValue> = {
          region: tf.str(region),
          description: tf.str(fieldString(r, "description") || r.displayName),
        };
        const [subnet, mask] = fieldString(r, "subnet").split("/");
        if (subnet && mask) {
          attrs["v4_subnet"] = tf.str(subnet);
          attrs["v4_subnet_mask"] = tf.num(Number(mask));
        }
        return block("vultr_vpc", r, attrs);
      }
      case "reserved-ip": {
        const region = fieldString(r, "region");
        const ipType = fieldString(r, "ipType");
        if (!region || !ipType) return null;
        const attrs: Record<string, TerraformValue> = {
          region: tf.str(region),
          ip_type: tf.str(ipType),
        };
        const label = fieldString(r, "label");
        if (label) attrs["label"] = tf.str(label);
        const inst = fieldString(r, "instanceId");
        if (inst) attrs["instance_id"] = tf.str(inst);
        return block("vultr_reserved_ip", r, attrs);
      }
      case "domain": {
        const domain = fieldString(r, "domain") || r.externalId;
        if (!domain) return null;
        return block("vultr_dns_domain", r, {
          domain: tf.str(domain),
          dns_sec: tf.str(fieldString(r, "dnsSec") || "disabled"),
        });
      }
      case "dns-record": {
        const domain = fieldString(r, "domainName");
        const type = fieldString(r, "type");
        const recordId = (r.externalId ?? "").split("/").slice(1).join("/");
        if (!domain || !type) return null;
        const attrs: Record<string, TerraformValue> = {
          domain: tf.str(domain),
          name: tf.str(fieldString(r, "name")),
          type: tf.str(type),
          data: tf.str(fieldString(r, "data")),
        };
        const ttl = fieldNumber(r, "ttl");
        if (ttl) attrs["ttl"] = tf.num(ttl);
        if (type === "MX" || type === "SRV")
          attrs["priority"] = tf.num(fieldNumber(r, "priority") ?? 0);
        return block("vultr_dns_record", r, attrs, undefined, `${domain},${recordId}`);
      }
      case "object-storage": {
        const cluster = fieldNumber(r, "clusterId");
        if (!cluster) return null;
        return block(
          "vultr_object_storage",
          r,
          { cluster_id: tf.num(cluster), label: tf.str(fieldString(r, "label") || r.displayName) },
          ["Set tier_id to the subscription's tier; the inventory stores only its name."],
        );
      }
      case "ssh-key": {
        const key = fieldString(r, "publicKey");
        if (!key) return null;
        return block("vultr_ssh_key", r, {
          name: tf.str(fieldString(r, "name") || r.displayName),
          ssh_key: tf.str(key),
        });
      }
      case "startup-script":
        return block(
          "vultr_startup_script",
          r,
          {
            name: tf.str(fieldString(r, "name") || r.displayName),
            type: tf.str(fieldString(r, "type") || "boot"),
            script: tf.ref(
              'base64encode(file("${path.module}/scripts/' + (r.externalId ?? "script") + '.sh"))',
            ),
          },
          ["Save the script body next to this file; it is not part of the exported inventory."],
        );
      default:
        return null;
    }
  },
};
