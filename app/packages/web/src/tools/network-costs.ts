/**
 * Kubernetes network cost tools: the MCP/chat view of the per-cluster network
 * report, through the same server-core reads the Costs panel uses, so an
 * agent's figure and the page's are the same figure.
 */
import { z } from "zod";
import { loadAccountStatuses } from "@infrawrench/server-core/network-flow/feed";
import {
  getKubernetesNetworkReport,
  KubernetesNetworkError,
  setKubernetesNetworkSettings,
} from "@infrawrench/server-core/network-flow/kubernetes";
import { err, ok, type ToolDefinition } from "./types";

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function networkCostTools(): ToolDefinition[] {
  return [
    {
      name: "get_kubernetes_network_costs",
      title: "Get a Kubernetes cluster's network costs",
      description:
        "Pod-level network cost attribution for one Kubernetes account: bytes and money by " +
        "traffic class (intra_zone, cross_zone, cross_region, internet_egress, unknown), by " +
        "namespace and by workload, plus the top workload → peer pairs. Omit `accountId` to " +
        "list the clusters that report pod traffic. `estimatedCost` is bytes at the published " +
        "rate of the cloud the nodes run on; `allocatedCost` is the cluster's real billed " +
        "data transfer apportioned by that estimate (only when a billed source is set), and " +
        "never sums to more than was billed; `totals.unallocatedCost` is the remainder. Each " +
        "row's `method` says how it was measured: `flow_log` (cloud VPC flow logs through the " +
        "node), `in_cluster_flows` (Cilium Hubble named the peer), `counter_estimate` (kubelet " +
        "byte counter only, no destination: weakest). Always mention the method mix and " +
        "whether figures are estimated or allocated.",
      inputSchema: {
        accountId: z
          .string()
          .optional()
          .describe("Kubernetes account id. Omit to list the clusters available."),
        from: z.string().regex(ISO_DAY).optional().describe("Inclusive start day, YYYY-MM-DD."),
        to: z.string().regex(ISO_DAY).optional().describe("Inclusive end day, YYYY-MM-DD."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .describe("Top talker pairs to return. Defaults to 25."),
      },
      risk: "read",
      permission: "costs:read",
      handler: async (input, auth) => {
        const { accountId, from, to, limit } = input as {
          accountId?: string;
          from?: string;
          to?: string;
          limit?: number;
        };
        if (!accountId) {
          const clusters = (await loadAccountStatuses(auth.organizationId))
            .filter((a) => a.supportsFlows && a.recut)
            .map((a) => ({
              accountId: a.accountId,
              displayName: a.displayName,
              collectedThrough: a.collectedThrough,
              lastError: a.lastError,
            }));
          return ok({ clusters });
        }
        const end = to ?? isoDay(Date.now());
        const start = from ?? isoDay(Date.parse(end) - 13 * 86_400_000);
        if (start > end) return err("from must be on or before to");
        try {
          return ok(
            await getKubernetesNetworkReport(auth.organizationId, accountId, {
              from: start,
              to: end,
              ...(limit ? { limit } : {}),
            }),
          );
        } catch (e) {
          if (e instanceof KubernetesNetworkError) return err(e.message);
          throw e;
        }
      },
    },
    {
      name: "set_kubernetes_network_billed_source",
      title: "Set a cluster's billed data-transfer source",
      description:
        "Say which billed cost rows are a Kubernetes cluster's data transfer, in the cost query " +
        "language (e.g. `account = 'acc_123' AND service = 'AWS Data Transfer'`; use the cost " +
        "dimension tools to find real values). Network costs then apportion that billed money " +
        "across the cluster's workloads instead of showing list prices. Pass null to clear. A " +
        "query that narrows nothing is refused.",
      inputSchema: {
        accountId: z.string().describe("Kubernetes account id."),
        billedQuery: z
          .string()
          .max(4000)
          .nullable()
          .describe("Cost query language text, or null to clear."),
      },
      risk: "write",
      permission: "costs:write",
      handler: async (input, auth) => {
        const { accountId, billedQuery } = input as {
          accountId: string;
          billedQuery: string | null;
        };
        try {
          return ok(
            await setKubernetesNetworkSettings(
              auth.organizationId,
              accountId,
              { billedQuery },
              auth.userId,
            ),
          );
        } catch (e) {
          if (e instanceof KubernetesNetworkError) return err(e.message);
          throw e;
        }
      },
    },
  ];
}
