import { z } from "../zod";
import { strict, ErrorResponses, OrgIdParam, Uuid } from "../common";
import type { BuildContext } from "../context";
// One definition of the raw-vs-adjusted shape, shared with the cost query.
import { CostAdjustmentSummary } from "./billing-rules";

/**
 * `GET /costs/showback`: spend grouped by cost centre. The cost centres and
 * allocation rules it reads are served by the `cost-centres` HttpApi domain
 * (`http/domains/cost-centres/`); this report is a cost read, documented with
 * the `/costs` routes until they move.
 */

const IsoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .openapi({ example: "2026-07-01" });

const CurrencyAmounts = z
  .record(z.string(), z.number())
  .openapi({ description: "Currency code → amount in the currency's major unit." });

const ShowbackReport = strict({
  from: IsoDate,
  to: IsoDate,
  currencies: z.array(z.string()),
  adjustment: CostAdjustmentSummary.optional().openapi({
    description:
      "Set when `adjusted=true`: the rules in force, the collected totals for the same period, " +
      "and the pro-rated fixed charges. Its absence means every figure above is exactly what " +
      "the providers charged.",
  }),
  centres: z
    .array(
      strict({
        costCentreId: Uuid.nullable().openapi({
          description: 'Null for the synthetic "Unallocated" bucket.',
        }),
        name: z.string(),
        totals: CurrencyAmounts.openapi({
          description:
            "Spend allocated directly to this centre. A cost row is allocated exactly once, so " +
            "summing this across every entry equals the organization's spend for the period.",
        }),
        subtreeTotals: CurrencyAmounts.openapi({
          description:
            "This centre's own spend plus every descendant's. Equal to `totals` for a leaf and " +
            "for every centre in an organization that does not nest. Do not sum this across " +
            "entries: parents already contain their children.",
        }),
        parentId: Uuid.nullable().openapi({
          description: "The centre this one sits under; null for a root and for Unallocated.",
        }),
        depth: z.number().int().openapi({ description: "0 for a root; the indentation level." }),
      }),
    )
    .openapi({
      description:
        "Depth-first: each centre immediately followed by its children, siblings name-sorted, " +
        'with the "Unallocated" bucket last.',
    }),
}).openapi("ShowbackReport");

const RangeQuery = strict({
  from: IsoDate.optional().openapi({ description: "Defaults to 30 days ago." }),
  to: IsoDate.optional().openapi({ description: "Defaults to today." }),
  basis: z
    .enum(["cash", "amortized", "blended"])
    .optional()
    .openapi({
      description:
        "Which money to sum. `cash` (the default) is what the provider charged on the day it " +
        "charged it; `amortized` spreads a commitment's up-front fee across the term it buys; " +
        "`blended` also spreads each commitment's discount evenly over all the usage it could " +
        "cover. Providers that report no amortized amount fall back to their cash amount.",
    }),
  adjusted: z
    .enum(["true", "false"])
    .optional()
    .openapi({
      description:
        "Apply the organization's billing rules (see /billing-rules): markups multiply, and a " +
        "reallocation moves a centre's spend onto another centre. Off by default; a chargeback " +
        "report that silently showed marked-up numbers is one the receiving team could not " +
        "reconcile. On, the response carries `adjustment` with the collected totals beside the " +
        "adjusted ones. Fixed-amount rules are booked onto the cost centre they name (or " +
        '"Unallocated" when they name none), pro-rated across the period.',
    }),
});

export function registerShowbackPaths(ctx: BuildContext) {
  const { registry } = ctx;

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/costs/showback",
    tags: ["Costs"],
    summary: "Spend grouped by cost centre (showback)",
    description:
      "Runs the org's allocation rules over collected spend and sums per cost centre and " +
      'currency. Spend no rule claims comes back as the "Unallocated" bucket; every defined ' +
      "centre appears even with zero spend.\n\n" +
      "Cost centres nest, so the list is a depth-first tree. Each entry carries `totals` (spend " +
      "allocated directly to it) and `subtreeTotals` (its own plus every descendant's). " +
      '"Engineering, of which Platform" needs both. Rules still evaluate first-match-wins by ' +
      "ascending priority against a flat list, so a row is allocated exactly once even when a " +
      "rule targets a parent and another targets its child; at equal priority the more deeply " +
      "nested centre wins.",
    request: { params: OrgIdParam, query: RangeQuery },
    responses: {
      200: {
        description: "Showback report",
        content: { "application/json": { schema: ShowbackReport } },
      },
      400: ErrorResponses[400],
    },
  });
}
