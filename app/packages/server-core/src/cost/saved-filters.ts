/**
 * Query-time resolution of a saved cost filter reference.
 *
 * Lives in server-core, not the web package, because the two consumers span
 * both: `runCostQuery` (web — the HTTP API, the MCP/chat tools, and therefore
 * the CLI) and `budgetMonthStatus` (here — also driven by the poller's budget
 * evaluation pass). One resolver means every surface agrees on the one rule
 * that matters:
 *
 * **A reference that fails to resolve is an error, never an empty filter.**
 * A saved filter is subtractive — it narrows scope — so the failure mode of
 * "couldn't find it, carry on" is running the query over *everything*. For a
 * graph that is a wrong chart; for a budget it re-scopes the alert to all
 * spend, which can fire a page that should not fire or, worse, keep one quiet
 * that should. Deletion of a referenced filter is refused at the API
 * (services/saved-cost-filters.ts in web), so hitting this error means a race
 * or corrupt data — both worth a loud failure.
 */
import { and, eq, isNull } from "drizzle-orm";

import { db } from "../db/client";
import { savedCostFilters } from "../db/schema";
import type { CostFilter } from "../clickhouse/cost-readers";

/** A `savedFilterId` that does not resolve to a live filter in the org. */
export class SavedCostFilterResolutionError extends Error {
  override readonly name = "SavedCostFilterResolutionError";
  readonly savedFilterId: string;

  constructor(savedFilterId: string) {
    super(
      `Saved cost filter ${savedFilterId} not found — it may have been deleted. ` +
        "Refusing to run without it: dropping a filter silently would return unfiltered spend.",
    );
    this.savedFilterId = savedFilterId;
  }
}

/**
 * The filters stored under `savedFilterId`, to be AND-composed with whatever
 * inline filters the caller already has.
 *
 * @throws {SavedCostFilterResolutionError} when the id does not name a live
 * saved filter in this org.
 */
export async function resolveSavedCostFilters(
  organizationId: string,
  savedFilterId: string,
): Promise<CostFilter[]> {
  const [row] = await db
    .select({ filters: savedCostFilters.filters })
    .from(savedCostFilters)
    .where(
      and(
        eq(savedCostFilters.id, savedFilterId),
        eq(savedCostFilters.organizationId, organizationId),
        isNull(savedCostFilters.deletedAt),
      ),
    )
    .limit(1);
  if (!row) throw new SavedCostFilterResolutionError(savedFilterId);
  return (row.filters ?? []) as CostFilter[];
}
