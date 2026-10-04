import type {
  ResourceInstance,
  TerraformExportCapability,
  TerraformExportResult,
  TerraformValue,
} from "@infrawrench/plugin-base";
import { fieldNumber, fieldString, tf } from "@infrawrench/plugin-base";
import { parseBucketExternalId, parseSizeId } from "./listers.js";

/**
 * Terraform mapping for OCI: provider `oracle/oci`. Argument names and import
 * ids follow the provider's resource docs
 * (github.com/oracle/terraform-provider-oci, website/docs/r/*): most resources
 * import by OCID; buckets by `n/{namespace}/b/{name}`, budget alert rules by
 * `budgets/{budgetId}/alertRules/{ruleId}`. Credentials are variables, never
 * inlined.
 */
export const ociTerraformExport: TerraformExportCapability = {
  provider: { name: "oci", source: "oracle/oci", version: "~> 7.0" },
  providerConfig: {
    tenancy_ocid: tf.ref("var.oci_tenancy_ocid"),
    user_ocid: tf.ref("var.oci_user_ocid"),
    fingerprint: tf.ref("var.oci_fingerprint"),
    private_key: tf.ref("var.oci_private_key"),
    region: tf.ref("var.oci_region"),
  },
  variables: [
    { name: "oci_tenancy_ocid", description: "Tenancy OCID" },
    { name: "oci_user_ocid", description: "OCID of the user the API key belongs to" },
    { name: "oci_fingerprint", description: "API signing key fingerprint" },
    { name: "oci_private_key", description: "API signing private key (PEM)", sensitive: true },
    { name: "oci_region", description: "Region for the provider, e.g. us-ashburn-1" },
  ],
  supportedResourceTypeIds: [
    "compartment",
    "instance",
    "block-volume",
    "vcn",
    "subnet",
    "reserved-ip",
    "load-balancer",
    "bucket",
    "autonomous-database",
    "oke-cluster",
    "budget",
    "budget-alert-rule",
  ],
  mapResource(resource: ResourceInstance): TerraformExportResult | null {
    const name = fieldString(resource, "name") || resource.displayName;
    const compartment = fieldString(resource, "compartmentId");
    const block = (
      type: string,
      attributes: Record<string, TerraformValue>,
      importId = resource.externalId,
      comments?: string[],
    ): TerraformExportResult => ({
      resource: {
        type,
        name: name || resource.externalId || type,
        attributes,
        importId,
        ...(comments?.length ? { comments } : {}),
      },
    });
    const regionComment = (): string[] => {
      const region = fieldString(resource, "region");
      return region
        ? [`Lives in ${region}: use a provider alias for that region if it differs.`]
        : [];
    };
    switch (resource.resourceTypeId) {
      case "compartment": {
        const parent = fieldString(resource, "parentId");
        if (!parent || !name) return null;
        return block("oci_identity_compartment", {
          compartment_id: tf.str(parent),
          name: tf.str(name),
          description: tf.str(fieldString(resource, "description") || name),
        });
      }
      case "instance": {
        const ad = fieldString(resource, "availabilityDomain");
        const size = fieldString(resource, "size");
        const imageId = fieldString(resource, "imageId");
        const subnetId = fieldString(resource, "subnetId");
        if (!compartment || !ad || !size || !imageId || !subnetId) return null;
        const { shape, ocpus, memoryGb } = parseSizeId(size);
        const attributes: Record<string, TerraformValue> = {
          compartment_id: tf.str(compartment),
          availability_domain: tf.str(ad),
          display_name: tf.str(name),
          shape: tf.str(shape),
          source_details: tf.block({ source_type: tf.str("image"), source_id: tf.str(imageId) }),
          create_vnic_details: tf.block({ subnet_id: tf.str(subnetId) }),
        };
        if (ocpus !== undefined && memoryGb !== undefined) {
          attributes["shape_config"] = tf.block({
            ocpus: tf.num(ocpus),
            memory_in_gbs: tf.num(memoryGb),
          });
        }
        return block("oci_core_instance", attributes, resource.externalId, [
          ...regionComment(),
          "`source_details.source_id` is the image the instance launched from; changing it forces replacement.",
        ]);
      }
      case "block-volume": {
        const ad = fieldString(resource, "availabilityDomain");
        const size = fieldNumber(resource, "sizeGb");
        if (!compartment || !ad || size === undefined) return null;
        return block(
          "oci_core_volume",
          {
            compartment_id: tf.str(compartment),
            availability_domain: tf.str(ad),
            display_name: tf.str(name),
            size_in_gbs: tf.str(String(size)),
            vpus_per_gb: tf.str(String(fieldNumber(resource, "vpusPerGb") ?? 10)),
          },
          resource.externalId,
          regionComment(),
        );
      }
      case "vcn": {
        const cidrs = (fieldString(resource, "cidrBlocks") ?? "")
          .split(",")
          .map((c) => c.trim())
          .filter(Boolean);
        if (!compartment || cidrs.length === 0) return null;
        const attributes: Record<string, TerraformValue> = {
          compartment_id: tf.str(compartment),
          display_name: tf.str(name),
          cidr_blocks: tf.list(cidrs.map((c) => tf.str(c))),
        };
        const dns = fieldString(resource, "dnsLabel");
        if (dns) attributes["dns_label"] = tf.str(dns);
        return block("oci_core_vcn", attributes, resource.externalId, regionComment());
      }
      case "subnet": {
        const vcnId = fieldString(resource, "vcnId");
        const cidr = fieldString(resource, "cidrBlock");
        if (!compartment || !vcnId || !cidr) return null;
        const attributes: Record<string, TerraformValue> = {
          compartment_id: tf.str(compartment),
          vcn_id: tf.str(vcnId),
          cidr_block: tf.str(cidr),
          display_name: tf.str(name),
          prohibit_public_ip_on_vnic: tf.bool(fieldString(resource, "access") === "private"),
        };
        const dns = fieldString(resource, "dnsLabel");
        if (dns) attributes["dns_label"] = tf.str(dns);
        const ad = fieldString(resource, "availabilityDomain");
        if (ad) attributes["availability_domain"] = tf.str(ad);
        return block("oci_core_subnet", attributes, resource.externalId, regionComment());
      }
      case "reserved-ip":
        if (!compartment) return null;
        return block(
          "oci_core_public_ip",
          {
            compartment_id: tf.str(compartment),
            lifetime: tf.str("RESERVED"),
            display_name: tf.str(name),
          },
          resource.externalId,
          regionComment(),
        );
      case "load-balancer": {
        const subnets = (fieldString(resource, "subnetIds") ?? "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        if (!compartment || subnets.length === 0) return null;
        return block(
          "oci_load_balancer_load_balancer",
          {
            compartment_id: tf.str(compartment),
            display_name: tf.str(name),
            shape: tf.str("flexible"),
            shape_details: tf.block({
              minimum_bandwidth_in_mbps: tf.num(fieldNumber(resource, "minBandwidthMbps") ?? 10),
              maximum_bandwidth_in_mbps: tf.num(fieldNumber(resource, "maxBandwidthMbps") ?? 100),
            }),
            subnet_ids: tf.list(subnets.map((s) => tf.str(s))),
            is_private: tf.bool(resource.fields["isPrivate"] === true),
          },
          resource.externalId,
          [...regionComment(), "Listeners, backend sets and certificates are separate resources."],
        );
      }
      case "bucket": {
        const ns = fieldString(resource, "namespace");
        const { name: bucket } = parseBucketExternalId(resource.externalId ?? "");
        if (!compartment || !ns || !bucket) return null;
        return block(
          "oci_objectstorage_bucket",
          {
            compartment_id: tf.str(compartment),
            name: tf.str(bucket),
            namespace: tf.str(ns),
            access_type: tf.str(fieldString(resource, "publicAccessType") || "NoPublicAccess"),
            storage_tier: tf.str(fieldString(resource, "storageTier") || "Standard"),
            versioning: tf.str(fieldString(resource, "versioning") || "Disabled"),
            auto_tiering: tf.str(fieldString(resource, "autoTiering") || "Disabled"),
          },
          `n/${ns}/b/${bucket}`,
          regionComment(),
        );
      }
      case "autonomous-database": {
        const dbName = fieldString(resource, "dbName");
        if (!compartment || !dbName) return null;
        const free = resource.fields["freeTier"] === true;
        const attributes: Record<string, TerraformValue> = {
          compartment_id: tf.str(compartment),
          db_name: tf.str(dbName),
          display_name: tf.str(name),
          db_workload: tf.str(fieldString(resource, "workload") || "OLTP"),
          admin_password: tf.ref("var.oci_adb_admin_password"),
        };
        if (free) {
          attributes["is_free_tier"] = tf.bool(true);
        } else {
          attributes["compute_model"] = tf.str(fieldString(resource, "computeModel") || "ECPU");
          attributes["compute_count"] = tf.num(fieldNumber(resource, "computeCount") ?? 2);
          const storage = fieldNumber(resource, "storageTb");
          if (storage !== undefined) attributes["data_storage_size_in_tbs"] = tf.num(storage);
          attributes["is_auto_scaling_enabled"] = tf.bool(resource.fields["autoScaling"] === true);
          const license = fieldString(resource, "licenseModel");
          if (license) attributes["license_model"] = tf.str(license);
        }
        return {
          ...block(
            "oci_database_autonomous_database",
            attributes,
            resource.externalId,
            regionComment(),
          ),
          variables: [
            {
              name: "oci_adb_admin_password",
              description: "ADMIN password for the Autonomous Database",
              sensitive: true,
            },
          ],
        };
      }
      case "oke-cluster": {
        const vcnId = fieldString(resource, "vcnId");
        const version = fieldString(resource, "kubernetesVersion");
        if (!compartment || !vcnId || !version) return null;
        return block(
          "oci_containerengine_cluster",
          {
            compartment_id: tf.str(compartment),
            name: tf.str(name),
            vcn_id: tf.str(vcnId),
            kubernetes_version: tf.str(version),
            type: tf.str(fieldString(resource, "clusterType") || "BASIC_CLUSTER"),
          },
          resource.externalId,
          [...regionComment(), "Node pools are separate oci_containerengine_node_pool resources."],
        );
      }
      case "budget": {
        const amount = fieldNumber(resource, "amount");
        const targets = (fieldString(resource, "targets") ?? "")
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean);
        if (amount === undefined || targets.length === 0) return null;
        const attributes: Record<string, TerraformValue> = {
          compartment_id: tf.ref("var.oci_tenancy_ocid"),
          amount: tf.num(amount),
          reset_period: tf.str("MONTHLY"),
          display_name: tf.str(name),
          target_type: tf.str(fieldString(resource, "targetType") || "COMPARTMENT"),
          targets: tf.list(targets.map((t) => tf.str(t))),
        };
        const description = fieldString(resource, "description");
        if (description) attributes["description"] = tf.str(description);
        const period = fieldString(resource, "processingPeriodType");
        if (period) attributes["processing_period_type"] = tf.str(period);
        return block("oci_budget_budget", attributes);
      }
      case "budget-alert-rule": {
        const [budgetId, ruleId] = (resource.externalId ?? "").split("/");
        const threshold = fieldNumber(resource, "threshold");
        if (!budgetId || !ruleId || threshold === undefined) return null;
        const attributes: Record<string, TerraformValue> = {
          budget_id: tf.str(budgetId),
          threshold: tf.num(threshold),
          threshold_type: tf.str(fieldString(resource, "thresholdType") || "PERCENTAGE"),
          type: tf.str(fieldString(resource, "type") || "ACTUAL"),
        };
        if (name) attributes["display_name"] = tf.str(name);
        const recipients = fieldString(resource, "recipients");
        if (recipients) attributes["recipients"] = tf.str(recipients);
        const message = fieldString(resource, "message");
        if (message) attributes["message"] = tf.str(message);
        return block(
          "oci_budget_alert_rule",
          attributes,
          `budgets/${budgetId}/alertRules/${ruleId}`,
        );
      }
      default:
        return null;
    }
  },
};
