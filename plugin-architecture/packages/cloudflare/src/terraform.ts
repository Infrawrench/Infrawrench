import type {
  TerraformExportCapability,
  TerraformExportResult,
  TerraformValue,
} from "@infrawrench/plugin-base";
import { fieldBool, fieldNumber, fieldString, tf } from "@infrawrench/plugin-base";

/**
 * Terraform mapping for Cloudflare — provider `cloudflare/cloudflare` v5.
 * Attribute names verified against the v5 provider docs
 * (registry.terraform.io/providers/cloudflare/cloudflare):
 *   - cloudflare_zone: `account = { id = … }` (nested attribute) + name
 *     required; type / paused optional. v5 renamed the old `account_id`.
 *   - cloudflare_dns_record: name / type / ttl required (ttl 1 = automatic);
 *     zone_id, content, proxied, priority, comment optional.
 * The API token and account ID are emitted as variables — never inlined.
 */
export const cloudflareTerraformExport: TerraformExportCapability = {
  provider: { name: "cloudflare", source: "cloudflare/cloudflare", version: "~> 5.0" },
  providerConfig: { api_token: tf.ref("var.cloudflare_api_token") },
  variables: [
    {
      name: "cloudflare_api_token",
      description: "Cloudflare API token with access to the exported zones",
      sensitive: true,
    },
  ],
  supportedResourceTypeIds: ["zone", "dns-record"],
  mapResource(resource): TerraformExportResult | null {
    if (resource.resourceTypeId === "zone") {
      const name = fieldString(resource, "name") || resource.displayName;
      if (!name) return null;
      const attributes: Record<string, TerraformValue> = {
        account: tf.map({ id: tf.ref("var.cloudflare_account_id") }),
        name: tf.str(name),
      };
      const zoneType = fieldString(resource, "type");
      if (zoneType) attributes["type"] = tf.str(zoneType);
      if (fieldBool(resource, "paused")) attributes["paused"] = tf.bool(true);
      return {
        resource: {
          type: "cloudflare_zone",
          name,
          attributes,
          importId: resource.externalId,
        },
        variables: [
          {
            name: "cloudflare_account_id",
            description: "Cloudflare account ID that owns the exported zones",
          },
        ],
      };
    }
    if (resource.resourceTypeId === "dns-record") {
      // externalId is `${zoneId}/${recordId}` — also the v5 import format.
      const [zoneId] = (resource.externalId ?? "").split("/");
      const type = fieldString(resource, "type");
      const name = fieldString(resource, "name");
      const content = fieldString(resource, "content");
      if (!zoneId || !type || !name || !content) return null;
      const attributes: Record<string, TerraformValue> = {
        zone_id: tf.str(zoneId),
        name: tf.str(name),
        type: tf.str(type),
        content: tf.str(content),
        // ttl is required in provider v5; 1 means "automatic".
        ttl: tf.num(fieldNumber(resource, "ttl") ?? 1),
      };
      if (fieldBool(resource, "proxied")) attributes["proxied"] = tf.bool(true);
      const priority = fieldNumber(resource, "priority");
      if (priority !== undefined && (type === "MX" || type === "SRV" || type === "URI"))
        attributes["priority"] = tf.num(priority);
      const comment = fieldString(resource, "comment");
      if (comment) attributes["comment"] = tf.str(comment);
      return {
        resource: {
          type: "cloudflare_dns_record",
          name: `${type} ${name}`,
          attributes,
          importId: resource.externalId,
        },
      };
    }
    return null;
  },
};
