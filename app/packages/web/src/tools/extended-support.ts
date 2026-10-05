/**
 * Extended-support tool: the MCP/chat view of the Costs panel's Extended
 * support section. Read-only; upgrades are the provider's own operation.
 */
import { z } from "zod";
import type { ExtendedSupportStatus } from "@infrawrench/client-core";
import { listExtendedSupportWithBilling } from "../services/extended-support";
import { ok, type ToolDefinition } from "./types";

export function extendedSupportTools(): ToolDefinition[] {
  return [
    {
      name: "list_extended_support",
      title: "List extended-support findings",
      description:
        "Resources running a version past (or about to leave) its provider's standard support: " +
        "EKS / AKS / GKE / DOKS clusters, RDS and Aurora, ElastiCache Redis OSS, OpenSearch, " +
        "Azure Database for MySQL/PostgreSQL, Cloud SQL, MongoDB Atlas, Elastic deployments. " +
        "Each finding gives the current and target version, the date the surcharge started or " +
        "starts, the forced-upgrade date, and the monthly surcharge an upgrade removes " +
        "(`monthlySurcharge`; `costBasis` says whether it is billed or list price). " +
        "`currentMonthly` totals what is being paid now. Results are cached for a few minutes.",
      inputSchema: {
        status: z
          .enum(["end-of-life", "surcharged", "unsupported", "upcoming"])
          .optional()
          .describe("Only return findings in this status."),
        refresh: z
          .boolean()
          .optional()
          .describe("Bypass the short server-side cache and recompute now."),
      },
      risk: "read",
      // Mirrors `GET /extended-support`.
      permission: "resources:read",
      handler: async (input, auth) => {
        const { status, refresh } = input as { status?: ExtendedSupportStatus; refresh?: boolean };
        const feed = await listExtendedSupportWithBilling(auth.organizationId, {
          refresh: Boolean(refresh),
        });
        if (!status) return ok(feed);
        // Totals and counts stay whole-feed so a filtered answer still shows
        // the overall picture: the list_posture_findings stance.
        return ok({ ...feed, findings: feed.findings.filter((f) => f.status === status) });
      },
    },
  ];
}
