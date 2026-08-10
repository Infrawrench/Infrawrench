import type {
  TerraformExportCapability,
  TerraformExportResult,
  TerraformValue,
} from "@infrawrench/plugin-base";
import { fieldNumber, fieldString, tf } from "@infrawrench/plugin-base";

/**
 * The DigitalOcean lister persists `fields.name` as a fully-qualified display
 * name (`www.example.com`, or the bare domain for `@`). Terraform's
 * `digitalocean_record.name` wants the domain-relative form (`www` / `@`).
 */
export function relativeDnsRecordName(storedName: string, domain: string): string {
  if (storedName === domain) return "@";
  if (domain && storedName.endsWith(`.${domain}`)) {
    return storedName.slice(0, -(domain.length + 1));
  }
  return storedName;
}

/**
 * Terraform mapping for DigitalOcean — provider `digitalocean/digitalocean`.
 * Attribute names verified against the provider docs
 * (registry.terraform.io/providers/digitalocean/digitalocean):
 *   - digitalocean_droplet: image / name / size required; region optional.
 *   - digitalocean_volume: region / name / size required.
 *   - digitalocean_domain: name required; ip_address optional (skipped —
 *     it only seeds an initial A record at create time).
 *   - digitalocean_record: type / domain / name / value required; ttl,
 *     priority, port, weight, flags, tag per record type.
 * The API token is always emitted as `var.do_token` — never inlined.
 */
export const digitaloceanTerraformExport: TerraformExportCapability = {
  provider: { name: "digitalocean", source: "digitalocean/digitalocean", version: "~> 2.0" },
  providerConfig: { token: tf.ref("var.do_token") },
  variables: [
    {
      name: "do_token",
      description: "DigitalOcean personal access token",
      sensitive: true,
    },
  ],
  supportedResourceTypeIds: ["droplet", "volume", "domain", "dns-record"],
  mapResource(resource): TerraformExportResult | null {
    switch (resource.resourceTypeId) {
      case "droplet": {
        const name = fieldString(resource, "name") || resource.displayName;
        const size = fieldString(resource, "size");
        const image = fieldString(resource, "image");
        if (!name || !size || !image) return null;
        const attributes: Record<string, TerraformValue> = {
          name: tf.str(name),
          size: tf.str(size),
          image: tf.str(image),
        };
        const region = fieldString(resource, "region");
        if (region) attributes["region"] = tf.str(region);
        return {
          resource: {
            type: "digitalocean_droplet",
            name,
            attributes,
            importId: resource.externalId,
            comments: [
              "`image` is the image the droplet was created from; applying a changed",
              "image forces a replacement, not an in-place rebuild.",
            ],
          },
        };
      }
      case "volume": {
        const name = fieldString(resource, "name") || resource.displayName;
        const region = fieldString(resource, "region");
        const size = fieldNumber(resource, "sizeGb");
        if (!name || !region || size === undefined) return null;
        const attributes: Record<string, TerraformValue> = {
          name: tf.str(name),
          region: tf.str(region),
          size: tf.num(size),
        };
        const fsType = fieldString(resource, "filesystemType");
        if (fsType) attributes["initial_filesystem_type"] = tf.str(fsType);
        const comments: string[] = [];
        const dropletIds = fieldString(resource, "dropletIds");
        if (dropletIds) {
          comments.push(
            `Currently attached to droplet(s) ${dropletIds} — model attachments with`,
            "digitalocean_volume_attachment resources (or volume_ids on the droplet).",
          );
        }
        return {
          resource: {
            type: "digitalocean_volume",
            name,
            attributes,
            importId: resource.externalId,
            ...(comments.length > 0 ? { comments } : {}),
          },
        };
      }
      case "domain": {
        const name = fieldString(resource, "name") || resource.displayName;
        if (!name) return null;
        return {
          resource: {
            type: "digitalocean_domain",
            name,
            attributes: { name: tf.str(name) },
            importId: name,
          },
        };
      }
      case "dns-record": {
        // externalId is `${domainName}/${recordId}`.
        const [domainFromId, recordId] = (resource.externalId ?? "").split("/");
        const domain = fieldString(resource, "domainName") || domainFromId || "";
        const type = fieldString(resource, "type");
        const storedName = fieldString(resource, "name");
        const name = relativeDnsRecordName(storedName, domain);
        const value = fieldString(resource, "data");
        if (!domain || !type || !storedName || !value) return null;
        const attributes: Record<string, TerraformValue> = {
          domain: tf.str(domain),
          type: tf.str(type),
          name: tf.str(name),
          value: tf.str(value),
        };
        const ttl = fieldNumber(resource, "ttl");
        if (ttl !== undefined) attributes["ttl"] = tf.num(ttl);
        const priority = fieldNumber(resource, "priority");
        if (priority !== undefined && (type === "MX" || type === "SRV"))
          attributes["priority"] = tf.num(priority);
        if (type === "SRV") {
          const port = fieldNumber(resource, "port");
          if (port !== undefined) attributes["port"] = tf.num(port);
          const weight = fieldNumber(resource, "weight");
          if (weight !== undefined) attributes["weight"] = tf.num(weight);
        }
        if (type === "CAA") {
          const flags = fieldNumber(resource, "flags");
          if (flags !== undefined) attributes["flags"] = tf.num(flags);
          const tag = fieldString(resource, "tag");
          if (tag) attributes["tag"] = tf.str(tag);
        }
        return {
          resource: {
            type: "digitalocean_record",
            name: `${domain} ${type} ${name}`,
            attributes,
            ...(recordId ? { importId: `${domain},${recordId}` } : {}),
          },
        };
      }
      default:
        return null;
    }
  },
};
