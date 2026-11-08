/**
 * Cost filter terms, as Effect schemas.
 *
 * One term of a cost scope: a dimension, an operator and its values. Shared by
 * every object that narrows spend (budgets, reports, alerts, exports, saved
 * filters), and the schema the API decodes those bodies with.
 */
import { Schema } from "effect";
import {
  COST_DIMENSIONS,
  COST_FILTER_OPS,
  costFilterOpError,
  type CostFilter as CostFilterContract,
} from "@infrawrench/client-core";

/** How a term compares (`COST_FILTER_OPS`). Registered once, as every filter references it. */
export const CostFilterOperator = Schema.Literals(COST_FILTER_OPS).annotate({
  identifier: "CostFilterOperator",
  description:
    "`in` / `not_in` compare exactly. `flexible_match` compares after ignoring letter case, " +
    "whitespace, `_` and `-` (so `Prod_Env` matches `prod-env`). `contains`, `not_contains` and " +
    "`starts_with` are substring and prefix tests, ignoring letter case. Each matches when any " +
    "listed value does (`not_in` and `not_contains`: when none does). `is_set` / `is_not_set` " +
    "test whether a `tag` or `virtual_tag` has a value, and take an empty `values`.",
});

export const CostDimension = Schema.Literals(COST_DIMENSIONS);

/** The values of a term: empty exactly for `is_set` / `is_not_set`. */
export const CostFilterValues = Schema.mutable(Schema.Array(Schema.String)).annotate({
  description:
    "Values to compare with. At least one, except for `is_set` and `is_not_set`, which take " +
    "an empty list. The text operators refuse an empty string.",
});

const costFilterFields = {
  dimension: CostDimension,
  op: CostFilterOperator,
  values: CostFilterValues,
  /** Required when the dimension is `tag` or `virtual_tag` (the key). */
  tagKey: Schema.optionalKey(Schema.String),
};

/**
 * One cost filter term, with the operator rules `costFilterOpError` states,
 * reported on `values` in the words every editor uses.
 *
 * Unnamed on purpose: each object documents its terms under its own component
 * (`BudgetCostFilter`, ...), so annotate an identifier where it is used.
 */
export const CostFilter = Schema.Struct(costFilterFields).check(
  Schema.makeFilter((filter) => {
    const problem = costFilterOpError(filter);
    return problem ? { path: ["values"], issue: problem } : undefined;
  }),
);

type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
export type CostFilterSchemaMatchesContract = Exact<typeof CostFilter.Type, CostFilterContract>;
