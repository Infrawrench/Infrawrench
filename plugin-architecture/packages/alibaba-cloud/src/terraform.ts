import type {
  ResourceInstance,
  TerraformExportCapability,
  TerraformExportResult,
  TerraformValue,
} from "@infrawrench/plugin-base";
import { fieldNumber, fieldString, tf } from "@infrawrench/plugin-base";

/**
 * Terraform mapping for the official `aliyun/alicloud` provider (v1.293 at
 * the time of writing). Argument names and import ids follow the provider's
 * docs (github.com/aliyun/terraform-provider-alicloud, website/docs/r/*):
 * resources import by their bare Alibaba id (not this plugin's
 * `{region}/{id}` external id), buckets by name, DNS domains by name, DNS
 * records by record id, RAM users by user id. Credentials are variables.
 */

function bareId(resource: ResourceInstance): string {
  const ext = resource.externalId ?? "";
  return ext.includes("/") ? ext.slice(ext.indexOf("/") + 1) : ext;
}

const csv = (value: string | undefined) =>
  (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

export const alibabaTerraformExport: TerraformExportCapability = {
  provider: { name: "alicloud", source: "aliyun/alicloud", version: "~> 1.293" },
  providerConfig: {
    access_key: tf.ref("var.alicloud_access_key"),
    secret_key: tf.ref("var.alicloud_secret_key"),
    region: tf.ref("var.alicloud_region"),
  },
  variables: [
    { name: "alicloud_access_key", description: "AccessKey ID" },
    { name: "alicloud_secret_key", description: "AccessKey secret", sensitive: true },
    { name: "alicloud_region", description: "Region for the provider, e.g. ap-southeast-1" },
  ],
  supportedResourceTypeIds: [
    "ecs-instance",
    "disk",
    "snapshot",
    "vpc",
    "vswitch",
    "security-group",
    "eip",
    "slb",
    "rds-instance",
    "redis-instance",
    "oss-bucket",
    "dns-domain",
    "dns-record",
    "ram-user",
  ],
  mapResource(resource: ResourceInstance): TerraformExportResult | null {
    const name = fieldString(resource, "name") || resource.displayName;
    const region = fieldString(resource, "region");
    const comments = region
      ? [`Lives in ${region}: use a provider alias for that region if it differs.`]
      : [];
    const block = (
      type: string,
      attributes: Record<string, TerraformValue>,
      importId = bareId(resource),
      extra: string[] = [],
    ): TerraformExportResult => ({
      resource: {
        type,
        name: name || importId || type,
        attributes,
        importId,
        ...(comments.length || extra.length ? { comments: [...comments, ...extra] } : {}),
      },
    });
    const opt = (attrs: Record<string, TerraformValue>, key: string, value: string | undefined) => {
      if (value) attrs[key] = tf.str(value);
    };
    switch (resource.resourceTypeId) {
      case "ecs-instance": {
        const type = fieldString(resource, "instanceType");
        const image = fieldString(resource, "imageId");
        const vswitch = fieldString(resource, "vswitchId");
        const groups = csv(fieldString(resource, "securityGroupIds"));
        if (!type || !image || !vswitch || groups.length === 0) return null;
        const attrs: Record<string, TerraformValue> = {
          instance_name: tf.str(name),
          instance_type: tf.str(type),
          image_id: tf.str(image),
          vswitch_id: tf.str(vswitch),
          security_groups: tf.list(groups.map((g) => tf.str(g))),
        };
        opt(attrs, "availability_zone", fieldString(resource, "zoneId"));
        opt(attrs, "description", fieldString(resource, "description"));
        opt(attrs, "key_name", fieldString(resource, "keyPairName"));
        const bw = fieldNumber(resource, "internetMaxBandwidthOut");
        if (bw !== undefined) attrs["internet_max_bandwidth_out"] = tf.num(bw);
        return block("alicloud_instance", attrs, bareId(resource), [
          "`image_id` is the image the instance launched from; changing it forces replacement.",
        ]);
      }
      case "disk": {
        if (fieldString(resource, "diskType") === "system") return null;
        const zone = fieldString(resource, "zoneId");
        const size = fieldNumber(resource, "sizeGb");
        if (!zone || size === undefined) return null;
        const attrs: Record<string, TerraformValue> = {
          zone_id: tf.str(zone),
          size: tf.num(size),
          disk_name: tf.str(name),
        };
        opt(attrs, "category", fieldString(resource, "category"));
        opt(attrs, "description", fieldString(resource, "description"));
        return block("alicloud_ecs_disk", attrs);
      }
      case "snapshot": {
        const disk = fieldString(resource, "sourceDiskId");
        if (!disk) return null;
        const attrs: Record<string, TerraformValue> = {
          disk_id: tf.str(disk),
          snapshot_name: tf.str(name),
        };
        const days = fieldNumber(resource, "retentionDays");
        if (days !== undefined) attrs["retention_days"] = tf.num(days);
        return block("alicloud_ecs_snapshot", attrs);
      }
      case "vpc": {
        const cidr = fieldString(resource, "cidrBlock");
        if (!cidr) return null;
        const attrs: Record<string, TerraformValue> = {
          vpc_name: tf.str(name),
          cidr_block: tf.str(cidr),
        };
        opt(attrs, "description", fieldString(resource, "description"));
        return block("alicloud_vpc", attrs);
      }
      case "vswitch": {
        const vpc = fieldString(resource, "vpcId");
        const cidr = fieldString(resource, "cidrBlock");
        const zone = fieldString(resource, "zoneId");
        if (!vpc || !cidr || !zone) return null;
        const attrs: Record<string, TerraformValue> = {
          vswitch_name: tf.str(name),
          vpc_id: tf.str(vpc),
          cidr_block: tf.str(cidr),
          zone_id: tf.str(zone),
        };
        opt(attrs, "description", fieldString(resource, "description"));
        return block("alicloud_vswitch", attrs);
      }
      case "security-group": {
        const attrs: Record<string, TerraformValue> = { security_group_name: tf.str(name) };
        opt(attrs, "vpc_id", fieldString(resource, "vpcId"));
        opt(attrs, "description", fieldString(resource, "description"));
        return block("alicloud_security_group", attrs, bareId(resource), [
          "Rules are separate alicloud_security_group_rule resources.",
        ]);
      }
      case "eip": {
        const attrs: Record<string, TerraformValue> = {};
        opt(attrs, "address_name", fieldString(resource, "name"));
        const bw = fieldNumber(resource, "bandwidthMbps");
        if (bw !== undefined) attrs["bandwidth"] = tf.str(String(bw));
        opt(attrs, "internet_charge_type", fieldString(resource, "internetChargeType"));
        return block("alicloud_eip_address", attrs);
      }
      case "slb": {
        const attrs: Record<string, TerraformValue> = { load_balancer_name: tf.str(name) };
        opt(attrs, "address_type", fieldString(resource, "addressType"));
        opt(attrs, "load_balancer_spec", fieldString(resource, "spec"));
        opt(attrs, "vswitch_id", fieldString(resource, "vswitchId"));
        return block("alicloud_slb_load_balancer", attrs, bareId(resource), [
          "Listeners and backend servers are separate resources.",
        ]);
      }
      case "rds-instance": {
        const engine = fieldString(resource, "engine");
        const version = fieldString(resource, "engineVersion");
        const cls = fieldString(resource, "instanceClass");
        const storage = fieldNumber(resource, "storageGb");
        if (!engine || !version || !cls || storage === undefined) return null;
        const attrs: Record<string, TerraformValue> = {
          engine: tf.str(engine),
          engine_version: tf.str(version),
          instance_type: tf.str(cls),
          instance_storage: tf.num(storage),
          instance_name: tf.str(name),
        };
        opt(attrs, "vswitch_id", fieldString(resource, "vswitchId"));
        opt(attrs, "db_instance_storage_type", fieldString(resource, "storageType"));
        return block("alicloud_db_instance", attrs);
      }
      case "redis-instance": {
        const cls = fieldString(resource, "instanceClass");
        if (!cls) return null;
        const attrs: Record<string, TerraformValue> = {
          db_instance_name: tf.str(name),
          instance_class: tf.str(cls),
        };
        opt(attrs, "engine_version", fieldString(resource, "engineVersion"));
        opt(attrs, "vswitch_id", fieldString(resource, "vswitchId"));
        opt(attrs, "zone_id", fieldString(resource, "zoneId"));
        return block("alicloud_kvstore_instance", attrs);
      }
      case "oss-bucket": {
        const bucket = fieldString(resource, "name");
        if (!bucket) return null;
        const attrs: Record<string, TerraformValue> = { bucket: tf.str(bucket) };
        opt(attrs, "storage_class", fieldString(resource, "storageClass"));
        opt(attrs, "redundancy_type", fieldString(resource, "redundancyType"));
        opt(attrs, "acl", fieldString(resource, "acl"));
        return block("alicloud_oss_bucket", attrs, bucket);
      }
      case "dns-domain": {
        const domain = fieldString(resource, "name");
        if (!domain) return null;
        return block("alicloud_alidns_domain", { domain_name: tf.str(domain) }, domain);
      }
      case "dns-record": {
        const domain = fieldString(resource, "domain");
        const type = fieldString(resource, "type");
        const value = fieldString(resource, "content");
        const rr = fieldString(resource, "name");
        const recordId = (resource.externalId ?? "").split("/").pop() ?? "";
        if (!domain || !type || !value || !rr || !recordId) return null;
        const attrs: Record<string, TerraformValue> = {
          domain_name: tf.str(domain),
          rr: tf.str(rr),
          type: tf.str(type),
          value: tf.str(value),
        };
        const ttl = fieldNumber(resource, "ttl");
        if (ttl !== undefined) attrs["ttl"] = tf.num(ttl);
        const priority = fieldNumber(resource, "priority");
        if (priority !== undefined) attrs["priority"] = tf.num(priority);
        return {
          resource: {
            type: "alicloud_alidns_record",
            name: `${rr}_${type}`,
            attributes: attrs,
            importId: recordId,
          },
        };
      }
      case "ram-user": {
        const userId = fieldString(resource, "userId");
        const userName = fieldString(resource, "name");
        if (!userId || !userName) return null;
        const attrs: Record<string, TerraformValue> = { name: tf.str(userName) };
        opt(attrs, "display_name", fieldString(resource, "displayName"));
        opt(attrs, "email", fieldString(resource, "email"));
        opt(attrs, "comments", fieldString(resource, "comments"));
        return {
          resource: {
            type: "alicloud_ram_user",
            name: userName,
            attributes: attrs,
            importId: userId,
          },
        };
      }
      default:
        return null;
    }
  },
};
