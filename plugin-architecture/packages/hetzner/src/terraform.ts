import type {
  TerraformExportCapability,
  TerraformExportResult,
  TerraformValue,
} from "@infrawrench/plugin-base";
import { fieldNumber, fieldString, tf } from "@infrawrench/plugin-base";

/**
 * Terraform mapping for Hetzner Cloud — provider `hetznercloud/hcloud`.
 * Attribute names verified against the provider docs
 * (registry.terraform.io/providers/hetznercloud/hcloud):
 *   - hcloud_server: name / server_type / image required; location optional.
 *   - hcloud_volume: name / size required; location conflicts with server_id.
 * The API token is always emitted as `var.hcloud_token` — never inlined.
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
  supportedResourceTypeIds: ["server", "volume"],
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
          `Currently attached to server ${serverId} — model the attachment with a`,
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
    return null;
  },
};
