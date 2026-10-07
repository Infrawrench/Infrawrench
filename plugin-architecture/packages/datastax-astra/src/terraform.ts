import type {
  TerraformExportCapability,
  TerraformExportResult,
  TerraformValue,
} from "@infrawrench/plugin-base";
import { fieldNumber, fieldString, tf } from "@infrawrench/plugin-base";
import { T } from "./resource-types.js";

const list = (raw: string) =>
  raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

/**
 * Terraform mapping for Astra: provider `datastax/astra` (v2.5,
 * docs/resources/*.md, verified 2026-10). Mapped: databases (import by id),
 * keyspaces (`<db>/keyspace/<name>`), custom roles (import by role id),
 * streaming tenants (`<cluster>/<tenant>`) and PCU groups (import by id).
 * Tokens are left out (the secret is only known at creation), as are access
 * lists, which Terraform manages as one block per database.
 */
export const astraTerraformExport: TerraformExportCapability = {
  provider: { name: "astra", source: "datastax/astra", version: "~> 2.5" },
  providerConfig: { token: tf.ref("var.astra_token") },
  variables: [{ name: "astra_token", description: "Astra application token", sensitive: true }],
  supportedResourceTypeIds: [T.database, T.keyspace, T.role, T.tenant, T.pcuGroup],
  mapResource(resource): TerraformExportResult | null {
    switch (resource.resourceTypeId) {
      case T.database: {
        const regions = list(fieldString(resource, "regions"));
        const cloud = fieldString(resource, "cloud").toLowerCase();
        if (!regions.length || !cloud) return null;
        const attributes: Record<string, TerraformValue> = {
          name: tf.str(fieldString(resource, "name") || resource.displayName),
          cloud_provider: tf.str(cloud),
          regions: tf.list(regions.map((r) => tf.str(r))),
        };
        const ks = fieldString(resource, "keyspace");
        if (ks) attributes["keyspace"] = tf.str(ks);
        if (fieldString(resource, "dbType") === "vector") attributes["db_type"] = tf.str("vector");
        return {
          resource: {
            type: "astra_database",
            name: resource.displayName,
            attributes,
            importId: fieldString(resource, "databaseId") || resource.externalId,
          },
        };
      }
      case T.keyspace: {
        const db = fieldString(resource, "databaseId");
        const name = fieldString(resource, "name");
        if (!db || !name || resource.fields["isDefault"] === true) return null;
        return {
          resource: {
            type: "astra_keyspace",
            name,
            attributes: { database_id: tf.str(db), name: tf.str(name) },
            importId: `${db}/keyspace/${name}`,
          },
        };
      }
      case T.role: {
        if (resource.fields["custom"] !== true) return null;
        const perms = list(fieldString(resource, "permissions"));
        const resources = list(fieldString(resource, "resources"));
        if (!perms.length || !resources.length) return null;
        return {
          resource: {
            type: "astra_role",
            name: fieldString(resource, "name") || resource.displayName,
            attributes: {
              role_name: tf.str(fieldString(resource, "name")),
              description: tf.str(fieldString(resource, "description")),
              effect: tf.str("allow"),
              policy: tf.list(perms.map((p) => tf.str(p))),
              resources: tf.list(resources.map((r) => tf.str(r))),
            },
            importId: fieldString(resource, "roleId"),
          },
        };
      }
      case T.tenant: {
        const tenant = fieldString(resource, "tenantName");
        const cluster = fieldString(resource, "clusterName");
        if (!tenant || !cluster) return null;
        return {
          resource: {
            type: "astra_streaming_tenant",
            name: tenant,
            attributes: {
              tenant_name: tf.str(tenant),
              cluster_name: tf.str(cluster),
              user_email: tf.ref("var.astra_streaming_owner_email"),
            },
            importId: `${cluster}/${tenant}`,
          },
          variables: [
            {
              name: "astra_streaming_owner_email",
              description: "Owner email for streaming tenants",
            },
          ],
        };
      }
      case T.pcuGroup: {
        const id = fieldString(resource, "pcuGroupId");
        const cloud = fieldString(resource, "cloud");
        const region = fieldString(resource, "region");
        const min = fieldNumber(resource, "min");
        const max = fieldNumber(resource, "max");
        if (!id || !cloud || !region || min === undefined || max === undefined) return null;
        const attributes: Record<string, TerraformValue> = {
          title: tf.str(fieldString(resource, "title") || resource.displayName),
          cloud_provider: tf.str(cloud),
          region: tf.str(region),
          min_capacity: tf.num(min),
          max_capacity: tf.num(max),
        };
        const reserved = fieldNumber(resource, "reserved");
        if (reserved !== undefined) attributes["reserved_capacity"] = tf.num(reserved);
        const it = fieldString(resource, "instanceType");
        if (it) attributes["cache_type"] = tf.str(it.toUpperCase());
        const pt = fieldString(resource, "provisionType");
        if (pt) attributes["provision_type"] = tf.str(pt.toUpperCase());
        const desc = fieldString(resource, "description");
        if (desc) attributes["description"] = tf.str(desc);
        return {
          resource: {
            type: "astra_pcu_group",
            name: resource.displayName,
            attributes,
            importId: id,
          },
        };
      }
      default:
        return null;
    }
  },
};
