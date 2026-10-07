import type {
  ResourceInstance,
  TerraformExportCapability,
  TerraformExportResult,
  TerraformValue,
} from "@infrawrench/plugin-base";
import { fieldNumber, fieldString, tf } from "@infrawrench/plugin-base";
import { parseTags } from "./mappers.js";

/**
 * Terraform mapping for the official `pinecone-io/pinecone` provider (4.0.0,
 * docs/resources/*.md and the resource sources, verified 2026-10):
 *
 * - `pinecone_index`: `name`, `dimension`, `metric`, `vector_type`,
 *   `deletion_protection`, `tags`, `spec = { serverless = { cloud, region,
 *   read_capacity = { dedicated = { node_type, replicas, shards } } } }`, or
 *   `spec = { pod = { environment, pod_type, replicas, shards } }`, or
 *   `spec = { byoc = { environment } }`; `embed = { model, field_map }` for
 *   integrated indexes. Import id is the index name.
 * - `pinecone_collection`: `name`, `source`; import id is the name.
 * - `pinecone_project`: `name`, `max_pods`, `force_encryption_with_cmek`;
 *   import id is the project id.
 * - `pinecone_api_key`: `name`, `project_id`, `roles`; import id
 *   `<project_id>:<api_key_id>`.
 * - `pinecone_service_account`: `name`; import id is the service account id.
 *
 * `spec`, `read_capacity`, `embed` are attribute objects in this provider,
 * written as `tf.map`, not nested blocks. Document (full-text search) indexes
 * have no Terraform representation yet and are reported unsupported.
 */

function mapIndex(resource: ResourceInstance): TerraformExportResult | null {
  const name = fieldString(resource, "name") || resource.externalId || "";
  const deployment = fieldString(resource, "deploymentType");
  const kind = fieldString(resource, "kind");
  if (!name || kind === "documents") return null;
  const attributes: Record<string, TerraformValue> = { name: tf.str(name) };
  const dimension = fieldNumber(resource, "dimension");
  const metric = fieldString(resource, "metric");
  const vectorType = fieldString(resource, "vectorType");
  if (kind !== "integrated") {
    if (dimension !== undefined && vectorType !== "sparse") {
      attributes["dimension"] = tf.num(dimension);
    }
    if (metric) attributes["metric"] = tf.str(metric);
    if (vectorType) attributes["vector_type"] = tf.str(vectorType);
  }
  let spec: TerraformValue;
  if (deployment === "pod") {
    const env = fieldString(resource, "environment");
    const podType = fieldString(resource, "podType");
    if (!env || !podType) return null;
    const pod: Record<string, TerraformValue> = {
      environment: tf.str(env),
      pod_type: tf.str(podType),
    };
    const replicas = fieldNumber(resource, "replicas");
    const shards = fieldNumber(resource, "shards");
    if (replicas !== undefined) pod["replicas"] = tf.num(replicas);
    if (shards !== undefined) pod["shards"] = tf.num(shards);
    const source = fieldString(resource, "sourceCollection");
    if (source) pod["source_collection"] = tf.str(source);
    spec = tf.map({ pod: tf.map(pod) });
  } else {
    const inner: Record<string, TerraformValue> = {};
    if (deployment === "byoc") {
      const env = fieldString(resource, "environment");
      if (!env) return null;
      inner["environment"] = tf.str(env);
    } else {
      const cloud = fieldString(resource, "cloud");
      const region = fieldString(resource, "region");
      if (!cloud || !region) return null;
      inner["cloud"] = tf.str(cloud);
      inner["region"] = tf.str(region);
    }
    if (fieldString(resource, "readCapacityMode") === "Dedicated") {
      const dedicated: Record<string, TerraformValue> = {};
      const nodeType = fieldString(resource, "nodeType");
      const replicas = fieldNumber(resource, "replicas");
      const shards = fieldNumber(resource, "shards");
      if (nodeType) dedicated["node_type"] = tf.str(nodeType);
      if (replicas !== undefined) dedicated["replicas"] = tf.num(replicas);
      if (shards !== undefined) dedicated["shards"] = tf.num(shards);
      inner["read_capacity"] = tf.map({ dedicated: tf.map(dedicated) });
    }
    spec = tf.map({ [deployment === "byoc" ? "byoc" : "serverless"]: tf.map(inner) });
  }
  attributes["spec"] = spec;
  if (kind === "integrated") {
    const model = fieldString(resource, "embedModel");
    if (!model) return null;
    attributes["embed"] = tf.map({
      model: tf.str(model),
      field_map: tf.map({ text: tf.str("text") }),
    });
  }
  const protection = fieldString(resource, "deletionProtection");
  if (protection) attributes["deletion_protection"] = tf.str(protection);
  const tagText = fieldString(resource, "tags");
  if (tagText) {
    try {
      const tags = parseTags(tagText);
      attributes["tags"] = tf.map(
        Object.fromEntries(Object.entries(tags).map(([k, v]) => [k, tf.str(v)])),
      );
    } catch {
      /* unparseable tags are left out rather than exported wrong */
    }
  }
  const comments = ["Import first and review `terraform plan` before applying."];
  if (kind === "integrated") {
    comments.unshift(
      "The embed field_map is not stored in the inventory; set it to the record field Pinecone should embed.",
    );
  }
  return {
    resource: { type: "pinecone_index", name, attributes, importId: name, comments },
  };
}

export const pineconeTerraformExport: TerraformExportCapability = {
  provider: { name: "pinecone", source: "pinecone-io/pinecone", version: "~> 4.0" },
  providerConfig: {
    api_key: tf.ref("var.pinecone_api_key"),
    client_id: tf.ref("var.pinecone_client_id"),
    client_secret: tf.ref("var.pinecone_client_secret"),
  },
  variables: [
    { name: "pinecone_api_key", description: "Pinecone project API key", sensitive: true },
    {
      name: "pinecone_client_id",
      description: "Pinecone service account client ID (projects and API keys)",
      sensitive: true,
    },
    {
      name: "pinecone_client_secret",
      description: "Pinecone service account client secret",
      sensitive: true,
    },
  ],
  supportedResourceTypeIds: ["index", "collection", "project", "api-key", "service-account"],
  mapResource(resource): TerraformExportResult | null {
    switch (resource.resourceTypeId) {
      case "index":
        return mapIndex(resource);
      case "collection": {
        const name = fieldString(resource, "name") || resource.externalId || "";
        const source = fieldString(resource, "sourceIndex");
        if (!name) return null;
        return {
          resource: {
            type: "pinecone_collection",
            name,
            attributes: {
              name: tf.str(name),
              source: tf.str(source || "REPLACE_WITH_SOURCE_INDEX"),
            },
            importId: name,
            comments: source
              ? []
              : ["Pinecone does not report a collection's source index; fill in `source`."],
          },
        };
      }
      case "project": {
        const attributes: Record<string, TerraformValue> = {
          name: tf.str(fieldString(resource, "name") || resource.displayName),
        };
        const maxPods = fieldNumber(resource, "maxPods");
        if (maxPods !== undefined) attributes["max_pods"] = tf.num(maxPods);
        if (resource.fields["forceEncryptionWithCmek"] === true) {
          attributes["force_encryption_with_cmek"] = tf.bool(true);
        }
        return {
          resource: {
            type: "pinecone_project",
            name: resource.displayName,
            attributes,
            importId: fieldString(resource, "projectId") || resource.externalId,
          },
        };
      }
      case "api-key": {
        const projectId = fieldString(resource, "projectId");
        const keyId = fieldString(resource, "keyId") || resource.externalId || "";
        if (!projectId || !keyId) return null;
        const roles = fieldString(resource, "roles")
          .split(",")
          .map((r) => r.trim())
          .filter(Boolean);
        const attributes: Record<string, TerraformValue> = {
          name: tf.str(fieldString(resource, "name") || resource.displayName),
          project_id: tf.str(projectId),
        };
        if (roles.length) attributes["roles"] = tf.list(roles.map((r) => tf.str(r)));
        return {
          resource: {
            type: "pinecone_api_key",
            name: resource.displayName,
            attributes,
            importId: `${projectId}:${keyId}`,
            comments: [
              "The key value is not recoverable after import; Terraform state will not hold it.",
            ],
          },
        };
      }
      case "service-account":
        return {
          resource: {
            type: "pinecone_service_account",
            name: resource.displayName,
            attributes: { name: tf.str(fieldString(resource, "name") || resource.displayName) },
            importId: fieldString(resource, "serviceAccountId") || resource.externalId,
          },
        };
      default:
        return null;
    }
  },
};
