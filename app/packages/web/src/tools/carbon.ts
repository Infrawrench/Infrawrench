/**
 * Carbon tools: the MCP/chat view of the carbon estimate, beside the cost
 * tools. Both are reads.
 *
 * `get_carbon_estimate` is the Costs page's carbon section; the per-resource
 * one answers "what does this cost, and what does it emit" together, through
 * the same server-core reads the detail view uses, so an agent's figure and
 * the page's are the same figure.
 */
import { z } from "zod";
import { and, eq, isNull } from "drizzle-orm";
import { CARBON_LIMITS } from "@infrawrench/client-core";
import { getCarbonEstimate, getResourceCarbon } from "@infrawrench/server-core/cost/carbon";
import { estimateResourceCost } from "@infrawrench/server-core/cost/estimate";
import { db } from "../db/client";
import { resources } from "../db/schema";
import { err, ok, type ToolDefinition } from "./types";

export function carbonTools(): ToolDefinition[] {
  return [
    {
      name: "get_carbon_estimate",
      title: "Get the carbon estimate",
      description:
        "Estimated operational CO2e of the org's compute over a window, grouped by provider, " +
        "region and account, with the heaviest resources first. An ESTIMATE: vCPUs × published " +
        "watts-per-vCPU × hours × datacentre PUE × published grid intensity, at an assumed 50% " +
        "CPU utilisation. Grid figures are Cloud Carbon Footprint's for AWS/GCP/Azure and " +
        "Ember 2024 country figures for other providers. Anything that cannot be placed (no " +
        "region figure, no vCPU count) is listed under `unestimated` with a reason and adds " +
        "nothing to the total; always report `unestimatedCount` beside the total so it is not " +
        "read as complete. Covers processors only: no storage, memory, network or embodied " +
        "emissions.",
      inputSchema: {
        windowDays: z
          .number()
          .int()
          .min(CARBON_LIMITS.minWindowDays)
          .max(CARBON_LIMITS.maxWindowDays)
          .optional()
          .describe("Days the estimate covers. Defaults to 30."),
      },
      risk: "read",
      permission: "costs:read",
      handler: async (input, auth) => {
        const { windowDays } = input as { windowDays?: number };
        return ok(
          await getCarbonEstimate(
            auth.organizationId,
            windowDays === undefined ? {} : { windowDays },
          ),
        );
      },
    },
    {
      name: "estimate_resource_footprint",
      title: "Estimate a resource's monthly cost and carbon",
      description:
        "The monthly cost estimate (provider list price, itemized) and the estimated monthly " +
        "CO2e of one resource, or of a proposed edit to it when `fields` is given (merged over " +
        "its stored fields, e.g. { instanceType: 'm7g.large' } to compare a resize). Either " +
        "half may be null: `cost` when the plugin publishes no rates, `carbon.estimate` when " +
        "the region or size cannot be placed (`carbon.reason` says which). `carbon.role` " +
        "'aggregate' means a cluster whose machines are counted in their own right.",
      inputSchema: {
        resourceId: z.string().describe("Infrawrench resource id."),
        fields: z
          .record(z.string(), z.string())
          .optional()
          .describe("Proposed field values to price instead of the current ones."),
      },
      risk: "read",
      permission: "resources:read",
      handler: async (input, auth) => {
        const { resourceId, fields } = input as {
          resourceId: string;
          fields?: Record<string, string>;
        };
        const [row] = await db
          .select({ accountId: resources.accountId, resourceTypeId: resources.resourceTypeId })
          .from(resources)
          .where(
            and(
              eq(resources.id, resourceId),
              eq(resources.organizationId, auth.organizationId),
              isNull(resources.deletedAt),
            ),
          )
          .limit(1);
        if (!row) return err(`Resource ${resourceId} not found`);
        const target = { ...row, resourceId, fields };
        const [cost, carbon] = await Promise.all([
          estimateResourceCost(auth.organizationId, target),
          getResourceCarbon(auth.organizationId, target).catch(() => null),
        ]);
        return ok({ resourceId, cost, carbon });
      },
    },
  ];
}
