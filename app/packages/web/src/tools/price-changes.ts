/**
 * Price-change tools: the MCP/chat view of the Price catalog tab's Changes
 * view. Read-only; making a scenario model from a change stays in the app,
 * where the editor that owns the model is.
 */
import { Schema } from "effect";
import { PRICE_CHANGE_LIMITS } from "@infrawrench/client-core";
import {
  listCatalogPriceChanges,
  listPriceChanges,
} from "@infrawrench/server-core/price-changes/feed";
import { ok, type ToolDefinition } from "./types";

export function priceChangeTools(): ToolDefinition[] {
  const { listDays, catalogDays } = PRICE_CHANGE_LIMITS;
  return [
    {
      name: "list_price_changes",
      title: "List price changes on what the organization runs",
      description:
        "List-price changes on instance types the organization runs (AWS EC2/RDS/ElastiCache/" +
        "OpenSearch/Redshift/EKS, Azure VMs and AKS, GCE and GKE, Alibaba ECS and ACK, RunPod " +
        "pods), one row per change: instance type, region, variant, old and new hourly on-demand " +
        "list price in USD, when it took effect, the affected resources and `monthlyImpactUsd` " +
        "((new - old) x 730 x units). `belowThreshold` marks changes under the organization's " +
        "alert thresholds. Found by a daily scan.",
      inputSchema: {
        days: Schema.optionalKey(
          Schema.Int.check(
            Schema.isBetween({ minimum: listDays.min, maximum: listDays.max }),
          ).annotate({ description: `How far back, in days. Default ${listDays.default}.` }),
        ),
        includeBelowThreshold: Schema.optionalKey(
          Schema.Boolean.annotate({
            description: "Also return changes under the organization's alert thresholds.",
          }),
        ),
      },
      risk: "read",
      // Mirrors `GET /price-changes`.
      permission: "costs:read",
      handler: async (input, auth) => {
        const { days, includeBelowThreshold } = input as {
          days?: number;
          includeBelowThreshold?: boolean;
        };
        const list = await listPriceChanges(auth.organizationId, {
          ...(days !== undefined ? { days } : {}),
        });
        if (includeBelowThreshold) return ok(list);
        return ok({ ...list, changes: list.changes.filter((c) => !c.belowThreshold) });
      },
    },
    {
      name: "list_catalog_price_changes",
      title: "List every list-price change on a pricing platform",
      description:
        "Every on-demand list-price change on one instance pricing platform (`ec2`, `rds`, " +
        "`elasticache`, `azure`, `gcp`, `alibaba`, `runpod`, `hetzner`, `oracle`, `ibm`, `ovh`...) " +
        "over the last `days`, whether or not the organization runs the type, for the headline " +
        "variant (Linux, shared tenancy, standard priority). Newest first; `platforms` lists " +
        "every platform available.",
      inputSchema: {
        platform: Schema.optionalKey(
          Schema.String.annotate({ description: "The pricing platform. Default `ec2`." }),
        ),
        days: Schema.optionalKey(
          Schema.Int.check(
            Schema.isBetween({ minimum: catalogDays.min, maximum: catalogDays.max }),
          ).annotate({ description: `How far back, in days. Default ${catalogDays.default}.` }),
        ),
      },
      risk: "read",
      // Mirrors `GET /price-changes/catalog`.
      permission: "resources:read",
      handler: async (input) => {
        const { platform, days } = input as { platform?: string; days?: number };
        return ok(
          await listCatalogPriceChanges({
            ...(platform ? { platform } : {}),
            ...(days !== undefined ? { days } : {}),
          }),
        );
      },
    },
  ];
}
