/**
 * AI attribution tools: billed AI spend split by caller, and the request-log
 * sources and dimensions behind it. Reads only; configuring a source
 * authorizes reads of the org's logs (sometimes billed to its own cloud
 * account) and stays a deliberate act in Settings or Terraform.
 */
import { z } from "zod";
import { AI_DIMENSION_KEY_PATTERN } from "@infrawrench/client-core";
import {
  listAiDimensions,
  listAiRequestSources,
} from "@infrawrench/server-core/ai-attribution/store";
import {
  getAiAttributionStats,
  getAiSpendBreakdown,
} from "@infrawrench/server-core/ai-attribution/stats";
import { denyUnlessPermitted } from "./permissions";
import { err, ok, type ToolDefinition } from "./types";

const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");

function range(input: Record<string, unknown>): { from: string; to: string } | null {
  const to = typeof input["to"] === "string" ? input["to"] : new Date().toISOString().slice(0, 10);
  const from =
    typeof input["from"] === "string"
      ? input["from"]
      : new Date(Date.now() - 29 * 86_400_000).toISOString().slice(0, 10);
  return from <= to ? { from, to } : null;
}

export function aiAttributionTools(): ToolDefinition[] {
  return [
    {
      name: "query_ai_spend_by_caller",
      title: "Query AI spend by caller",
      description:
        "Billed AI spend split by one caller dimension (team, user, feature, customer, or any " +
        "request-metadata key the org mapped), joined from per-request logs to the provider " +
        "bills. Each request is priced at list rates and scaled so the split adds up to the " +
        "billed amount; `(unattributed)` is billed spend no request log explained and " +
        "`(not set)` is spend from matched requests that carried none of the dimension's keys. " +
        "Always report `(unattributed)` beside the callers. Also returns per-provider coverage " +
        "(billed vs attributed) and per-source match rates; quote the match rate when it is " +
        "low, because a low rate means the split describes only part of the traffic. Omit " +
        "`dimension` to use the first mapped one. For a time series, query_costs grouped by " +
        "tag key `caller:<dimension>` gives the same split per day.",
      inputSchema: {
        dimension: z.string().optional().describe("Dimension key, e.g. team."),
        from: isoDay.optional(),
        to: isoDay.optional(),
      },
      risk: "read",
      permission: "costs:read",
      handler: async (input, auth) => {
        const denied = await denyUnlessPermitted(auth, "costs:read");
        if (denied) return denied;
        const args = input as Record<string, unknown>;
        const r = range(args);
        if (!r) return err("from must not be after to");
        const dimensions = await listAiDimensions(auth.organizationId);
        const dimension =
          typeof args["dimension"] === "string" ? args["dimension"] : dimensions[0]?.key;
        if (dimension !== undefined && !AI_DIMENSION_KEY_PATTERN.test(dimension)) {
          return err("dimension must be a dimension key");
        }
        if (dimension !== undefined && !dimensions.some((d) => d.key === dimension)) {
          return err(
            `No caller dimension "${dimension}". Mapped: ${dimensions.map((d) => d.key).join(", ") || "none"}.`,
          );
        }
        const [stats, spend] = await Promise.all([
          getAiAttributionStats(auth.organizationId, r.from, r.to),
          dimension ? getAiSpendBreakdown(auth.organizationId, dimension, r.from, r.to) : null,
        ]);
        return ok({ dimensions, stats, spend });
      },
    },
    {
      name: "list_ai_request_sources",
      title: "List AI request-log sources",
      description:
        "The org's AI request-log sources (Bedrock invocation logs, Cloudflare AI Gateway, " +
        "LiteLLM, custom JSONL in S3), each with the last day collected and any collection " +
        "error, plus the caller dimensions and the metadata keys feeding them. Use it to explain " +
        "a low match rate or a missing day.",
      inputSchema: {},
      risk: "read",
      permission: "costs:read",
      handler: async (_input, auth) => {
        const denied = await denyUnlessPermitted(auth, "costs:read");
        if (denied) return denied;
        const [sources, dimensions] = await Promise.all([
          listAiRequestSources(auth.organizationId),
          listAiDimensions(auth.organizationId),
        ]);
        return ok({ sources, dimensions });
      },
    },
  ];
}
