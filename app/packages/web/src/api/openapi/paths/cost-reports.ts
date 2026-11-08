/**
 * The cost report component the Zod spec of routes still on Hono embeds
 * (resource and efficiency reports). The report routes themselves are
 * documented by their HttpApi domain (`http/domains/cost-reports/`), whose
 * Effect definition of `CostDateRange` replaces this one in the merged document.
 */
import { z } from "../zod";
import { strict } from "../common";

const IsoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .openapi({ example: "2026-07-01" });

export const CostDateRange = z
  .union([
    strict({
      kind: z.literal("relative"),
      preset: z.enum(["7d", "30d", "90d", "mtd", "last_month", "qtd", "ytd", "6m", "12m"]),
    }),
    strict({ kind: z.literal("absolute"), from: IsoDate, to: IsoDate }),
  ])
  .describe(
    "A relative preset resolves against today every time the report runs, so a saved report " +
      "keeps meaning 'the last 30 days'; an absolute range pins it to fixed dates.",
  )
  .openapi("CostDateRange");
