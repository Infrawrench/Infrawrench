import type {
  TerraformExportCapability,
  TerraformExportResult,
  TerraformValue,
} from "@infrawrench/plugin-base";
import { fieldBool, fieldNumber, fieldString, tf } from "@infrawrench/plugin-base";

/**
 * Terraform mapping for Fly.io — community provider `stategraph/fly`.
 * Attribute names verified against the provider docs
 * (registry.terraform.io/providers/stategraph/fly):
 *   - fly_app: `name` required; `org_slug` optional.
 *   - fly_machine: `app`, `region`, `image` required; `name` optional.
 *   - fly_volume: `app`, `name`, `region`, `size_gb` required.
 *   - fly_certificate: `app`, `hostname` required.
 * Import IDs: app by name; machine/volume `appName/id`; certificate `appName/hostname`.
 * IP allocations are skipped — the provider imports `fly_ip_address` by Fly ip id,
 * which Infrawrench does not store (only the address string).
 * The API token is `var.fly_api_token`; org slug is `var.fly_org_slug`.
 */
export const flyTerraformExport: TerraformExportCapability = {
  provider: { name: "fly", source: "stategraph/fly", version: "~> 0.2" },
  providerConfig: {
    api_token: tf.ref("var.fly_api_token"),
    org_slug: tf.ref("var.fly_org_slug"),
  },
  variables: [
    {
      name: "fly_api_token",
      description: "Fly.io API token (`fly tokens create` or dashboard → Access Tokens)",
      sensitive: true,
    },
    {
      name: "fly_org_slug",
      description: "Fly.io organization slug (use personal for personal accounts)",
    },
  ],
  supportedResourceTypeIds: ["app", "machine", "volume", "certificate"],
  mapResource(resource): TerraformExportResult | null {
    switch (resource.resourceTypeId) {
      case "app": {
        const name = fieldString(resource, "name") || resource.displayName;
        if (!name) return null;
        const attributes: Record<string, TerraformValue> = {
          name: tf.str(name),
          org_slug: tf.ref("var.fly_org_slug"),
        };
        return {
          resource: {
            type: "fly_app",
            name,
            attributes,
            importId: resource.externalId ?? name,
          },
        };
      }
      case "machine": {
        const app = fieldString(resource, "appName");
        const region = fieldString(resource, "region");
        const image = fieldString(resource, "image");
        if (!app || !region || !image) return null;
        const attributes: Record<string, TerraformValue> = {
          app: tf.str(app),
          region: tf.str(region),
          image: tf.str(image),
        };
        const machineName = fieldString(resource, "name");
        if (machineName) attributes["name"] = tf.str(machineName);
        const comments = [
          "Machine services, mounts, and guest sizing are not reconstructed —",
          "add guest/service/mount blocks manually after import.",
        ];
        return {
          resource: {
            type: "fly_machine",
            name: machineName || `${app} machine`,
            attributes,
            importId: resource.externalId,
            comments,
          },
        };
      }
      case "volume": {
        const app = fieldString(resource, "appName");
        const name = fieldString(resource, "name") || resource.displayName;
        const region = fieldString(resource, "region");
        const sizeGb = fieldNumber(resource, "sizeGb");
        if (!app || !name || !region || sizeGb === undefined) return null;
        const attributes: Record<string, TerraformValue> = {
          app: tf.str(app),
          name: tf.str(name),
          region: tf.str(region),
          size_gb: tf.num(sizeGb),
        };
        if (fieldBool(resource, "encrypted")) attributes["encrypted"] = tf.bool(true);
        const comments: string[] = [];
        const attached = fieldString(resource, "attachedMachineId");
        if (attached) {
          comments.push(
            `Attached to machine ${attached} — model the mount on fly_machine separately`,
            `(mount { volume = fly_volume.${name}.id path = \"…\" }).`,
          );
        }
        return {
          resource: {
            type: "fly_volume",
            name,
            attributes,
            importId: resource.externalId,
            ...(comments.length > 0 ? { comments } : {}),
          },
        };
      }
      case "certificate": {
        const app = fieldString(resource, "appName");
        const hostname = fieldString(resource, "hostname") || resource.displayName;
        if (!app || !hostname) return null;
        return {
          resource: {
            type: "fly_certificate",
            name: hostname,
            attributes: {
              app: tf.str(app),
              hostname: tf.str(hostname),
            },
            importId: resource.externalId ?? `${app}/${hostname}`,
          },
        };
      }
      default:
        return null;
    }
  },
};
