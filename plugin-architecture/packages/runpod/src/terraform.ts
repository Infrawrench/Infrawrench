import type {
  TerraformExportCapability,
  TerraformExportResult,
  TerraformValue,
} from "@infrawrench/plugin-base";
import { fieldNumber, fieldString, tf } from "@infrawrench/plugin-base";
import { splitList } from "./mappers.js";

/**
 * Terraform mapping for Runpod: provider `runpod/runpod` 2.x, the first that speaks
 * REST v2; 1.x calls REST v1 and stops working when v1 is retired. Attribute names
 * verified against the provider's `docs/resources` at v2.0.0 (2026-11). The provider
 * reads `RUNPOD_API_KEY` from the environment, so the provider block is empty and
 * nothing secret is written.
 *
 * Everything imports by id except registry credentials, whose username and password
 * the API never returns, so applying that block creates a new credential.
 */

const NO_IMPORT = [
  "The runpod/runpod provider cannot import registry credentials: applying this",
  "creates a new one. Delete the original afterwards if you are migrating.",
];

// An imported pod is replaced for each create-time attribute the read does not return
// (template_id, data_center_ids, start_ssh and so on), so none of those are written.
const POD_IMPORT = [
  "Check `terraform plan` shows no replacement before applying: replacing a pod",
  "destroys it. Environment variable values are not synced. If you add `env`, list",
  "every key: the first apply removes any it leaves out.",
];

function list(value: string): TerraformValue {
  return tf.list(splitList(value).map((v) => tf.str(v)));
}

function persistentVolume(size: number, path: string): TerraformValue {
  return tf.map({ size: tf.num(size), path: tf.str(path || "/workspace") });
}

/** `cpu5c:4, cpu5g:8`, as the mapper writes it. */
function cpuConfigs(value: string): TerraformValue {
  return tf.list(
    splitList(value).map((config) => {
      const [id = "", vcpus = ""] = config.split(":");
      return tf.map({ cpu_type_id: tf.str(id), vcpu_count: tf.num(Number(vcpus)) });
    }),
  );
}

export const runpodTerraformExport: TerraformExportCapability = {
  provider: { name: "runpod", source: "runpod/runpod", version: "~> 2.0" },
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
        const storage = fieldString(resource, "storageType");
        return {
          resource: {
            type: "runpod_network_volume",
            name,
            attributes: {
              name: tf.str(name),
              size: tf.num(size),
              data_center: tf.str(region),
              ...(storage ? { type: tf.str(storage) } : {}),
            },
            importId: resource.externalId,
          },
        };
      }
      case "template": {
        const image = fieldString(resource, "imageName");
        if (!image) return null;
        const ports = fieldString(resource, "ports");
        const category = fieldString(resource, "category");
        const auth = fieldString(resource, "containerRegistryAuthId");
        const volume = fieldNumber(resource, "volumeGb");
        return {
          resource: {
            type: "runpod_template",
            name,
            attributes: {
              name: tf.str(name),
              image: tf.str(image),
              serverless: tf.bool(resource.fields["isServerless"] === true),
              ...(category ? { category: tf.str(category) } : {}),
              disk: tf.num(fieldNumber(resource, "containerDiskGb") ?? 0),
              ...(volume
                ? {
                    persistent_volume: persistentVolume(
                      volume,
                      fieldString(resource, "volumeMountPath"),
                    ),
                  }
                : {}),
              ...(ports ? { ports: list(ports) } : {}),
              ...(auth ? { registry: tf.str(auth) } : {}),
            },
            importId: resource.externalId,
            comments: ["Environment variable values are not synced: add `env = { ... }` by hand."],
          },
        };
      }
      case "serverless-endpoint": {
        const image = fieldString(resource, "imageName");
        const routing = fieldString(resource, "endpointType");
        const scaler = fieldString(resource, "scalerType");
        // Runpod keeps no template link on an endpoint. A resource not synced since the
        // move to REST v2 has none of these, and the provider requires them.
        if (!image || !routing || !scaler) return null;
        const pools = fieldString(resource, "gpuPools");
        const cpus = fieldString(resource, "cpuConfigs");
        const dcs = fieldString(resource, "dataCenters");
        const volume = fieldString(resource, "networkVolumeId");
        const flashboot = fieldString(resource, "flashboot");
        const idle = fieldNumber(resource, "idleTimeout");
        return {
          resource: {
            type: "runpod_serverless_endpoint",
            name,
            attributes: {
              name: tf.str(name),
              endpoint_type: tf.str(routing),
              image: tf.str(image),
              ...(pools ? { gpu_pools: list(pools) } : {}),
              ...(pools ? { gpu_count: tf.num(fieldNumber(resource, "gpuCount") ?? 1) } : {}),
              ...(cpus ? { cpu: cpuConfigs(cpus) } : {}),
              workers_min: tf.num(fieldNumber(resource, "workersMin") ?? 0),
              workers_max: tf.num(fieldNumber(resource, "workersMax") ?? 1),
              ...(idle ? { idle_timeout: tf.num(idle) } : {}),
              scaling_type: tf.str(scaler),
              scaling_value: tf.num(fieldNumber(resource, "scalerValue") ?? 4),
              ...(flashboot ? { flashboot: tf.str(flashboot) } : {}),
              ...(dcs ? { data_center_ids: list(dcs) } : {}),
              ...(volume ? { network_volumes: tf.list([tf.str(volume)]) } : {}),
            },
            importId: resource.externalId,
            comments: ["Environment variable values are not synced: add `env = { ... }` by hand."],
          },
        };
      }
      case "pod": {
        const image = fieldString(resource, "imageName");
        if (!image) return null;
        const gpu = fieldString(resource, "gpuTypeId");
        const flavor = fieldString(resource, "cpuFlavorId");
        const ports = fieldString(resource, "ports");
        const mount = fieldString(resource, "volumeMountPath");
        const volume = fieldString(resource, "networkVolumeId");
        const disk = fieldNumber(resource, "volumeGb");
        const cloud = fieldString(resource, "cloudType");
        const more = fieldString(resource, "additionalNetworkVolumes");
        return {
          resource: {
            type: "runpod_pod",
            name,
            attributes: {
              name: tf.str(name),
              image: tf.str(image),
              ...(gpu ? { gpu_type_id: tf.str(gpu) } : {}),
              ...(gpu ? { gpu_count: tf.num(fieldNumber(resource, "gpuCount") ?? 1) } : {}),
              ...(!gpu && flavor ? { cpu_type_id: tf.str(flavor) } : {}),
              ...(!gpu && flavor
                ? { vcpu_count: tf.num(fieldNumber(resource, "vcpus") ?? 2) }
                : {}),
              ...(cloud
                ? { cloud: tf.str(cloud.startsWith("Community") ? "COMMUNITY" : "SECURE") }
                : {}),
              disk: tf.num(fieldNumber(resource, "containerDiskGb") ?? 0),
              ...(disk ? { persistent_volume: persistentVolume(disk, mount) } : {}),
              ...(volume
                ? {
                    network_volumes: tf.list([
                      tf.map({ volume_id: tf.str(volume), path: tf.str(mount || "/workspace") }),
                    ]),
                  }
                : {}),
              ...(ports ? { ports: list(ports) } : {}),
            },
            importId: resource.externalId,
            comments: [
              ...POD_IMPORT,
              ...(more ? [`Also mounts ${more}: add them to \`network_volumes\` by hand.`] : []),
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
            type: "runpod_registry",
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
