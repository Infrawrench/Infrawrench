import type {
  TerraformExportCapability,
  TerraformExportResult,
  TerraformValue,
} from "@infrawrench/plugin-base";
import { fieldNumber, fieldString, tf } from "@infrawrench/plugin-base";
import { splitId } from "./api.js";
import { T } from "./resource-types.js";
import type { CpServiceGroup } from "./types.js";

const ORG = "var.capella_organization_id";

/**
 * Terraform mapping for Capella: provider `couchbasecloud/couchbase-capella`
 * (v1.12, docs/resources/*.md, verified 2026-10). Import ids are the
 * provider's `key=value,…` form. Mapped: projects, operational clusters
 * (service groups from the synced cluster), buckets, scopes, collections,
 * allowed CIDRs and App Services. Free-tier clusters, credentials (the
 * password cannot be read back), users and API keys are left out.
 */
export const capellaTerraformExport: TerraformExportCapability = {
  provider: {
    name: "couchbase-capella",
    source: "couchbasecloud/couchbase-capella",
    version: "~> 1.12",
  },
  providerConfig: { authentication_token: tf.ref("var.capella_api_key") },
  variables: [
    { name: "capella_api_key", description: "Capella Management API key", sensitive: true },
    { name: "capella_organization_id", description: "Capella organization id" },
  ],
  supportedResourceTypeIds: [
    T.project,
    T.cluster,
    T.bucket,
    T.scope,
    T.collection,
    T.cidr,
    T.appService,
  ],
  mapResource(resource): TerraformExportResult | null {
    const ext = resource.externalId ?? "";
    const org = tf.ref(ORG);
    const orgId = fieldString(resource, "organizationId") || "<organization_id>";
    switch (resource.resourceTypeId) {
      case T.project:
        return {
          resource: {
            type: "couchbase-capella_project",
            name: resource.displayName,
            attributes: {
              organization_id: org,
              name: tf.str(fieldString(resource, "name") || resource.displayName),
              description: tf.str(fieldString(resource, "description")),
            },
            importId: `id=${ext},organization_id=${orgId}`,
          },
        };
      case T.cluster: {
        if (resource.fields["freeTier"] === true) return null;
        const [p, c] = splitId(ext, 2);
        let groups: CpServiceGroup[] = [];
        try {
          groups = JSON.parse(
            fieldString(resource, "serviceGroupsJson") || "[]",
          ) as CpServiceGroup[];
        } catch {
          groups = [];
        }
        if (!groups.length || !fieldString(resource, "region")) return null;
        const attributes: Record<string, TerraformValue> = {
          organization_id: org,
          project_id: tf.str(p!),
          name: tf.str(fieldString(resource, "name") || resource.displayName),
          cloud_provider: tf.map({
            type: tf.str(fieldString(resource, "cloud")),
            region: tf.str(fieldString(resource, "region")),
            ...(fieldString(resource, "cidr")
              ? { cidr: tf.str(fieldString(resource, "cidr")) }
              : {}),
          }),
          service_groups: tf.list(
            groups.map((g) =>
              tf.map({
                node: tf.map({
                  compute: tf.map({
                    cpu: tf.num(g.node?.compute?.cpu ?? 0),
                    ram: tf.num(g.node?.compute?.ram ?? 0),
                  }),
                  disk: tf.map(
                    Object.fromEntries(
                      Object.entries(g.node?.disk ?? {}).map(([k, v]) => [
                        k === "autoExpansion" ? "autoexpansion" : k,
                        typeof v === "number"
                          ? tf.num(v)
                          : typeof v === "boolean"
                            ? tf.bool(v)
                            : tf.str(String(v)),
                      ]),
                    ),
                  ),
                }),
                num_of_nodes: tf.num(g.numOfNodes ?? 0),
                services: tf.list((g.services ?? []).map((s) => tf.str(s))),
              }),
            ),
          ),
          availability: tf.map({ type: tf.str(fieldString(resource, "availability") || "multi") }),
          support: tf.map({
            plan: tf.str(fieldString(resource, "supportPlan") || "developer pro"),
            ...(fieldString(resource, "supportTimezone")
              ? { timezone: tf.str(fieldString(resource, "supportTimezone")) }
              : {}),
          }),
        };
        const version = fieldString(resource, "version");
        if (version)
          attributes["couchbase_server"] = tf.map({
            version: tf.str(version.split(".").slice(0, 2).join(".")),
          });
        return {
          resource: {
            type: "couchbase-capella_cluster",
            name: resource.displayName,
            attributes,
            importId: `id=${c},cluster_id=${c},project_id=${p},organization_id=${orgId}`,
          },
        };
      }
      case T.bucket: {
        const [p, c, b] = splitId(ext, 3);
        const attributes: Record<string, TerraformValue> = {
          organization_id: org,
          project_id: tf.str(p!),
          cluster_id: tf.str(c!),
          name: tf.str(fieldString(resource, "name")),
        };
        const mem = fieldNumber(resource, "memoryAllocationInMb");
        if (mem !== undefined) attributes["memory_allocation_in_mb"] = tf.num(mem);
        const replicas = fieldNumber(resource, "replicas");
        if (replicas !== undefined) attributes["replicas"] = tf.num(replicas);
        for (const [field, attr] of [
          ["type", "type"],
          ["storageBackend", "storage_backend"],
          ["durabilityLevel", "durability_level"],
          ["evictionPolicy", "eviction_policy"],
          ["conflictResolution", "bucket_conflict_resolution"],
        ] as const) {
          const v = fieldString(resource, field);
          if (v) attributes[attr] = tf.str(v);
        }
        const ttl = fieldNumber(resource, "timeToLiveInSeconds");
        if (ttl !== undefined) attributes["time_to_live_in_seconds"] = tf.num(ttl);
        if (typeof resource.fields["flushEnabled"] === "boolean")
          attributes["flush"] = tf.bool(resource.fields["flushEnabled"]);
        return {
          resource: {
            type: "couchbase-capella_bucket",
            name: fieldString(resource, "name") || resource.displayName,
            attributes,
            importId: `id=${b},cluster_id=${c},project_id=${p},organization_id=${orgId}`,
          },
        };
      }
      case T.scope: {
        const [p, c, b, s] = splitId(ext, 4);
        if (s === "_default" || s === "_system") return null;
        return {
          resource: {
            type: "couchbase-capella_scope",
            name: s!,
            attributes: {
              organization_id: org,
              project_id: tf.str(p!),
              cluster_id: tf.str(c!),
              bucket_id: tf.str(b!),
              scope_name: tf.str(s!),
            },
            importId: `scope_name=${s},bucket_id=${b},cluster_id=${c},project_id=${p},organization_id=${orgId}`,
          },
        };
      }
      case T.collection: {
        const [p, c, b, s, n] = splitId(ext, 5);
        if (n === "_default" || s === "_system") return null;
        const attributes: Record<string, TerraformValue> = {
          organization_id: org,
          project_id: tf.str(p!),
          cluster_id: tf.str(c!),
          bucket_id: tf.str(b!),
          scope_name: tf.str(s!),
          collection_name: tf.str(n!),
        };
        const ttl = fieldNumber(resource, "maxTTL");
        if (ttl !== undefined) attributes["max_ttl"] = tf.num(ttl);
        return {
          resource: {
            type: "couchbase-capella_collection",
            name: n!,
            attributes,
            importId: `collection_name=${n},scope_name=${s},bucket_id=${b},cluster_id=${c},project_id=${p},organization_id=${orgId}`,
          },
        };
      }
      case T.cidr: {
        const [p, c, id] = splitId(ext, 3);
        const attributes: Record<string, TerraformValue> = {
          organization_id: org,
          project_id: tf.str(p!),
          cluster_id: tf.str(c!),
          cidr: tf.str(fieldString(resource, "cidr")),
        };
        const comment = fieldString(resource, "comment");
        if (comment) attributes["comment"] = tf.str(comment);
        const exp = fieldString(resource, "expiresAt");
        if (exp) attributes["expires_at"] = tf.str(exp);
        return {
          resource: {
            type: "couchbase-capella_allowlist",
            name: fieldString(resource, "cidr"),
            attributes,
            importId: `id=${id},cluster_id=${c},project_id=${p},organization_id=${orgId}`,
          },
        };
      }
      case T.appService: {
        const [p, c, a] = splitId(ext, 3);
        const attributes: Record<string, TerraformValue> = {
          organization_id: org,
          project_id: tf.str(p!),
          cluster_id: tf.str(c!),
          name: tf.str(fieldString(resource, "name") || resource.displayName),
        };
        const nodes = fieldNumber(resource, "nodes");
        if (nodes !== undefined) attributes["nodes"] = tf.num(nodes);
        const [cpu, ram] = fieldString(resource, "compute").split("/").map(Number);
        if (cpu && ram) attributes["compute"] = tf.map({ cpu: tf.num(cpu), ram: tf.num(ram) });
        return {
          resource: {
            type: "couchbase-capella_app_service",
            name: resource.displayName,
            attributes,
            importId: `id=${a},cluster_id=${c},project_id=${p},organization_id=${orgId}`,
          },
        };
      }
      default:
        return null;
    }
  },
};
