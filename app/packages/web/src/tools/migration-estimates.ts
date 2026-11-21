/**
 * Migration estimate tools: the MCP/chat view of the Migration estimates tab.
 * Read-only; estimates are saved and edited in the app (or through the API).
 *
 * They let an assistant answer "what would the checkout service cost on
 * Hetzner?" from the org's own resources, billed spend and the target's
 * published list prices, rather than from its training data. Permissions
 * mirror the routes (`costs:read`), and the current side runs under the
 * caller's cost visibility scope (`runToolHandler`).
 */
import { Schema } from "effect";
import type { MigrationEstimateResult } from "@infrawrench/client-core";
import {
  getMigrationEstimate,
  getMigrationEstimateService,
  listMigrationEstimates,
  MigrationEstimateInputError,
  MigrationEstimateSourceNotFoundError,
} from "@infrawrench/server-core/migration-estimate";
import { err, ok, type ToolDefinition } from "./types";

/** Size options per row a model sees: the match and a couple of alternatives. */
const MAX_CANDIDATES = 3;

/** The result trimmed for a model: each row's picker list cut to its head. */
function summarize(result: MigrationEstimateResult) {
  return {
    ...result,
    rows: result.rows.map((row) => ({
      ...row,
      candidates: row.candidates.slice(0, MAX_CANDIDATES),
      candidatesOmitted: Math.max(0, row.candidates.length - MAX_CANDIDATES),
    })),
  };
}

const GUIDE =
  "Each resource is matched by category to the target's equivalent type and the cheapest size " +
  "meeting or exceeding its vCPUs, memory and GPUs. `current` is what it costs now (`basis`: " +
  "billed spend over 30 days, the plugin's estimate, or list price); `target.cost` is the " +
  "target's list price or estimate. A null figure is unknown, never zero; `note` says why. " +
  "`totals.comparable.pairedDelta` is the honest change, over rows priced on both sides only. " +
  "`unmatched` lists resources with no equivalent and the reason. Report both sides and the " +
  "unknowns, and say the target prices are list prices without discounts.";

export function migrationEstimateTools(): ToolDefinition[] {
  return [
    {
      name: "list_migration_targets",
      title: "List migration estimate targets",
      description:
        "Providers a migration estimate can price on: each one's plugin id, the resource " +
        "categories it has an equivalent for (vm, managed-postgres, object-storage, ...), the " +
        "regions it can be priced in with their area, and whether pricing it needs an account " +
        "on it. Use the plugin id as `targetPluginId` in estimate_migration_cost.",
      inputSchema: {},
      risk: "read",
      permission: "costs:read",
      handler: async (_input, auth) =>
        ok({ providers: await getMigrationEstimateService().targets(auth.organizationId) }),
    },
    {
      name: "list_migration_estimates",
      title: "List saved migration estimates",
      description:
        "The org's saved migration estimates: name, source (a service or a set of resources), " +
        "target provider and region. Pass an `id` to estimate_migration_cost as `estimateId` " +
        "to price one now.",
      inputSchema: {},
      risk: "read",
      permission: "costs:read",
      handler: async (_input, auth) =>
        ok({ estimates: await listMigrationEstimates(auth.organizationId) }),
    },
    {
      name: "estimate_migration_cost",
      title: "Estimate a migration to another provider",
      description:
        "What a service's resources (or a list of resource ids, or a saved estimate) would " +
        `cost on another provider, beside what they cost now. ${GUIDE}`,
      inputSchema: {
        estimateId: Schema.optionalKey(
          Schema.String.annotate({ description: "A saved estimate's id; the rest is ignored." }),
        ),
        serviceId: Schema.optionalKey(
          Schema.String.annotate({ description: "A service's id or slug." }),
        ),
        resourceIds: Schema.optionalKey(
          Schema.Array(Schema.String).annotate({
            description: "Resource ids, instead of a service.",
          }),
        ),
        targetPluginId: Schema.optionalKey(
          Schema.String.annotate({
            description: "The provider to price on (see list_migration_targets).",
          }),
        ),
        targetRegion: Schema.optionalKey(
          Schema.String.annotate({
            description: "A target region id. Default: the one nearest the resources.",
          }),
        ),
      },
      risk: "read",
      permission: "costs:read",
      handler: async (input, auth) => {
        const args = input as {
          estimateId?: string;
          serviceId?: string;
          resourceIds?: string[];
          targetPluginId?: string;
          targetRegion?: string;
        };
        const service = getMigrationEstimateService();
        try {
          if (args.estimateId) {
            const saved = await getMigrationEstimate(auth.organizationId, args.estimateId);
            if (!saved) return err(`No saved migration estimate "${args.estimateId}".`);
            const result = await service.compute(auth.organizationId, saved, {
              estimateId: saved.id,
            });
            return ok(summarize(result));
          }
          if (!args.targetPluginId) return err("Say which provider to price on: targetPluginId.");
          const source = args.serviceId
            ? { kind: "service" as const, serviceId: args.serviceId }
            : args.resourceIds && args.resourceIds.length > 0
              ? { kind: "resources" as const, resourceIds: [...args.resourceIds] }
              : null;
          if (!source) return err("Say what to price: serviceId or resourceIds.");
          const result = await service.compute(auth.organizationId, {
            name: `${args.serviceId ?? `${args.resourceIds!.length} resources`} on ${args.targetPluginId}`,
            source,
            targetPluginId: args.targetPluginId,
            targetRegion: args.targetRegion ?? null,
            overrides: {},
          });
          return ok(summarize(result));
        } catch (e) {
          if (
            e instanceof MigrationEstimateInputError ||
            e instanceof MigrationEstimateSourceNotFoundError
          ) {
            return err(e.message);
          }
          throw e;
        }
      },
    },
  ];
}
