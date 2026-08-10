import type {
  ResourceInstance,
  TerraformExportCapability,
  TerraformExportResult,
  TerraformValue,
} from "@infrawrench/plugin-base";
import { fieldNumber, fieldString, tf } from "@infrawrench/plugin-base";

/** Build Scaleway RDB `engine` slug (`PostgreSQL-16`) from stored fields. */
function scalewayRdbEngine(resource: ResourceInstance): string | null {
  const engine = fieldString(resource, "engine");
  const version = fieldString(resource, "engineVersion");
  if (!engine) return null;
  if (version) return `${engine}-${version}`;
  return engine;
}

/**
 * Terraform mapping for Scaleway — provider `scaleway/scaleway`.
 * Attribute names verified against the provider docs
 * (registry.terraform.io/providers/scaleway/scaleway):
 *   - scaleway_instance_server: `type`, `image` required; `zone`, `name` optional.
 *   - scaleway_block_volume: `size_in_gb`, `iops` required; `name`, `zone` optional.
 *   - scaleway_object_bucket: `name` required; `region` optional.
 *   - scaleway_rdb_instance: `name`, `node_type`, `engine` required.
 *   - scaleway_k8s_cluster: `name`, `version` required; `region` optional.
 * Zonal/regional import IDs use `{zone|region}/{id}` — matches externalId.
 * Credentials: access_key, secret_key, project_id as variables.
 */
export const scalewayTerraformExport: TerraformExportCapability = {
  provider: { name: "scaleway", source: "scaleway/scaleway", version: "~> 2.0" },
  providerConfig: {
    access_key: tf.ref("var.scaleway_access_key"),
    secret_key: tf.ref("var.scaleway_secret_key"),
    project_id: tf.ref("var.scaleway_project_id"),
  },
  variables: [
    {
      name: "scaleway_access_key",
      description: "Scaleway access key (SCW…)",
    },
    {
      name: "scaleway_secret_key",
      description: "Scaleway secret key",
      sensitive: true,
    },
    {
      name: "scaleway_project_id",
      description: "Scaleway project ID (UUID)",
    },
  ],
  supportedResourceTypeIds: [
    "instance",
    "block-volume",
    "object-storage-bucket",
    "rdb-instance",
    "kapsule-cluster",
  ],
  mapResource(resource): TerraformExportResult | null {
    switch (resource.resourceTypeId) {
      case "instance": {
        const name = fieldString(resource, "name") || resource.displayName;
        const serverType = fieldString(resource, "commercialType");
        const image = fieldString(resource, "image");
        if (!name || !serverType || !image) return null;
        const attributes: Record<string, TerraformValue> = {
          name: tf.str(name),
          type: tf.str(serverType),
          image: tf.str(image),
        };
        const zone = fieldString(resource, "zone");
        if (zone) attributes["zone"] = tf.str(zone);
        return {
          resource: {
            type: "scaleway_instance_server",
            name,
            attributes,
            importId: resource.externalId,
            comments: [
              "`image` is the image label/id at create time; changing it forces replacement.",
            ],
          },
        };
      }
      case "block-volume": {
        const name = fieldString(resource, "name") || resource.displayName;
        const zone = fieldString(resource, "zone");
        const sizeGb = fieldNumber(resource, "sizeGb");
        if (!name || !zone || sizeGb === undefined) return null;
        const attributes: Record<string, TerraformValue> = {
          name: tf.str(name),
          zone: tf.str(zone),
          size_in_gb: tf.num(sizeGb),
          iops: tf.num(Number(fieldString(resource, "perfIops") ?? "5000")),
        };
        const comments: string[] = [];
        const attached = fieldString(resource, "attachedInstanceId");
        if (attached) {
          comments.push(
            `Attached to instance ${zone}/${attached} — add scaleway_instance_server`,
            "additional_volume_ids or a separate attachment resource.",
          );
        }
        return {
          resource: {
            type: "scaleway_block_volume",
            name,
            attributes,
            importId: resource.externalId,
            ...(comments.length > 0 ? { comments } : {}),
          },
        };
      }
      case "object-storage-bucket": {
        const name = fieldString(resource, "name") || resource.displayName;
        if (!name) return null;
        const attributes: Record<string, TerraformValue> = { name: tf.str(name) };
        const region = fieldString(resource, "region");
        if (region) attributes["region"] = tf.str(region);
        return {
          resource: {
            type: "scaleway_object_bucket",
            name,
            attributes,
            importId: resource.externalId ?? name,
          },
        };
      }
      case "rdb-instance": {
        const name = fieldString(resource, "name") || resource.displayName;
        const nodeType = fieldString(resource, "nodeType");
        const engine = scalewayRdbEngine(resource);
        if (!name || !nodeType || !engine) return null;
        const attributes: Record<string, TerraformValue> = {
          name: tf.str(name),
          node_type: tf.str(nodeType),
          engine: tf.str(engine),
          user_name: tf.ref("var.scaleway_rdb_user"),
          password: tf.ref("var.scaleway_rdb_password"),
        };
        const region = fieldString(resource, "region");
        if (region) attributes["region"] = tf.str(region);
        return {
          resource: {
            type: "scaleway_rdb_instance",
            name,
            attributes,
            importId: resource.externalId,
            comments: [
              "Initial user/password are required by the provider but not stored",
              "by Infrawrench — set var.scaleway_rdb_user / var.scaleway_rdb_password.",
            ],
          },
          variables: [
            {
              name: "scaleway_rdb_user",
              description: "Initial RDB admin username for imported instances",
            },
            {
              name: "scaleway_rdb_password",
              description: "Initial RDB admin password for imported instances",
              sensitive: true,
            },
          ],
        };
      }
      case "kapsule-cluster": {
        const name = fieldString(resource, "name") || resource.displayName;
        const version = fieldString(resource, "version");
        if (!name || !version) return null;
        const attributes: Record<string, TerraformValue> = {
          name: tf.str(name),
          version: tf.str(version),
        };
        const region = fieldString(resource, "region");
        if (region) attributes["region"] = tf.str(region);
        const comments = [
          "Node pools are separate scaleway_k8s_pool resources — recreate pools",
          "from nodeType/nodeCount/diskSizeGb fields after importing the cluster.",
        ];
        return {
          resource: {
            type: "scaleway_k8s_cluster",
            name,
            attributes,
            importId: resource.externalId,
            comments,
          },
        };
      }
      default:
        return null;
    }
  },
};
