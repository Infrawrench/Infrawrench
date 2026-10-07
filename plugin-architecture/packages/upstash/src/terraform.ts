import type { TerraformExportCapability, TerraformExportResult } from "@infrawrench/plugin-base";
import { fieldString, tf } from "@infrawrench/plugin-base";
import { T } from "./resource-types.js";

/**
 * Terraform mapping for the official `upstash/upstash` provider (v2.1,
 * checked against the registry docs and provider source 2026-10). The
 * provider is configured with the same email and Developer API key.
 *
 * - `upstash_redis_database`: region is always `global` with
 *   `primary_region` / `read_regions`. Import id is the database id (the
 *   provider's read falls back to `data.Id()`).
 * - `upstash_vector_index`, `upstash_search`: no importer in the provider,
 *   so they are emitted without an import id and must be adopted by
 *   recreating or `terraform state` surgery.
 * - `upstash_qstash_schedule_v2`, `upstash_qstash_topic_v2`: the provider
 *   declares an importer but reads `schedule_id` / `name` from state, which
 *   is empty on import, so no import id is emitted either.
 */
export const upstashTerraformExport: TerraformExportCapability = {
  provider: { name: "upstash", source: "upstash/upstash", version: "~> 2.1" },
  providerConfig: {
    email: tf.ref("var.upstash_email"),
    api_key: tf.ref("var.upstash_api_key"),
  },
  variables: [
    { name: "upstash_email", description: "Upstash account email" },
    { name: "upstash_api_key", description: "Upstash Developer API key", sensitive: true },
  ],
  supportedResourceTypeIds: [T.redis, T.vector, T.search, T.schedule, T.urlGroup],
  mapResource(resource): TerraformExportResult | null {
    const name = fieldString(resource, "name") || resource.displayName;
    switch (resource.resourceTypeId) {
      case T.redis: {
        const region = fieldString(resource, "region");
        if (!region) return null;
        const reads = fieldString(resource, "readRegions")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        const attrs: Record<string, ReturnType<typeof tf.str>> = {
          database_name: tf.str(name),
          region: tf.str("global"),
          primary_region: tf.str(region),
          tls: tf.bool(true),
        };
        if (reads.length) attrs["read_regions"] = tf.list(reads.map((r) => tf.str(r)));
        if (resource.fields["eviction"] !== undefined)
          attrs["eviction"] = tf.bool(resource.fields["eviction"] === true);
        if (resource.fields["autoUpgrade"] !== undefined)
          attrs["auto_scale"] = tf.bool(resource.fields["autoUpgrade"] === true);
        if (typeof resource.fields["budget"] === "number")
          attrs["budget"] = tf.num(resource.fields["budget"]);
        if (resource.fields["prodPack"] === true) attrs["prod_pack"] = tf.bool(true);
        return {
          resource: {
            type: "upstash_redis_database",
            name,
            attributes: attrs,
            ...(resource.externalId ? { importId: resource.externalId } : {}),
          },
        };
      }
      case T.vector: {
        const region = fieldString(resource, "region");
        const similarity = fieldString(resource, "similarity");
        const dims = resource.fields["dimensions"];
        if (!region || !similarity || typeof dims !== "number") return null;
        return {
          resource: {
            type: "upstash_vector_index",
            name,
            attributes: {
              name: tf.str(name),
              region: tf.str(region),
              similarity_function: tf.str(similarity),
              dimension_count: tf.num(dims),
              type: tf.str(fieldString(resource, "plan") || "payg"),
            },
            comments: [
              "The provider cannot import vector indexes; applying this creates a new index.",
            ],
          },
        };
      }
      case T.search: {
        const region = fieldString(resource, "region");
        if (!region) return null;
        return {
          resource: {
            type: "upstash_search",
            name,
            attributes: {
              name: tf.str(name),
              region: tf.str(region),
              type: tf.str(fieldString(resource, "plan") || "payg"),
            },
            comments: [
              "The provider cannot import search indexes; applying this creates a new index.",
            ],
          },
        };
      }
      case T.schedule: {
        const cron = fieldString(resource, "cron");
        const destination = fieldString(resource, "destination");
        if (!cron || !destination) return null;
        const attrs: Record<string, ReturnType<typeof tf.str>> = {
          cron: tf.str(cron),
          destination: tf.str(destination),
        };
        if (fieldString(resource, "method"))
          attrs["method"] = tf.str(fieldString(resource, "method"));
        if (typeof resource.fields["retries"] === "number")
          attrs["retries"] = tf.num(resource.fields["retries"]);
        if (fieldString(resource, "callback"))
          attrs["callback"] = tf.str(fieldString(resource, "callback"));
        return {
          resource: {
            type: "upstash_qstash_schedule_v2",
            name: `schedule_${resource.externalId ?? name}`,
            attributes: attrs,
            comments: ["The message body is not synced; add `body` if the schedule sends one."],
          },
        };
      }
      case T.urlGroup: {
        const endpoints = fieldString(resource, "endpoints")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        if (!endpoints.length) return null;
        return {
          resource: {
            type: "upstash_qstash_topic_v2",
            name,
            attributes: { name: tf.str(name), endpoints: tf.list(endpoints.map((e) => tf.str(e))) },
          },
        };
      }
      default:
        return null;
    }
  },
};
