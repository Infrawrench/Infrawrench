import type {
  TerraformExportCapability,
  TerraformExportResult,
  TerraformValue,
} from "@infrawrench/plugin-base";
import { fieldNumber, fieldString, tf } from "@infrawrench/plugin-base";
import { DATACENTER, LIBRARY, RESOURCE_POOL, TAG, TAG_CATEGORY } from "./resources.js";

/**
 * Terraform mapping for `vmware/vsphere` (the provider VMware maintains, the
 * successor of hashicorp/vsphere; 2.17.x in 2026-10). Arguments and import ids
 * checked against its docs/resources pages:
 * - vsphere_tag_category: name, cardinality, associable_types, description; import by name.
 * - vsphere_tag: name, category_id, description; import `{"category_name":..,"tag_name":..}`.
 * - vsphere_content_library: name, description, storage_backing (datastore ids); import by id.
 * - vsphere_datacenter: name; import `/name` (root folder only).
 * - vsphere_resource_pool: name, parent_resource_pool_id, CPU and memory allocation; import needs the
 *   inventory path, which the REST API does not return, so no import id is emitted.
 * VMs are not exported: vsphere_virtual_machine needs disks, NICs and a datastore layout the
 * inventory only partly stores, and an inventory path for import.
 */
export const vsphereTerraformExport: TerraformExportCapability = {
  provider: { name: "vsphere", source: "vmware/vsphere", version: "~> 2.17" },
  providerConfig: {
    vsphere_server: tf.ref("var.vsphere_server"),
    user: tf.ref("var.vsphere_user"),
    password: tf.ref("var.vsphere_password"),
  },
  variables: [
    { name: "vsphere_server", description: "vCenter Server hostname" },
    { name: "vsphere_user", description: "vCenter SSO user" },
    { name: "vsphere_password", description: "vCenter SSO password", sensitive: true },
  ],
  supportedResourceTypeIds: [TAG_CATEGORY, TAG, LIBRARY, DATACENTER, RESOURCE_POOL],
  mapResource(resource): TerraformExportResult | null {
    const name = fieldString(resource, "name") || resource.displayName;
    switch (resource.resourceTypeId) {
      case TAG_CATEGORY: {
        const types = fieldString(resource, "associableTypes")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        return {
          resource: {
            type: "vsphere_tag_category",
            name,
            attributes: {
              name: tf.str(name),
              cardinality: tf.str(fieldString(resource, "cardinality") || "SINGLE"),
              associable_types: tf.list(types.map((t) => tf.str(t))),
              ...(fieldString(resource, "description")
                ? { description: tf.str(fieldString(resource, "description")) }
                : {}),
            },
            importId: name,
          },
        };
      }
      case TAG: {
        const category = fieldString(resource, "categoryId");
        if (!category) return null;
        const categoryName = fieldString(resource, "categoryName");
        return {
          resource: {
            type: "vsphere_tag",
            name,
            attributes: {
              name: tf.str(name),
              category_id: tf.str(category),
              ...(fieldString(resource, "description")
                ? { description: tf.str(fieldString(resource, "description")) }
                : {}),
            },
            importId: categoryName
              ? JSON.stringify({ category_name: categoryName, tag_name: name })
              : undefined,
          },
        };
      }
      case LIBRARY: {
        if (fieldString(resource, "type") === "SUBSCRIBED") return null;
        const ds = fieldString(resource, "datastoreIds")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        if (ds.length === 0) return null;
        return {
          resource: {
            type: "vsphere_content_library",
            name,
            attributes: {
              name: tf.str(name),
              storage_backing: tf.list(ds.map((d) => tf.str(d))),
              ...(fieldString(resource, "description")
                ? { description: tf.str(fieldString(resource, "description")) }
                : {}),
            },
            importId: resource.externalId,
          },
        };
      }
      case DATACENTER:
        return {
          resource: {
            type: "vsphere_datacenter",
            name,
            attributes: { name: tf.str(name) },
            importId: `/${name}`,
          },
        };
      case RESOURCE_POOL: {
        const parent = fieldString(resource, "parentId");
        if (!parent) return null;
        const attributes: Record<string, TerraformValue> = {
          name: tf.str(name),
          parent_resource_pool_id: tf.str(parent),
        };
        const nums: Array<[string, string]> = [
          ["cpuReservationMhz", "cpu_reservation"],
          ["cpuLimitMhz", "cpu_limit"],
          ["memoryReservationMb", "memory_reservation"],
          ["memoryLimitMb", "memory_limit"],
        ];
        for (const [k, a] of nums) {
          const n = fieldNumber(resource, k);
          if (n !== undefined) attributes[a] = tf.num(n);
        }
        const cs = fieldString(resource, "cpuShares");
        if (cs) attributes["cpu_share_level"] = tf.str(cs.toLowerCase());
        const ms = fieldString(resource, "memoryShares");
        if (ms) attributes["memory_share_level"] = tf.str(ms.toLowerCase());
        return {
          resource: {
            type: "vsphere_resource_pool",
            name,
            attributes,
            comments: [
              "Import with: terraform import <address> /<datacenter>/host/<cluster>/Resources/<pool path>",
            ],
          },
        };
      }
      default:
        return null;
    }
  },
};
