import type {
  TerraformExportCapability,
  TerraformExportResult,
  TerraformValue,
} from "@infrawrench/plugin-base";
import { fieldNumber, fieldString, tf } from "@infrawrench/plugin-base";
import { splitList } from "./mappers.js";

/**
 * Terraform mapping for Runpod: provider `runpod/runpod` (Runpod's own,
 * community tier on the Registry, v1.0.9). Attribute names verified against
 * the provider's generated schemas (`runpod/terraform-provider-runpod`,
 * `internal/provider/resource_*\/*_resource_gen.go`, 2026-10). The provider
 * reads `RUNPOD_API_KEY` from the environment, so the provider block is empty
 * and nothing secret is written.
 *
 * None of the provider's resources implement `ImportState`, so no import id
 * is emitted: applying the export creates new objects alongside the live
 * ones. Every block says so.
 */

const NO_IMPORT = [
  "The runpod/runpod provider cannot import existing objects: applying this",
  "creates a new one. Delete the original afterwards if you are migrating.",
];

function list(value: string): TerraformValue {
  return tf.list(splitList(value).map((v) => tf.str(v)));
}

export const runpodTerraformExport: TerraformExportCapability = {
  provider: { name: "runpod", source: "runpod/runpod", version: "~> 1.0" },
  providerConfig: {},
  variables: [],
  supportedResourceTypeIds: [
    "pod",
    "serverless-endpoint",
    "template",
    "network-volume",
    "container-registry-auth",
  ],
  mapResource(resource): TerraformExportResult | null {
    const name = fieldString(resource, "name") || resource.displayName;
    switch (resource.resourceTypeId) {
      case "network-volume": {
        const size = fieldNumber(resource, "sizeGb");
        const region = fieldString(resource, "region");
        if (!size || !region) return null;
        return {
          resource: {
            type: "runpod_network_volume",
            name,
            attributes: {
              name: tf.str(name),
              size: tf.num(size),
              data_center_id: tf.str(region),
            },
            comments: NO_IMPORT,
          },
        };
      }
      case "template": {
        const image = fieldString(resource, "imageName");
        if (!image) return null;
        const ports = fieldString(resource, "ports");
        const mount = fieldString(resource, "volumeMountPath");
        const category = fieldString(resource, "category");
        const auth = fieldString(resource, "containerRegistryAuthId");
        return {
          resource: {
            type: "runpod_template",
            name,
            attributes: {
              name: tf.str(name),
              image_name: tf.str(image),
              is_serverless: tf.bool(resource.fields["isServerless"] === true),
              ...(category ? { category: tf.str(category) } : {}),
              container_disk_in_gb: tf.num(fieldNumber(resource, "containerDiskGb") ?? 0),
              volume_in_gb: tf.num(fieldNumber(resource, "volumeGb") ?? 0),
              ...(mount ? { volume_mount_path: tf.str(mount) } : {}),
              ...(ports ? { ports: list(ports) } : {}),
              ...(auth ? { container_registry_auth_id: tf.str(auth) } : {}),
            },
            comments: [
              ...NO_IMPORT,
              "Environment variable values are not synced: add `env = { ... }` by hand.",
            ],
          },
        };
      }
      case "serverless-endpoint": {
        const template = fieldString(resource, "templateId");
        if (!template) return null;
        const gpuTypes = fieldString(resource, "gpuTypeIds");
        const dcs = fieldString(resource, "dataCenters");
        const volume = fieldString(resource, "networkVolumeId");
        const scaler = fieldString(resource, "scalerType");
        const cpu = fieldString(resource, "computeType") === "CPU";
        return {
          resource: {
            type: "runpod_endpoint",
            name,
            attributes: {
              name: tf.str(name),
              template_id: tf.str(template),
              compute_type: tf.str(cpu ? "CPU" : "GPU"),
              ...(gpuTypes && !cpu ? { gpu_type_ids: list(gpuTypes) } : {}),
              ...(!cpu ? { gpu_count: tf.num(fieldNumber(resource, "gpuCount") ?? 1) } : {}),
              workers_min: tf.num(fieldNumber(resource, "workersMin") ?? 0),
              workers_max: tf.num(fieldNumber(resource, "workersMax") ?? 1),
              idle_timeout: tf.num(fieldNumber(resource, "idleTimeout") ?? 5),
              ...(scaler ? { scaler_type: tf.str(scaler) } : {}),
              ...(scaler
                ? { scaler_value: tf.num(fieldNumber(resource, "scalerValue") ?? 4) }
                : {}),
              flashboot: tf.bool(resource.fields["flashboot"] === true),
              ...(dcs ? { data_center_ids: list(dcs) } : {}),
              ...(volume ? { network_volume_id: tf.str(volume) } : {}),
            },
            comments: NO_IMPORT,
          },
        };
      }
      case "pod": {
        const image = fieldString(resource, "imageName");
        const gpu = fieldString(resource, "gpuTypeId");
        if (!image) return null;
        const ports = fieldString(resource, "ports");
        const mount = fieldString(resource, "volumeMountPath");
        const template = fieldString(resource, "templateId");
        const volume = fieldString(resource, "networkVolumeId");
        const cloud = fieldString(resource, "cloudType");
        return {
          resource: {
            type: "runpod_pod",
            name,
            attributes: {
              name: tf.str(name),
              image_name: tf.str(image),
              ...(gpu ? { gpu_type_id: tf.str(gpu) } : {}),
              ...(gpu ? { gpu_count: tf.num(fieldNumber(resource, "gpuCount") ?? 1) } : {}),
              ...(cloud
                ? { cloud_type: tf.str(cloud.startsWith("Community") ? "COMMUNITY" : "SECURE") }
                : {}),
              container_disk_in_gb: tf.num(fieldNumber(resource, "containerDiskGb") ?? 0),
              volume_in_gb: tf.num(fieldNumber(resource, "volumeGb") ?? 0),
              ...(mount ? { volume_mount_path: tf.str(mount) } : {}),
              // The provider takes ports as one comma-separated string.
              ...(ports ? { ports: tf.str(splitList(ports).join(",")) } : {}),
              ...(template ? { template_id: tf.str(template) } : {}),
              ...(volume ? { network_volume_id: tf.str(volume) } : {}),
              ...(resource.fields["interruptible"] === true
                ? { interruptible: tf.bool(true) }
                : {}),
            },
            comments: [
              ...NO_IMPORT,
              'Environment variable values are not synced: add `env = ["KEY=value"]` by hand.',
            ],
          },
        };
      }
      case "container-registry-auth": {
        const variable = `runpod_registry_password_${resource.externalId ?? "auth"}`
          .toLowerCase()
          .replace(/[^a-z0-9_]/g, "_");
        return {
          resource: {
            type: "runpod_container_registry_auth",
            name,
            attributes: {
              name: tf.str(name),
              username: tf.ref(`var.${variable}_username`),
              password: tf.ref(`var.${variable}`),
            },
            comments: NO_IMPORT,
          },
          variables: [
            { name: `${variable}_username`, description: `Registry username for "${name}"` },
            {
              name: variable,
              description: `Registry password or token for "${name}"`,
              sensitive: true,
            },
          ],
        };
      }
      default:
        return null;
    }
  },
};
