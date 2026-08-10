-- One-time data migration: teach stored cost exports about
-- `commitment_covered_usage`.
--
-- Until the AWS and Azure collectors learned to stamp it, consumption a
-- reservation or savings plan covered was collected as plain `usage` — there
-- was no other charge type it could be. So an export whose query holds
-- `chargeTypes: ["usage"]` was authored to mean "consumption", and the day the
-- collectors split consumption in two it silently began under-reporting by
-- exactly the commitment-covered spend. Silently is the problem: the export
-- keeps running, keeps succeeding, and the number in the warehouse just gets
-- smaller.
--
-- Appending the new member restores what the author selected. Doing it once,
-- here, rather than at read time is what keeps it from overriding intent: from
-- now on the picker offers both members, so an export that holds `["usage"]`
-- and not `["commitment_covered_usage"]` means on-demand only, and must be
-- taken literally.
--
-- Deliberately narrow:
--   * Exports with no `chargeTypes` key are untouched — absent already means
--     every charge type, so they were never narrowed and never lost anything.
--   * Exports that already list `commitment_covered_usage` are untouched, so
--     re-running this is a no-op.
--   * Only the top-level `chargeTypes` array is rewritten. A `charge_type`
--     entry in `query.filters` is left alone: `not_in` inverts the meaning of
--     appending, and the same filter vocabulary is stored by budgets, cost
--     reports and dashboard widgets, so a rewrite there is a product decision
--     rather than a repair.
UPDATE "cost_exports"
SET "query" = jsonb_set(
    "query",
    '{chargeTypes}',
    ("query" -> 'chargeTypes') || '["commitment_covered_usage"]'::jsonb
  )
WHERE jsonb_typeof("query" -> 'chargeTypes') = 'array'
  AND "query" -> 'chargeTypes' @> '["usage"]'::jsonb
  AND NOT ("query" -> 'chargeTypes' @> '["commitment_covered_usage"]'::jsonb);
