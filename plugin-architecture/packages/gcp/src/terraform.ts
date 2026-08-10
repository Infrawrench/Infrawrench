import type {
  TerraformExportCapability,
  TerraformExportResult,
  TerraformValue,
} from "@infrawrench/plugin-base";
import { fieldBool, fieldNumber, fieldString, tf } from "@infrawrench/plugin-base";

/**
 * Terraform mapping for Google Cloud — provider `hashicorp/google`.
 *
 * The listers do not retain GCE boot disks/images or Cloud Run revision
 * containers, so those resource types cannot produce valid Terraform. Firewall
 * allow/deny protocol blocks are likewise not retained in a structured form.
 */
export const gcpTerraformExport: TerraformExportCapability = {
  provider: { name: "google", source: "hashicorp/google", version: "~> 7.0" },
  providerConfig: {
    credentials: tf.ref("var.gcp_credentials"),
    project: tf.ref("var.gcp_project"),
  },
  variables: [
    {
      name: "gcp_credentials",
      description: "Google service account JSON credentials",
      sensitive: true,
    },
    { name: "gcp_project", description: "Google Cloud project ID" },
  ],
  supportedResourceTypeIds: [
    "gcs-bucket",
    "vpc-network",
    "subnet",
    "gke-cluster",
    "pubsub-topic",
    "cloud-dns-zone",
    "bigquery-dataset",
    "artifact-registry-repo",
    "gcp-service-account",
  ],
  mapResource(resource): TerraformExportResult | null {
    switch (resource.resourceTypeId) {
      case "gcs-bucket": {
        const name = fieldString(resource, "name") || resource.displayName;
        const location = fieldString(resource, "location");
        if (!name || !location) return null;
        const attributes: Record<string, TerraformValue> = {
          name: tf.str(name),
          location: tf.str(location),
        };
        const storageClass = fieldString(resource, "storageClass");
        if (storageClass) attributes["storage_class"] = tf.str(storageClass);
        const publicAccessPrevention = fieldString(resource, "publicAccessPrevention");
        if (publicAccessPrevention)
          attributes["public_access_prevention"] = tf.str(publicAccessPrevention);
        return {
          resource: {
            type: "google_storage_bucket",
            name,
            attributes,
            importId: resource.externalId || name,
          },
        };
      }
      case "vpc-network": {
        const name = fieldString(resource, "name") || resource.displayName;
        if (!name) return null;
        const attributes: Record<string, TerraformValue> = { name: tf.str(name) };
        const description = fieldString(resource, "description");
        if (description) attributes["description"] = tf.str(description);
        if (fieldBool(resource, "autoCreateSubnetworks"))
          attributes["auto_create_subnetworks"] = tf.bool(true);
        const mtu = fieldNumber(resource, "mtu");
        if (mtu !== undefined) attributes["mtu"] = tf.num(mtu);
        return {
          resource: {
            type: "google_compute_network",
            name,
            attributes,
            importId: resource.externalId,
          },
        };
      }
      case "subnet": {
        const name = fieldString(resource, "name") || resource.displayName;
        const region = fieldString(resource, "region");
        const network = fieldString(resource, "network");
        const ipCidrRange = fieldString(resource, "ipCidrRange");
        if (!name || !region || !network || !ipCidrRange) return null;
        const attributes: Record<string, TerraformValue> = {
          name: tf.str(name),
          region: tf.str(region),
          network: tf.str(network),
          ip_cidr_range: tf.str(ipCidrRange),
        };
        if (fieldBool(resource, "privateIpGoogleAccess"))
          attributes["private_ip_google_access"] = tf.bool(true);
        const purpose = fieldString(resource, "purpose");
        if (purpose) attributes["purpose"] = tf.str(purpose);
        const stackType = fieldString(resource, "stackType");
        if (stackType) attributes["stack_type"] = tf.str(stackType);
        return {
          resource: {
            type: "google_compute_subnetwork",
            name,
            attributes,
            importId: resource.externalId,
          },
        };
      }
      case "gke-cluster": {
        const name = fieldString(resource, "name") || resource.displayName;
        if (!name) return null;
        const attributes: Record<string, TerraformValue> = { name: tf.str(name) };
        const location = fieldString(resource, "location");
        if (location) attributes["location"] = tf.str(location);
        const version = fieldString(resource, "version");
        if (version) attributes["min_master_version"] = tf.str(version);
        const network = fieldString(resource, "networkName");
        if (network) attributes["network"] = tf.str(network);
        const subnetwork = fieldString(resource, "subnetwork");
        if (subnetwork) attributes["subnetwork"] = tf.str(subnetwork);
        return {
          resource: {
            type: "google_container_cluster",
            name,
            attributes,
            importId: resource.externalId,
            comments: [
              "Node pool details are incomplete; import first and review the generated plan.",
            ],
          },
        };
      }
      case "pubsub-topic": {
        const name = fieldString(resource, "name") || resource.displayName;
        if (!name) return null;
        const attributes: Record<string, TerraformValue> = { name: tf.str(name) };
        const kmsKeyName = fieldString(resource, "kmsKeyName");
        if (kmsKeyName) attributes["kms_key_name"] = tf.str(kmsKeyName);
        const messageRetentionDuration = fieldString(resource, "messageRetentionDuration");
        if (messageRetentionDuration)
          attributes["message_retention_duration"] = tf.str(messageRetentionDuration);
        return {
          resource: {
            type: "google_pubsub_topic",
            name,
            attributes,
            importId: resource.externalId,
          },
        };
      }
      case "cloud-dns-zone": {
        const name = fieldString(resource, "name") || resource.displayName;
        const dnsName = fieldString(resource, "dnsName");
        if (!name || !dnsName) return null;
        const attributes: Record<string, TerraformValue> = {
          name: tf.str(name),
          dns_name: tf.str(dnsName),
        };
        const description = fieldString(resource, "description");
        if (description) attributes["description"] = tf.str(description);
        const visibility = fieldString(resource, "visibility");
        if (visibility) attributes["visibility"] = tf.str(visibility);
        return {
          resource: {
            type: "google_dns_managed_zone",
            name,
            attributes,
            importId: resource.externalId,
          },
        };
      }
      case "bigquery-dataset": {
        const datasetId = fieldString(resource, "name") || resource.displayName;
        if (!datasetId) return null;
        const attributes: Record<string, TerraformValue> = { dataset_id: tf.str(datasetId) };
        const friendlyName = fieldString(resource, "friendlyName");
        if (friendlyName) attributes["friendly_name"] = tf.str(friendlyName);
        const location = fieldString(resource, "location");
        if (location) attributes["location"] = tf.str(location);
        const description = fieldString(resource, "description");
        if (description) attributes["description"] = tf.str(description);
        const defaultTableExpirationMs = fieldNumber(resource, "defaultTableExpirationMs");
        if (defaultTableExpirationMs !== undefined)
          attributes["default_table_expiration_ms"] = tf.num(defaultTableExpirationMs);
        return {
          resource: {
            type: "google_bigquery_dataset",
            name: datasetId,
            attributes,
            importId: resource.externalId,
          },
        };
      }
      case "artifact-registry-repo": {
        const repositoryId = fieldString(resource, "name") || resource.displayName;
        const location = fieldString(resource, "location");
        const format = fieldString(resource, "format");
        if (!repositoryId || !location || !format) return null;
        const attributes: Record<string, TerraformValue> = {
          repository_id: tf.str(repositoryId),
          location: tf.str(location),
          format: tf.str(format),
        };
        const description = fieldString(resource, "description");
        if (description) attributes["description"] = tf.str(description);
        return {
          resource: {
            type: "google_artifact_registry_repository",
            name: repositoryId,
            attributes,
            importId: resource.externalId,
          },
        };
      }
      case "gcp-service-account": {
        const accountId = fieldString(resource, "name") || resource.displayName;
        if (!accountId) return null;
        const attributes: Record<string, TerraformValue> = { account_id: tf.str(accountId) };
        const displayName = fieldString(resource, "displayName");
        if (displayName) attributes["display_name"] = tf.str(displayName);
        const description = fieldString(resource, "description");
        if (description) attributes["description"] = tf.str(description);
        return {
          resource: {
            type: "google_service_account",
            name: accountId,
            attributes,
            importId: resource.externalId || fieldString(resource, "email"),
          },
        };
      }
      default:
        return null;
    }
  },
};
