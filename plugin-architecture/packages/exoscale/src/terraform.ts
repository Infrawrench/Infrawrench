import type {
  ResourceInstance,
  TerraformExportCapability,
  TerraformExportResult,
  TerraformValue,
} from "@infrawrench/plugin-base";
import { fieldNumber, fieldString, tf } from "@infrawrench/plugin-base";

/**
 * Terraform mapping for provider `exoscale/exoscale` (~> 0.74, docs checked
 * 2026-10). Import ids follow each resource's documented `terraform import`
 * example: `uuid@zone` for zonal resources, `cluster/pool@zone` for SKS node
 * pools, `record@domain` for DNS records, the bare uuid for global ones and
 * the name for SSH keys. Block storage volumes and DBaaS services document
 * no import id, so those blocks carry none.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

/** `{zone}/{uuid}` external ids. */
function zonalParts(r: ResourceInstance): { zone: string; id: string } {
  const ext = r.externalId ?? "";
  const i = ext.indexOf("/");
  return i < 0
    ? { zone: fieldString(r, "region"), id: ext }
    : { zone: ext.slice(0, i), id: ext.slice(i + 1) };
}

function block(
  type: string,
  r: ResourceInstance,
  attributes: Record<string, TerraformValue>,
  importId: string | undefined,
  comments?: string[],
): TerraformExportResult {
  const labels = labelMap(r);
  if (labels) attributes["labels"] = labels;
  return {
    resource: {
      type,
      name: r.displayName || r.externalId || type,
      attributes,
      ...(importId ? { importId } : {}),
      ...(comments?.length ? { comments } : {}),
    },
  };
}

const optional = (attrs: Record<string, TerraformValue>, key: string, value: string) => {
  if (value) attrs[key] = tf.str(value);
  return attrs;
};

export const exoscaleTerraformExport: TerraformExportCapability = {
  provider: { name: "exoscale", source: "exoscale/exoscale", version: "~> 0.74" },
  providerConfig: {
    key: tf.ref("var.exoscale_api_key"),
    secret: tf.ref("var.exoscale_api_secret"),
  },
  variables: [
    { name: "exoscale_api_key", description: "Exoscale API key (EXO…)" },
    { name: "exoscale_api_secret", description: "Exoscale API secret", sensitive: true },
  ],
  supportedResourceTypeIds: [
    "instance",
    "block-storage",
    "private-network",
    "security-group",
    "elastic-ip",
    "sks-cluster",
    "sks-nodepool",
    "nlb",
    "instance-pool",
    "dbaas",
    "dns-domain",
    "dns-record",
    "ssh-key",
    "anti-affinity-group",
  ],
  mapResource(r): TerraformExportResult | null {
    const { zone, id } = zonalParts(r);
    const name = tf.str(fieldString(r, "name") || r.displayName);
    switch (r.resourceTypeId) {
      case "instance": {
        const type = fieldString(r, "instanceType");
        if (!zone || !type) return null;
        const template = fieldString(r, "template");
        return block(
          "exoscale_compute_instance",
          r,
          {
            zone: tf.str(zone),
            name,
            type: tf.str(type),
            disk_size: tf.num(fieldNumber(r, "diskGb") ?? 10),
            template_id: tf.str(UUID.test(template) ? template : ""),
          },
          `${id}@${zone}`,
          [
            UUID.test(template)
              ? "Security groups, private networks and elastic IPs are attached through security_group_ids, network_interface and elastic_ip_ids."
              : `Set template_id to the id of the "${template}" template (data "exoscale_template" looks it up by name).`,
          ],
        );
      }
      case "block-storage": {
        if (!zone) return null;
        return block(
          "exoscale_block_storage_volume",
          r,
          { zone: tf.str(zone), name, size: tf.num(fieldNumber(r, "sizeGb") ?? 10) },
          undefined,
          [
            "The provider documents no import id for volumes; adopt it by recreating or with a moved block.",
          ],
        );
      }
      case "private-network": {
        if (!zone) return null;
        return block(
          "exoscale_private_network",
          r,
          optional({ zone: tf.str(zone), name }, "description", fieldString(r, "description")),
          `${id}@${zone}`,
        );
      }
      case "security-group": {
        const attrs: Record<string, TerraformValue> = { name };
        optional(attrs, "description", fieldString(r, "description"));
        const sources = fieldString(r, "externalSources")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        if (sources.length) attrs["external_sources"] = tf.list(sources.map(tf.str));
        return block("exoscale_security_group", r, attrs, r.externalId, [
          "Rules are separate exoscale_security_group_rule resources.",
        ]);
      }
      case "elastic-ip": {
        if (!zone) return null;
        const attrs: Record<string, TerraformValue> = { zone: tf.str(zone) };
        if (fieldString(r, "family") === "inet6") attrs["address_family"] = tf.str("inet6");
        optional(attrs, "description", fieldString(r, "description"));
        return block(
          "exoscale_elastic_ip",
          r,
          attrs,
          `${id}@${zone}`,
          fieldString(r, "healthcheck")
            ? ["Add the healthcheck block for this managed EIP."]
            : undefined,
        );
      }
      case "sks-cluster": {
        if (!zone) return null;
        const attrs: Record<string, TerraformValue> = { zone: tf.str(zone), name };
        optional(attrs, "description", fieldString(r, "description"));
        optional(attrs, "service_level", fieldString(r, "level"));
        optional(attrs, "cni", fieldString(r, "cni"));
        optional(attrs, "version", fieldString(r, "version"));
        attrs["auto_upgrade"] = tf.bool(r.fields["autoUpgrade"] === true);
        const addons = fieldString(r, "addons");
        attrs["exoscale_ccm"] = tf.bool(addons.includes("exoscale-cloud-controller"));
        attrs["metrics_server"] = tf.bool(addons.includes("metrics-server"));
        return block("exoscale_sks_cluster", r, attrs, `${id}@${zone}`);
      }
      case "sks-nodepool": {
        const parts = (r.externalId ?? "").split("/");
        const [z, clusterId, poolId] = parts;
        const type = fieldString(r, "instanceType");
        if (!z || !clusterId || !poolId || !type) return null;
        const attrs: Record<string, TerraformValue> = {
          zone: tf.str(z),
          cluster_id: tf.str(clusterId),
          name,
          instance_type: tf.str(type),
          size: tf.num(fieldNumber(r, "size") ?? 1),
        };
        const disk = fieldNumber(r, "diskGb");
        if (disk) attrs["disk_size"] = tf.num(disk);
        optional(attrs, "description", fieldString(r, "description"));
        return block("exoscale_sks_nodepool", r, attrs, `${clusterId}/${poolId}@${z}`);
      }
      case "nlb": {
        if (!zone) return null;
        return block(
          "exoscale_nlb",
          r,
          optional({ zone: tf.str(zone), name }, "description", fieldString(r, "description")),
          `${id}@${zone}`,
          ["Services are separate exoscale_nlb_service resources."],
        );
      }
      case "instance-pool": {
        const type = fieldString(r, "instanceType");
        if (!zone || !type) return null;
        return block(
          "exoscale_instance_pool",
          r,
          {
            zone: tf.str(zone),
            name,
            size: tf.num(fieldNumber(r, "size") ?? 1),
            instance_type: tf.str(type),
            template_id: tf.str(""),
          },
          `${id}@${zone}`,
          ['Set template_id to the pool\'s template (data "exoscale_template").'],
        );
      }
      case "dbaas": {
        const type = fieldString(r, "type");
        const plan = fieldString(r, "plan");
        if (!zone || !type || !plan) return null;
        const attrs: Record<string, TerraformValue> = {
          zone: tf.str(zone),
          name,
          type: tf.str(type),
          plan: tf.str(plan),
          termination_protection: tf.bool(r.fields["terminationProtection"] === true),
        };
        optional(attrs, "maintenance_dow", fieldString(r, "maintenanceDow"));
        optional(attrs, "maintenance_time", fieldString(r, "maintenanceTime"));
        const out = block("exoscale_dbaas", r, attrs, undefined, [
          `Type-specific settings (ip_filter, version) go in the ${type} block.`,
        ]);
        // DBaaS labels are not a provider argument.
        delete out.resource.attributes["labels"];
        return out;
      }
      case "dns-domain":
        return block("exoscale_domain", r, { name }, r.externalId);
      case "dns-record": {
        const [domainId, recordId] = (r.externalId ?? "").split("/");
        if (!domainId || !recordId) return null;
        const attrs: Record<string, TerraformValue> = {
          domain: tf.str(domainId),
          name: tf.str(fieldString(r, "name")),
          record_type: tf.str(fieldString(r, "type")),
          content: tf.str(fieldString(r, "content")),
        };
        const ttl = fieldNumber(r, "ttl");
        if (ttl) attrs["ttl"] = tf.num(ttl);
        const prio = fieldNumber(r, "priority");
        if (prio && ["MX", "SRV"].includes(fieldString(r, "type"))) attrs["prio"] = tf.num(prio);
        return block("exoscale_domain_record", r, attrs, `${recordId}@${domainId}`);
      }
      case "ssh-key":
        return block("exoscale_ssh_key", r, { name, public_key: tf.str("") }, r.externalId, [
          "Exoscale stores only the fingerprint; paste the public key into public_key.",
        ]);
      case "anti-affinity-group":
        return block(
          "exoscale_anti_affinity_group",
          r,
          optional({ name }, "description", fieldString(r, "description")),
          r.externalId,
        );
      default:
        return null;
    }
  },
};
