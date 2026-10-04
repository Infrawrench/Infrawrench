import type {
  TerraformExportCapability,
  TerraformExportResult,
  TerraformValue,
} from "@infrawrench/plugin-base";
import { fieldString, tf } from "@infrawrench/plugin-base";
import { parsePrefixes } from "./mappers.js";

/**
 * Terraform mapping for CoreWeave: provider `coreweave/coreweave`.
 *
 * Attribute names verified against the provider reference pages on
 * docs.coreweave.com/platform/terraform (2026-10): `coreweave_cks_cluster`
 * requires `name`, `zone`, `version`, `vpc_id`, `pod_cidr_name`,
 * `service_cidr_name` and `internal_lb_cidr_names` and imports by id;
 * `coreweave_networking_vpc` requires `name` and `zone`, takes `vpc_prefixes`
 * as a set of `{name, value}` and `ingress`/`egress` objects, and imports by
 * id; `coreweave_object_storage_bucket` requires `name` and `zone` and imports
 * by name. The provider reads the token from `COREWEAVE_API_TOKEN`, so no
 * variable is declared for it.
 *
 * Node Pools are Kubernetes objects inside each cluster rather than provider
 * resources, so they are not mapped. A cluster's `vpc_id` becomes a reference
 * when its VPC is in the same export.
 */
export const coreweaveTerraformExport: TerraformExportCapability = {
  provider: { name: "coreweave", source: "coreweave/coreweave", version: "~> 0.24" },
  providerConfig: {},
  variables: [],
  supportedResourceTypeIds: ["cks-cluster", "vpc", "bucket"],
  mapResource(resource): TerraformExportResult | null {
    const name = fieldString(resource, "name") || resource.displayName;
    const zone = fieldString(resource, "zone");
    if (!name || !zone) return null;
    switch (resource.resourceTypeId) {
      case "cks-cluster": {
        const podCidr = fieldString(resource, "podCidrName");
        const serviceCidr = fieldString(resource, "serviceCidrName");
        const vpcId = fieldString(resource, "vpcId");
        const version = fieldString(resource, "version");
        if (!podCidr || !serviceCidr || !vpcId || !version) return null;
        const lbNames = fieldString(resource, "internalLbCidrNames")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        return {
          resource: {
            type: "coreweave_cks_cluster",
            name,
            attributes: {
              name: tf.str(name),
              zone: tf.str(zone),
              version: tf.str(version),
              vpc_id: tf.str(vpcId),
              public: tf.bool(fieldString(resource, "public") === "true"),
              pod_cidr_name: tf.str(podCidr),
              service_cidr_name: tf.str(serviceCidr),
              internal_lb_cidr_names: tf.list(lbNames.map((n) => tf.str(n))),
            },
            importId: resource.externalId ?? "",
            comments: [
              "OIDC, webhook, audit policy and kubelet settings are not carried over.",
              "Import first and review `terraform plan` before applying.",
            ],
          },
        };
      }
      case "vpc": {
        const attributes: Record<string, TerraformValue> = {
          name: tf.str(name),
          zone: tf.str(zone),
        };
        let prefixes: Array<{ name: string; value: string }> = [];
        try {
          prefixes = parsePrefixes(fieldString(resource, "prefixes"));
        } catch {
          prefixes = [];
        }
        if (prefixes.length > 0) {
          attributes["vpc_prefixes"] = tf.list(
            prefixes.map((p) => tf.map({ name: tf.str(p.name), value: tf.str(p.value) })),
          );
        }
        if (fieldString(resource, "disablePublicServices") === "true") {
          attributes["ingress"] = tf.map({ disable_public_services: tf.bool(true) });
        }
        if (fieldString(resource, "disablePublicAccess") === "true") {
          attributes["egress"] = tf.map({ disable_public_access: tf.bool(true) });
        }
        return {
          resource: {
            type: "coreweave_networking_vpc",
            name,
            attributes,
            importId: resource.externalId ?? "",
            comments: [
              "Host prefixes and DHCP settings are not carried over; the zone default applies.",
            ],
          },
        };
      }
      case "bucket":
        return {
          resource: {
            type: "coreweave_object_storage_bucket",
            name,
            attributes: { name: tf.str(name), zone: tf.str(zone) },
            importId: name,
          },
        };
      default:
        return null;
    }
  },
};
