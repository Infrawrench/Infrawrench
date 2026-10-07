import type {
  TerraformExportCapability,
  TerraformExportResult,
  TerraformValue,
} from "@infrawrench/plugin-base";
import { fieldString, tf } from "@infrawrench/plugin-base";
import { parseMeta } from "./mappers.js";

/**
 * Terraform mapping for the official `hashicorp/nomad` provider (2.6, docs
 * under website/docs/r read 2026-10): `nomad_namespace`, `nomad_node_pool`,
 * `nomad_acl_policy` (rules from the stored `rules` output), `nomad_job`
 * (import `<id>@<namespace>`; the jobspec is read from a file, because the
 * source is not stored with the resource) and `nomad_variable` (items as a
 * write-only variable so they stay out of state). Tokens are not exported:
 * a new apply would mint a different secret.
 */
const ident = (s: string) => s.replace(/[^A-Za-z0-9_]/g, "_");

export const nomadTerraformExport: TerraformExportCapability = {
  provider: { name: "nomad", source: "hashicorp/nomad", version: "~> 2.6" },
  providerConfig: { address: tf.ref("var.nomad_address"), secret_id: tf.ref("var.nomad_token") },
  variables: [
    { name: "nomad_address", description: "Nomad address, e.g. https://nomad.example.com:4646" },
    {
      name: "nomad_token",
      description: "Nomad ACL token (management to manage ACLs)",
      sensitive: true,
    },
  ],
  supportedResourceTypeIds: [
    "nomad-namespace",
    "nomad-node-pool",
    "nomad-acl-policy",
    "nomad-job",
    "nomad-variable",
  ],
  mapResource(resource): TerraformExportResult | null {
    const s = (k: string) => fieldString(resource, k);
    switch (resource.resourceTypeId) {
      case "nomad-namespace": {
        const name = s("name");
        if (!name || name === "default") return null;
        const meta = parseMeta(s("meta"));
        const attributes: Record<string, TerraformValue> = { name: tf.str(name) };
        if (s("description")) attributes["description"] = tf.str(s("description"));
        if (s("quota")) attributes["quota"] = tf.str(s("quota"));
        if (Object.keys(meta).length)
          attributes["meta"] = tf.map(
            Object.fromEntries(Object.entries(meta).map(([k, v]) => [k, tf.str(v)])),
          );
        return { resource: { type: "nomad_namespace", name, attributes, importId: name } };
      }
      case "nomad-node-pool": {
        const name = s("name");
        if (!name || name === "all" || name === "default") return null;
        const attributes: Record<string, TerraformValue> = { name: tf.str(name) };
        if (s("description")) attributes["description"] = tf.str(s("description"));
        if (s("schedulerAlgorithm"))
          attributes["scheduler_config"] = tf.block({
            scheduler_algorithm: tf.str(s("schedulerAlgorithm")),
          });
        return { resource: { type: "nomad_node_pool", name, attributes, importId: name } };
      }
      case "nomad-acl-policy": {
        const name = s("name");
        const rules = resource.resolvedOutputs["rules"] ?? "";
        if (!name || !rules) return null;
        const attributes: Record<string, TerraformValue> = {
          name: tf.str(name),
          rules_hcl: tf.str(rules),
        };
        if (s("description")) attributes["description"] = tf.str(s("description"));
        return { resource: { type: "nomad_acl_policy", name, attributes, importId: name } };
      }
      case "nomad-job": {
        const id = s("id");
        const ns = s("namespace") || "default";
        if (!id || s("parentId")) return null;
        return {
          resource: {
            type: "nomad_job",
            name: `${ns}_${id}`,
            attributes: { jobspec: tf.ref(`file("\${path.module}/jobs/${id}.nomad.hcl")`) },
            importId: `${id}@${ns}`,
            comments: [
              `Save the job's source as jobs/${id}.nomad.hcl (the job's Describe tab, or nomad job inspect -hcl ${id}).`,
            ],
          },
        };
      }
      case "nomad-variable": {
        const path = s("path");
        const ns = s("namespace") || "default";
        if (!path) return null;
        const variable = `nomad_variable_${ident(`${ns}_${path}`)}`;
        return {
          resource: {
            type: "nomad_variable",
            name: `${ns}_${path}`,
            attributes: {
              path: tf.str(path),
              namespace: tf.str(ns),
              items_wo: tf.ref(`jsonencode(var.${variable})`),
              items_wo_version: tf.num(1),
            },
            importId: `${path}@${ns}`,
            comments: ["Bump items_wo_version whenever the items change."],
          },
          variables: [
            { name: variable, description: `Items of Nomad variable ${path}`, sensitive: true },
          ],
        };
      }
      default:
        return null;
    }
  },
};
