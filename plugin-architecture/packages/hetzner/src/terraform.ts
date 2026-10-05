import type {
  TerraformExportCapability,
  TerraformExportResult,
  TerraformValue,
} from "@infrawrench/plugin-base";
import { fieldNumber, fieldString, tf } from "@infrawrench/plugin-base";

/**
 * Terraform mapping for Hetzner Cloud: provider `hetznercloud/hcloud`.
 * Attribute names verified against the provider docs
 * (registry.terraform.io/providers/hetznercloud/hcloud):
 *   - hcloud_server: name / server_type / image required; location optional.
 *   - hcloud_volume: name / size required; location conflicts with server_id.
 * The API token is always emitted as `var.hcloud_token`, never inlined.
 */
export const hetznerTerraformExport: TerraformExportCapability = {
  provider: { name: "hcloud", source: "hetznercloud/hcloud", version: "~> 1.45" },
  providerConfig: { token: tf.ref("var.hcloud_token") },
  variables: [
    {
      name: "hcloud_token",
      description: "Hetzner Cloud API token (Security → API Tokens)",
      sensitive: true,
    },
  ],
  supportedResourceTypeIds: [
    "server",
    "volume",
    "network",
    "load-balancer",
    "floating-ip",
    "placement-group",
  ],
  mapResource(resource): TerraformExportResult | null {
    if (resource.resourceTypeId === "server") {
      const name = fieldString(resource, "name") || resource.displayName;
      const serverType = fieldString(resource, "serverType");
      const image = fieldString(resource, "image");
      if (!name || !serverType || !image) return null;
      const attributes: Record<string, TerraformValue> = {
        name: tf.str(name),
        server_type: tf.str(serverType),
        image: tf.str(image),
      };
      const location = fieldString(resource, "location");
      if (location) attributes["location"] = tf.str(location);
      return {
        resource: {
          type: "hcloud_server",
          name,
          attributes,
          importId: resource.externalId,
          comments: [
            "`image` is the image the server was created from; rebuilding from Terraform",
            "recreates the server from that image, not from its current disk contents.",
          ],
        },
      };
    }
    if (resource.resourceTypeId === "volume") {
      const name = fieldString(resource, "name") || resource.displayName;
      const size = fieldNumber(resource, "sizeGb");
      if (!name || size === undefined) return null;
      const attributes: Record<string, TerraformValue> = {
        name: tf.str(name),
        size: tf.num(size),
      };
      const location = fieldString(resource, "location");
      if (location) attributes["location"] = tf.str(location);
      const format = fieldString(resource, "format");
      if (format) attributes["format"] = tf.str(format);
      const comments: string[] = [];
      const serverId = fieldString(resource, "serverId");
      if (serverId) {
        comments.push(
          `Currently attached to server ${serverId}; model the attachment with a`,
          "separate hcloud_volume_attachment resource (server_id conflicts with location).",
        );
      }
      return {
        resource: {
          type: "hcloud_volume",
          name,
          attributes,
          importId: resource.externalId,
          ...(comments.length > 0 ? { comments } : {}),
        },
      };
    }
    // Attribute names per registry.terraform.io/providers/hetznercloud/hcloud:
    // hcloud_network (name, ip_range), hcloud_load_balancer (name,
    // load_balancer_type, location), hcloud_floating_ip (type, home_location,
    // name) and hcloud_placement_group (name, type). Subnets, services,
    // targets and assignments are separate resources and are left to the user.
    if (resource.resourceTypeId === "network") {
      const name = fieldString(resource, "name") || resource.displayName;
      const ipRange = fieldString(resource, "ipRange");
      if (!name || !ipRange) return null;
      return {
        resource: {
          type: "hcloud_network",
          name,
          attributes: { name: tf.str(name), ip_range: tf.str(ipRange) },
          importId: resource.externalId,
          comments: ["Subnets and routes are separate hcloud_network_subnet / _route resources."],
        },
      };
    }
    if (resource.resourceTypeId === "load-balancer") {
      const name = fieldString(resource, "name") || resource.displayName;
      const type = fieldString(resource, "type");
      const location = fieldString(resource, "location");
      if (!name || !type) return null;
      const attributes: Record<string, TerraformValue> = {
        name: tf.str(name),
        load_balancer_type: tf.str(type),
      };
      if (location) attributes["location"] = tf.str(location);
      return {
        resource: {
          type: "hcloud_load_balancer",
          name,
          attributes,
          importId: resource.externalId,
          comments: [
            "Services, targets and network attachments are separate hcloud_load_balancer_* resources.",
          ],
        },
      };
    }
    if (resource.resourceTypeId === "floating-ip") {
      const type = fieldString(resource, "type");
      const location = fieldString(resource, "location");
      if (!type || !location) return null;
      const name = fieldString(resource, "name") || fieldString(resource, "ip");
      const attributes: Record<string, TerraformValue> = {
        type: tf.str(type),
        home_location: tf.str(location),
      };
      if (fieldString(resource, "name")) attributes["name"] = tf.str(fieldString(resource, "name"));
      return {
        resource: {
          type: "hcloud_floating_ip",
          name: name || resource.externalId || "floating_ip",
          attributes,
          importId: resource.externalId,
        },
      };
    }
    if (resource.resourceTypeId === "placement-group") {
      const name = fieldString(resource, "name") || resource.displayName;
      const type = fieldString(resource, "type") || "spread";
      if (!name) return null;
      return {
        resource: {
          type: "hcloud_placement_group",
          name,
          attributes: { name: tf.str(name), type: tf.str(type) },
          importId: resource.externalId,
        },
      };
    }
    return null;
  },
};
