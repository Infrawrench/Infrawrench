/**
 * Cost & budget tools — expose the cloud-spend surface (ClickHouse cost_daily
 * + Postgres budgets) to MCP clients and the chat agent. Unlike the resource
 * tools, these guard org-wide spend data, so every handler enforces the same
 * `costs:read` / `budgets:*` permissions as the HTTP API.
 */
import { z } from "zod";
import {
  COST_DIMENSIONS,
  COST_QUERY_LANGUAGE_SUMMARY,
  budgetInputSchema,
  costQueryRequestSchema,
} from "@infrawrench/ui/cost/config";
import {
  CostQueryError,
  getOrgCostStatus,
  listCostDimensionValues,
  listCostTagKeys,
  runCostQuery,
} from "../services/cost-query";
import {
  createBudget,
  getBudgetWithStatus,
  listBudgetEvents,
  listBudgetsWithStatus,
  softDeleteBudget,
  updateBudget,
} from "../services/budgets";
import { listSavedCostFilters as listSavedCostFiltersForOrg } from "../services/saved-cost-filters";
import { logAudit } from "../services/audit";
import { getAccountTagCompliance, getUntaggedSpendReport } from "../services/tag-policy";
import { getShowbackReport } from "../services/showback";
import { getOrgTagPolicy } from "@infrawrench/server-core/cost/tag-policy";
import { getCommitmentsFeed } from "@infrawrench/server-core/commitments/feed";
import { denyUnlessPermitted } from "./permissions";
import { ok, err, type ToolDefinition } from "./types";

const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");

/** Resolve optional from/to tool args; defaults to the trailing 30 days. */
function toolRange(input: Record<string, unknown>): { from: string; to: string } | null {
  const from =
    (input["from"] as string | undefined) ??
    new Date(Date.now() - 29 * 86_400_000).toISOString().slice(0, 10);
  const to = (input["to"] as string | undefined) ?? new Date().toISOString().slice(0, 10);
  return from <= to ? { from, to } : null;
}

export function costTools(): ToolDefinition[] {
  return [
    {
      name: "query_costs",
      title: "Query costs",
      description:
        "Aggregate daily cloud spend across all connected accounts into time series. " +
        "Dates are inclusive YYYY-MM-DD. Group by " +
        "provider/account/service/region/resource/tag/charge_type/commitment " +
        "(groupByTagKey required for tag), filter on the same dimensions, choose " +
        "daily/weekly/monthly/cumulative binning, and optionally include the previous period " +
        "(comparePreviousPeriod) or a trend forecast (forecast). Amounts are in the returned " +
        'currency\'s major unit; groups beyond topN fold into an "Other" series.\n\n' +
        "costBasis picks the money: 'cash' (default) is what the provider charged on the day it " +
        "charged it; 'amortized' spreads a commitment's up-front fee across the term it buys, " +
        "which is the right number for an org holding reservations or savings plans. Providers " +
        "that report no amortized amount fall back to their cash amount rather than dropping " +
        "out. chargeTypes narrows to particular kinds of charge (usage, " +
        "commitment_covered_usage, commitment_fee, commitment_discount, credit, tax, refund, " +
        "adjustment, support, other); omitting it includes all of them, which is what makes a " +
        "total net rather than gross — filter to ['usage','commitment_covered_usage'] to see " +
        "whether consumption is growing underneath a credit that is masking it. Note that " +
        "commitment-covered usage is priced at zero on the cash basis by both AWS and Azure, " +
        "so pair it with costBasis 'amortized' to see what those hours are worth." +
        "\n\nThe filter can also be written as text in the cost query language via `query`, " +
        "which is usually easier than assembling `filters` by hand: " +
        "`provider = 'aws' AND service IN ('AmazonEC2','AmazonS3') AND tag['env'] != 'dev'`. " +
        COST_QUERY_LANGUAGE_SUMMARY +
        " Send `query` or `filters`, never both — both is an error, not a precedence rule. A " +
        "query that does not parse comes back with the character offset of the mistake and the " +
        "valid alternatives there; use list_cost_dimension_values to discover real values first." +
        "\n\n`savedFilterId` applies one of the organization's saved cost filters (see " +
        "list_saved_cost_filters) by reference: it is resolved server-side at query time and " +
        "AND-composed with whichever of `filters`/`query` is present. Prefer it when the user " +
        "names a scope they have saved ('prod only') — it is guaranteed to mean exactly what " +
        "that name means in their graphs, reports and budgets. An id that no longer resolves " +
        "is an error, never an unfiltered result.",
      inputSchema: costQueryRequestSchema.shape,
      risk: "read",
      permission: "costs:read",
      handler: async (input, auth) => {
        const denied = await denyUnlessPermitted(auth, "costs:read");
        if (denied) return denied;
        const parsed = costQueryRequestSchema.safeParse(input);
        if (!parsed.success) return err(`Invalid query: ${parsed.error.message}`);
        try {
          return ok(await runCostQuery(auth.organizationId, parsed.data));
        } catch (e) {
          if (e instanceof CostQueryError) return err(e.message);
          throw e;
        }
      },
    },

    {
      name: "list_saved_cost_filters",
      title: "List saved cost filters",
      description:
        "The organization's saved cost filters — named, reusable filter sets ('prod only', " +
        "'team platform') that graphs, reports and budgets apply by reference. Each row " +
        "carries the structured filters and the same filter as cost-query-language text. Use " +
        "an id from here as query_costs' savedFilterId, or to set a budget's or graph " +
        "config's savedFilterId, when the user refers to a scope by its saved name.",
      inputSchema: {},
      risk: "read",
      permission: "costs:read",
      handler: async (_input, auth) => {
        const denied = await denyUnlessPermitted(auth, "costs:read");
        if (denied) return denied;
        return ok(await listSavedCostFiltersForOrg(auth.organizationId));
      },
    },

    {
      name: "list_cost_dimension_values",
      title: "List cost dimension values",
      description:
        "List the distinct values present in the organization's cost data for a dimension " +
        "(with display labels), or the available tag keys via dimension=tag-keys. Use this to " +
        "discover valid filter/group-by values before calling query_costs.",
      inputSchema: {
        dimension: z.enum([...COST_DIMENSIONS, "tag-keys"]),
        tagKey: z.string().optional().describe("Required when dimension is 'tag'."),
      },
      risk: "read",
      permission: "costs:read",
      handler: async (input, auth) => {
        const denied = await denyUnlessPermitted(auth, "costs:read");
        if (denied) return denied;
        const { dimension, tagKey } = input as { dimension: string; tagKey?: string };
        if (dimension === "tag-keys") {
          return ok(await listCostTagKeys(auth.organizationId));
        }
        try {
          return ok(await listCostDimensionValues(auth.organizationId, dimension, tagKey));
        } catch (e) {
          if (e instanceof CostQueryError) return err(e.message);
          throw e;
        }
      },
    },

    {
      name: "get_cost_status",
      title: "Get cost collection status",
      description:
        "Per-account cost data coverage: whether the provider plugin supports cost collection, " +
        "when spend was last polled, backfill state, and the date range covered. Check this when " +
        "query_costs returns empty or surprising data.\n\n" +
        "Three capability flags decide how the numbers should be read. `amortization` says the " +
        "provider reports an amortized amount, so costBasis='amortized' is meaningful for it; " +
        "`chargeTypes` says it distinguishes usage from credits, tax and commitments (when " +
        "false, every one of its rows is 'usage'); and `estimated` says the amounts were " +
        "computed by Infrawrench from inventory and a published rate card rather than billed by " +
        "the provider — those cannot be reconciled against an invoice, run low for anything " +
        "deleted mid-period, price everything at list, and never include credits, tax or refunds. " +
        "Say so when reporting a total that includes an estimated account.",
      inputSchema: {},
      risk: "read",
      permission: "costs:read",
      handler: async (_input, auth) => {
        const denied = await denyUnlessPermitted(auth, "costs:read");
        if (denied) return denied;
        return ok(await getOrgCostStatus(auth.organizationId));
      },
    },

    {
      name: "get_commitments",
      title: "Get commitments and savings planner",
      description:
        "The org's purchased commitments — reserved instances, savings plans, committed-use " +
        "discounts — with coverage, utilization, and commitment-size recommendations.\n\n" +
        "Read the numbers as documented, they are deliberately conservative: coverage is a " +
        "*range* (broadRatio is a lower bound over all usage; narrowRatio an upper bound over " +
        "commitment-eligible cells) and accounts whose plugin cannot distinguish charge types " +
        "are excluded (`excludedAccountIds`) rather than dragging the ratio down. Utilization " +
        "is measured only over days with collected cost data — `missingDays` are reported, " +
        "never counted as idle — and null utilization means 'not measurable' (see `reason`), " +
        "never 0%. Planner savings are quoted against published 'up to' discount rates; " +
        "respect `savingBasis` when reporting them ('up to $X', not '$X'). Every " +
        "recommendation carries its own break-even: at discount d the workload can shrink by d " +
        "before the commitment loses money. Never suggest an automatic purchase — there is no " +
        "purchase surface, by design.",
      inputSchema: {},
      risk: "read",
      permission: "costs:read",
      handler: async (_input, auth) => {
        const denied = await denyUnlessPermitted(auth, "costs:read");
        if (denied) return denied;
        return ok(await getCommitmentsFeed(auth.organizationId));
      },
    },

    {
      name: "get_tag_compliance",
      title: "Get tag compliance",
      description:
        "The organization's tag policy (required tag keys, optionally with allowed values) and " +
        "per-account compliance: how many of each account's resources carry every required tag. " +
        "Resources whose stored record exposes no tags/labels field are counted in " +
        "totalResources but excluded from the score.",
      inputSchema: {},
      risk: "read",
      permission: "resources:read",
      handler: async (_input, auth) => {
        const denied = await denyUnlessPermitted(auth, "resources:read");
        if (denied) return denied;
        const [policy, accounts] = await Promise.all([
          getOrgTagPolicy(auth.organizationId),
          getAccountTagCompliance(auth.organizationId),
        ]);
        return ok({ policy, accounts });
      },
    },

    {
      name: "query_untagged_spend",
      title: "Query untagged spend",
      description:
        "Spend on cost rows missing at least one of the organization's required tag keys, " +
        "overall and per key, plus the largest untagged (account, service) buckets. Dates are " +
        "inclusive YYYY-MM-DD, defaulting to the trailing 30 days. Empty when the org has no " +
        "tag policy.",
      inputSchema: { from: isoDay.optional(), to: isoDay.optional() },
      risk: "read",
      permission: "costs:read",
      handler: async (input, auth) => {
        const denied = await denyUnlessPermitted(auth, "costs:read");
        if (denied) return denied;
        const range = toolRange(input as Record<string, unknown>);
        if (!range) return err("from must not be after to");
        return ok(await getUntaggedSpendReport(auth.organizationId, range.from, range.to));
      },
    },

    {
      name: "query_showback",
      title: "Query showback",
      description:
        "Spend grouped by cost centre through the organization's allocation rules " +
        "(first-match-wins on tag key/value, account, provider, service). Spend no rule claims " +
        'lands in the "Unallocated" bucket. Dates are inclusive YYYY-MM-DD, defaulting to the ' +
        "trailing 30 days.\n\n" +
        "Cost centres nest, so `centres` is a depth-first tree: each entry carries `parentId` " +
        "and `depth` alongside two sets of amounts. `totals` is spend allocated **directly** to " +
        "that centre — a cost row is allocated exactly once, so summing `totals` across every " +
        "entry equals the organization's spend for the period. `subtreeTotals` is that centre " +
        'plus every descendant, which is the number to quote for "what does Engineering cost"; ' +
        "never sum `subtreeTotals` across entries, because parents already contain their " +
        "children. For a flat organization, and for every leaf, the two are equal.",
      inputSchema: {
        from: isoDay.optional(),
        to: isoDay.optional(),
        adjusted: z.boolean().optional(),
      },
      risk: "read",
      permission: "costs:read",
      handler: async (input, auth) => {
        const denied = await denyUnlessPermitted(auth, "costs:read");
        if (denied) return denied;
        const args = input as Record<string, unknown>;
        const range = toolRange(args);
        if (!range) return err("from must not be after to");
        return ok(
          await getShowbackReport(
            auth.organizationId,
            range.from,
            range.to,
            undefined,
            undefined,
            args["adjusted"] === true,
          ),
        );
      },
    },

    {
      name: "list_billing_rules",
      title: "List billing rules",
      description:
        "The organization's billing rules — its own adjustments to collected spend. A rule " +
        "matches spend (tag key/value, account, provider, service, charge type) and adjusts " +
        "it: a percentage markup or discount, a fixed amount per day or month, or a " +
        "reallocation that moves the spend onto another cost centre or account.\n\n" +
        "**Nothing here is ever written into the stored cost data.** Rules are applied at " +
        "query time, so collected spend is always still exactly what the provider reported. " +
        "Use this to explain a discrepancy: when an adjusted total does not match an invoice, " +
        "these rules are the reason, and each row's `summary` says what it does to which " +
        "spend.\n\n" +
        "Ordering matters and works in two different ways. Every matching percentage rule " +
        "applies, so two 10% markups compound to 21% rather than 20%. Reallocation is " +
        "first-match-wins by ascending priority, so a row moves exactly once and the " +
        "organization's total is unchanged by any reallocation. Disabled rules are listed but " +
        "affect nothing.",
      inputSchema: {},
      risk: "read",
      permission: "costs:read",
      handler: async (_input, auth) => {
        const denied = await denyUnlessPermitted(auth, "costs:read");
        if (denied) return denied;
        return ok(await listBillingRulesForOrg(auth.organizationId));
      },
    },

    {
      name: "list_budgets",
      title: "List budgets",
      description:
        "List the organization's monthly cost budgets with current-month actual and forecast " +
        "spend (in cents) and any alert thresholds fired this month.",
      inputSchema: {},
      risk: "read",
      permission: "budgets:read",
      handler: async (_input, auth) => {
        const denied = await denyUnlessPermitted(auth, "budgets:read");
        if (denied) return denied;
        return ok(await listBudgetsWithStatus(auth.organizationId));
      },
    },

    {
      name: "get_budget",
      title: "Get budget",
      description:
        "Fetch one budget with current-month actual/forecast status plus its alert history " +
        "(up to the last 100 fired thresholds across months).",
      inputSchema: { budgetId: z.string() },
      risk: "read",
      permission: "budgets:read",
      handler: async (input, auth) => {
        const denied = await denyUnlessPermitted(auth, "budgets:read");
        if (denied) return denied;
        const budgetId = input["budgetId"] as string;
        const budget = await getBudgetWithStatus(auth.organizationId, budgetId);
        if (!budget) return err(`Budget not found: ${budgetId}`);
        const events = await listBudgetEvents(auth.organizationId, budgetId);
        return ok({ ...budget, events: events ?? [] });
      },
    },

    {
      name: "create_budget",
      title: "Create budget",
      description:
        "Create a monthly cost budget. amountCents is the monthly limit in the currency's minor " +
        "unit. Thresholds fire once per month when actual or forecast spend crosses the given " +
        "percent of the budget. Filters (same shape as query_costs) scope the budget to a slice " +
        "of spend; empty filters cover the whole organization. Audit-logged.",
      inputSchema: budgetInputSchema.shape,
      risk: "write",
      permission: "budgets:write",
      handler: async (input, auth) => {
        const denied = await denyUnlessPermitted(auth, "budgets:write");
        if (denied) return denied;
        const parsed = budgetInputSchema.safeParse(input);
        if (!parsed.success) return err(`Invalid budget: ${parsed.error.message}`);
        const created = await createBudget(auth.organizationId, parsed.data, auth.userId);
        void logAudit({
          organizationId: auth.organizationId,
          userId: auth.userId,
          action: "budget.create",
          entityType: "budget",
          entityId: created.id,
          metadata: { name: created.name, amountCents: created.amountCents, source: auth.source },
        });
        return ok(created);
      },
    },

    {
      name: "update_budget",
      title: "Update budget",
      description:
        "Replace a budget's name, amount, currency, filters, and thresholds. Alert history is " +
        "kept. Audit-logged.",
      inputSchema: { budgetId: z.string(), ...budgetInputSchema.shape },
      risk: "write",
      permission: "budgets:write",
      handler: async (input, auth) => {
        const denied = await denyUnlessPermitted(auth, "budgets:write");
        if (denied) return denied;
        const { budgetId, ...rest } = input as { budgetId: string } & Record<string, unknown>;
        const parsed = budgetInputSchema.safeParse(rest);
        if (!parsed.success) return err(`Invalid budget: ${parsed.error.message}`);
        const updated = await updateBudget(auth.organizationId, budgetId, parsed.data);
        if (!updated) return err(`Budget not found: ${budgetId}`);
        void logAudit({
          organizationId: auth.organizationId,
          userId: auth.userId,
          action: "budget.update",
          entityType: "budget",
          entityId: updated.id,
          metadata: { name: updated.name, amountCents: updated.amountCents, source: auth.source },
        });
        return ok(updated);
      },
    },

    {
      name: "delete_budget",
      title: "Delete budget",
      description:
        "Delete a budget (soft delete — alert history is retained). Audit-logged. The chat " +
        "surface confirms with the user before invoking.",
      inputSchema: { budgetId: z.string() },
      risk: "destructive",
      permission: "budgets:write",
      handler: async (input, auth) => {
        const denied = await denyUnlessPermitted(auth, "budgets:write");
        if (denied) return denied;
        const budgetId = input["budgetId"] as string;
        const deleted = await softDeleteBudget(auth.organizationId, budgetId);
        if (!deleted) return err(`Budget not found: ${budgetId}`);
        void logAudit({
          organizationId: auth.organizationId,
          userId: auth.userId,
          action: "budget.delete",
          entityType: "budget",
          entityId: budgetId,
          metadata: { source: auth.source },
        });
        return ok({ ok: true });
      },
    },
  ];
}
