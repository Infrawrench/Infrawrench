import type {
  TerraformExportCapability,
  TerraformExportResult,
  TerraformValue,
} from "@infrawrench/plugin-base";
import { fieldNumber, fieldString, tf } from "@infrawrench/plugin-base";

/** Strip trailing AZ digits from regions like GRA11 → GRA for object storage. */
function ovhStorageRegion(region: string): string {
  const match = /^([A-Za-z]+)\d+$/.exec(region);
  return match?.[1]?.toUpperCase() ?? region.toUpperCase();
}

/**
 * Terraform mapping for OVHcloud — provider `ovh/ovh`.
 * Attribute names verified against the provider docs
 * (registry.terraform.io/providers/ovh/ovh):
 *   - ovh_cloud_instance: `service_name`, `region`, `name`, `flavor_id`, `image_id`.
 *   - ovh_cloud_storage_block_volume: `service_name`, `name`, `size`, `region`.
 *   - ovh_cloud_project_network_private: `service_name`, `name`, `regions`.
 *   - ovh_cloud_project_database: `service_name`, `engine`, `version`, `plan`, `nodes`.
 *   - ovh_cloud_project_storage: `service_name`, `region_name`, `name`.
 * Floating IPs are skipped — stored externalId is `{region}/{id}` but the provider
 * resource expects different wiring and we lack OpenStack subnet/network ids.
 * Instances skip when only human-readable flavor/image names are stored (no ids).
 * Credentials map to the standard OVH API triplet + project service_name.
 */
export const ovhTerraformExport: TerraformExportCapability = {
  provider: { name: "ovh", source: "ovh/ovh", version: "~> 2.0" },
  providerConfig: {
    application_key: tf.ref("var.ovh_application_key"),
    application_secret: tf.ref("var.ovh_application_secret"),
    consumer_key: tf.ref("var.ovh_consumer_key"),
    endpoint: tf.ref("var.ovh_endpoint"),
  },
  variables: [
    { name: "ovh_application_key", description: "OVHcloud API application key (AK)" },
    {
      name: "ovh_application_secret",
      description: "OVHcloud API application secret (AS)",
      sensitive: true,
    },
    {
      name: "ovh_consumer_key",
      description: "OVHcloud API consumer key (CK)",
      sensitive: true,
    },
    {
      name: "ovh_endpoint",
      description: "OVHcloud API endpoint: ovh-eu, ovh-ca, or ovh-us",
    },
    {
      name: "ovh_project_id",
      description: "OVHcloud Public Cloud project ID (service_name)",
    },
  ],
  supportedResourceTypeIds: [
    "instance",
    "volume",
    "private-network",
    "managed-db",
    "object-storage-bucket",
  ],
  mapResource(resource): TerraformExportResult | null {
    switch (resource.resourceTypeId) {
      case "instance": {
        // ovh_cloud_instance requires flavor_id + image_id; we only store names.
        const name = fieldString(resource, "name") || resource.displayName;
        const region = fieldString(resource, "region");
        const flavorName = fieldString(resource, "flavorName");
        const imageName = fieldString(resource, "imageName");
        if (!name || !region || !flavorName || !imageName) return null;
        return {
          resource: {
            type: "ovh_cloud_instance",
            name,
            attributes: {
              service_name: tf.ref("var.ovh_project_id"),
              region: tf.str(region),
              name: tf.str(name),
              flavor_id: tf.ref("var.ovh_instance_flavor_id"),
              image_id: tf.ref("var.ovh_instance_image_id"),
            },
            importId: `${resource.externalId}`,
            comments: [
              `Resolve flavor \"${flavorName}\" and image \"${imageName}\" via`,
              "ovh_cloud_instance_flavors / ovh_cloud_instance_images data sources,",
              "then set var.ovh_instance_flavor_id and var.ovh_instance_image_id.",
              "Import format: service_name/region/instance_id.",
            ],
          },
          variables: [
            {
              name: "ovh_instance_flavor_id",
              description: `Flavor id for ${flavorName} in ${region}`,
            },
            {
              name: "ovh_instance_image_id",
              description: `Image id for ${imageName} in ${region}`,
            },
          ],
        };
      }
      case "volume": {
        const name = fieldString(resource, "name") || resource.displayName;
        const region = fieldString(resource, "region");
        const sizeGb = fieldNumber(resource, "sizeGb");
        if (!name || !region || sizeGb === undefined) return null;
        const volumeType = (fieldString(resource, "type") ?? "classic")
          .toUpperCase()
          .replace(/-/g, "_");
        const attributes: Record<string, TerraformValue> = {
          service_name: tf.ref("var.ovh_project_id"),
          name: tf.str(name),
          region: tf.str(region),
          size: tf.num(sizeGb),
          volume_type: tf.str(volumeType === "CLASSIC" ? "CLASSIC" : volumeType),
        };
        return {
          resource: {
            type: "ovh_cloud_storage_block_volume",
            name,
            attributes,
            importId: resource.externalId,
            comments: ["Import id: service_name/volume_id"],
          },
        };
      }
      case "private-network": {
        const name = fieldString(resource, "name") || resource.displayName;
        if (!name) return null;
        const attributes: Record<string, TerraformValue> = {
          service_name: tf.ref("var.ovh_project_id"),
          name: tf.str(name),
        };
        const regionsRaw = fieldString(resource, "regions");
        if (regionsRaw) {
          const regions = regionsRaw.split(/[,;\s]+/).filter(Boolean);
          if (regions.length > 0) {
            attributes["regions"] = tf.list(regions.map((r) => tf.str(r)));
          }
        }
        const vlanId = fieldNumber(resource, "vlanId");
        if (vlanId !== undefined) attributes["vlan_id"] = tf.num(vlanId);
        return {
          resource: {
            type: "ovh_cloud_project_network_private",
            name,
            attributes,
            importId: resource.externalId,
            comments: [
              "Import format: service_name/network_id — prepend var.ovh_project_id if needed.",
            ],
          },
        };
      }
      case "managed-db": {
        const description = fieldString(resource, "description") || resource.displayName;
        const engine = fieldString(resource, "engine");
        const version = fieldString(resource, "version");
        const plan = fieldString(resource, "plan");
        const region = fieldString(resource, "region");
        const flavor = fieldString(resource, "flavor");
        const nodeCount = fieldNumber(resource, "nodeCount") ?? 1;
        if (!engine || !version || !plan || !region || !flavor) return null;
        return {
          resource: {
            type: "ovh_cloud_project_database",
            name: description || engine,
            attributes: {
              service_name: tf.ref("var.ovh_project_id"),
              description: tf.str(description),
              engine: tf.str(engine),
              version: tf.str(version),
              plan: tf.str(plan),
              flavor: tf.str(flavor),
              nodes: tf.list([
                tf.map({
                  region: tf.str(region),
                }),
              ]),
            },
            importId: resource.externalId,
            ...(nodeCount > 1
              ? {
                  comments: [
                    `Cluster has ${nodeCount} nodes — expand the nodes list to match`,
                    "each node's region/flavor in the OVH control panel.",
                  ],
                }
              : {}),
          },
        };
      }
      case "object-storage-bucket": {
        const name = fieldString(resource, "name") || resource.displayName;
        const region = fieldString(resource, "region");
        if (!name || !region) return null;
        return {
          resource: {
            type: "ovh_cloud_project_storage",
            name,
            attributes: {
              service_name: tf.ref("var.ovh_project_id"),
              region_name: tf.str(ovhStorageRegion(region)),
              name: tf.str(name),
            },
            comments: [
              region !== ovhStorageRegion(region)
                ? `Stored region ${region} mapped to region_name ${ovhStorageRegion(region)} for S3 API.`
                : undefined,
            ].filter(Boolean) as string[],
          },
        };
      }
      default:
        return null;
    }
  },
};
