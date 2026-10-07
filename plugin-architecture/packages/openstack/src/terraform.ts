import type {
  TerraformExportCapability,
  TerraformExportResult,
  TerraformValue,
} from "@infrawrench/plugin-base";
import { fieldBool, fieldNumber, fieldString, tf } from "@infrawrench/plugin-base";
import {
  CONTAINER,
  DNS_RECORDSET,
  DNS_ZONE,
  FLOATING_IP,
  KEYPAIR,
  LOADBALANCER,
  NETWORK,
  ROUTER,
  SECURITY_GROUP,
  SERVER,
  SG_RULE,
  SUBNET,
  VOLUME,
} from "./resources.js";

/**
 * Terraform mapping for `terraform-provider-openstack/openstack` (3.x, the
 * provider every OpenStack cloud documents). Argument names and import ids
 * checked against its docs/resources pages (2026-10). Every import id is the
 * resource UUID except key pairs and containers (name) and record sets
 * (`zone_id/recordset_id`).
 */
const list = (s: string): TerraformValue =>
  tf.list(
    s
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean)
      .map((x) => tf.str(x)),
  );

export const openstackTerraformExport: TerraformExportCapability = {
  provider: {
    name: "openstack",
    source: "terraform-provider-openstack/openstack",
    version: "~> 3.4",
  },
  providerConfig: {
    auth_url: tf.ref("var.openstack_auth_url"),
    region: tf.ref("var.openstack_region"),
  },
  variables: [
    {
      name: "openstack_auth_url",
      description:
        "Keystone v3 URL. Credentials come from OS_* environment variables or clouds.yaml",
    },
    { name: "openstack_region", description: "OpenStack region" },
  ],
  supportedResourceTypeIds: [
    SERVER,
    KEYPAIR,
    VOLUME,
    NETWORK,
    SUBNET,
    ROUTER,
    FLOATING_IP,
    SECURITY_GROUP,
    SG_RULE,
    LOADBALANCER,
    CONTAINER,
    DNS_ZONE,
    DNS_RECORDSET,
  ],
  mapResource(r): TerraformExportResult | null {
    const name = fieldString(r, "name") || r.displayName;
    const id = r.externalId;
    const desc = fieldString(r, "description");
    const withDesc = (a: Record<string, TerraformValue>) =>
      desc ? { ...a, description: tf.str(desc) } : a;
    switch (r.resourceTypeId) {
      case SERVER: {
        const flavor = fieldString(r, "flavor");
        if (!flavor) return null;
        const attributes: Record<string, TerraformValue> = {
          name: tf.str(name),
          flavor_name: tf.str(flavor),
        };
        const image = fieldString(r, "imageId");
        if (image) attributes["image_id"] = tf.str(image);
        const key = fieldString(r, "keyName");
        if (key) attributes["key_pair"] = tf.str(key);
        const az = fieldString(r, "availabilityZone");
        if (az) attributes["availability_zone"] = tf.str(az);
        const sgs = fieldString(r, "securityGroups");
        if (sgs) attributes["security_groups"] = list(sgs);
        const nets = fieldString(r, "networkIds")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        if (nets[0]) attributes["network"] = tf.block({ uuid: tf.str(nets[0]) });
        const comments =
          nets.length > 1
            ? [
                `Also attached to networks ${nets.slice(1).join(", ")}: add a network block for each.`,
              ]
            : undefined;
        return {
          resource: {
            type: "openstack_compute_instance_v2",
            name,
            attributes,
            importId: id,
            ...(comments ? { comments } : {}),
          },
        };
      }
      case KEYPAIR: {
        const pub = r.resolvedOutputs["publicKey"];
        return {
          resource: {
            type: "openstack_compute_keypair_v2",
            name,
            attributes: { name: tf.str(name), ...(pub ? { public_key: tf.str(pub) } : {}) },
            importId: name,
          },
        };
      }
      case VOLUME: {
        const size = fieldNumber(r, "sizeGb");
        if (!size) return null;
        const a: Record<string, TerraformValue> = { name: tf.str(name), size: tf.num(size) };
        if (fieldString(r, "volumeType")) a["volume_type"] = tf.str(fieldString(r, "volumeType"));
        if (fieldString(r, "availabilityZone"))
          a["availability_zone"] = tf.str(fieldString(r, "availabilityZone"));
        return {
          resource: {
            type: "openstack_blockstorage_volume_v3",
            name,
            attributes: withDesc(a),
            importId: id,
          },
        };
      }
      case NETWORK: {
        if (!fieldBool(r, "owned")) return null;
        const a: Record<string, TerraformValue> = {
          name: tf.str(name),
          admin_state_up: tf.bool(fieldBool(r, "adminStateUp") ?? true),
        };
        const mtu = fieldNumber(r, "mtu");
        if (mtu) a["mtu"] = tf.num(mtu);
        return {
          resource: {
            type: "openstack_networking_network_v2",
            name,
            attributes: withDesc(a),
            importId: id,
          },
        };
      }
      case SUBNET: {
        const a: Record<string, TerraformValue> = {
          name: tf.str(name),
          network_id: tf.str(fieldString(r, "networkId")),
          cidr: tf.str(fieldString(r, "cidr")),
          ip_version: tf.num(fieldNumber(r, "ipVersion") ?? 4),
          enable_dhcp: tf.bool(fieldBool(r, "enableDhcp") ?? true),
        };
        if (fieldString(r, "gatewayIp")) a["gateway_ip"] = tf.str(fieldString(r, "gatewayIp"));
        if (fieldString(r, "dnsNameservers"))
          a["dns_nameservers"] = list(fieldString(r, "dnsNameservers"));
        return {
          resource: {
            type: "openstack_networking_subnet_v2",
            name,
            attributes: withDesc(a),
            importId: id,
          },
        };
      }
      case ROUTER: {
        const a: Record<string, TerraformValue> = {
          name: tf.str(name),
          admin_state_up: tf.bool(fieldBool(r, "adminStateUp") ?? true),
        };
        if (fieldString(r, "externalNetworkId"))
          a["external_network_id"] = tf.str(fieldString(r, "externalNetworkId"));
        return {
          resource: {
            type: "openstack_networking_router_v2",
            name,
            attributes: withDesc(a),
            importId: id,
            comments: [
              "Router interfaces are separate openstack_networking_router_interface_v2 resources.",
            ],
          },
        };
      }
      case FLOATING_IP:
        return {
          resource: {
            type: "openstack_networking_floatingip_v2",
            name: fieldString(r, "ip") || name,
            attributes: withDesc({ pool: tf.str(fieldString(r, "networkId")) }),
            importId: id,
            comments: [
              "pool takes the external network name; replace the network id with its name.",
            ],
          },
        };
      case SECURITY_GROUP:
        return {
          resource: {
            type: "openstack_networking_secgroup_v2",
            name,
            attributes: withDesc({ name: tf.str(name) }),
            importId: id,
          },
        };
      case SG_RULE: {
        const a: Record<string, TerraformValue> = {
          direction: tf.str(fieldString(r, "direction")),
          ethertype: tf.str(fieldString(r, "ethertype")),
          security_group_id: tf.str(fieldString(r, "securityGroupId")),
        };
        if (fieldString(r, "protocol")) a["protocol"] = tf.str(fieldString(r, "protocol"));
        const min = fieldNumber(r, "portRangeMin");
        const max = fieldNumber(r, "portRangeMax");
        if (min !== undefined) a["port_range_min"] = tf.num(min);
        if (max !== undefined) a["port_range_max"] = tf.num(max);
        if (fieldString(r, "remoteIpPrefix"))
          a["remote_ip_prefix"] = tf.str(fieldString(r, "remoteIpPrefix"));
        if (fieldString(r, "remoteGroupId"))
          a["remote_group_id"] = tf.str(fieldString(r, "remoteGroupId"));
        return {
          resource: {
            type: "openstack_networking_secgroup_rule_v2",
            name: r.displayName,
            attributes: a,
            importId: id,
          },
        };
      }
      case LOADBALANCER: {
        const subnet = fieldString(r, "vipSubnetId");
        if (!subnet) return null;
        return {
          resource: {
            type: "openstack_lb_loadbalancer_v2",
            name,
            attributes: withDesc({ name: tf.str(name), vip_subnet_id: tf.str(subnet) }),
            importId: id,
          },
        };
      }
      case CONTAINER:
        return {
          resource: {
            type: "openstack_objectstorage_container_v1",
            name,
            attributes: {
              name: tf.str(name),
              ...(fieldBool(r, "publicRead") ? { container_read: tf.str(".r:*,.rlistings") } : {}),
            },
            importId: name,
          },
        };
      case DNS_ZONE:
        return {
          resource: {
            type: "openstack_dns_zone_v2",
            name: name.replace(/\.$/, ""),
            attributes: withDesc({
              name: tf.str(name),
              email: tf.str(fieldString(r, "email")),
              ttl: tf.num(fieldNumber(r, "ttl") ?? 3600),
            }),
            importId: id,
          },
        };
      case DNS_RECORDSET: {
        const type = fieldString(r, "type");
        if (type === "SOA" || type === "NS") return null;
        return {
          resource: {
            type: "openstack_dns_recordset_v2",
            name: `${name}-${type}`,
            attributes: {
              zone_id: tf.str(fieldString(r, "zoneId")),
              name: tf.str(name),
              type: tf.str(type),
              records: list(fieldString(r, "content")),
              ttl: tf.num(fieldNumber(r, "ttl") ?? 3600),
            },
            importId: id,
          },
        };
      }
      default:
        return null;
    }
  },
};
