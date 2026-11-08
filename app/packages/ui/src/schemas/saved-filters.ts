/**
 * Create/update body for a saved cost filter (POST/PUT /saved-cost-filters).
 *
 * Shape only, deliberately: `filters` XOR `query`, a non-empty result and a
 * key on every tag term are `resolveSavedCostFilterInput` (client-core),
 * which the service runs on every write, so the editors and the API share
 * one implementation of the rules and one set of messages.
 */
import { Effect, Schema } from "effect";
import {
  COST_QUERY_MAX_LENGTH,
  SAVED_COST_FILTER_LIMITS,
  type SavedCostFilterInput as SavedCostFilterInputContract,
} from "@infrawrench/client-core";
import { maxLength, minLength } from "./checks";
import type { Exact } from "./contract";
import { CostFilter } from "./cost-filter";

export const SavedCostFilterTerm = CostFilter.annotate({ identifier: "SavedCostFilterTerm" });

export const SavedCostFilterInput = Schema.Struct({
  name: Schema.String.check(minLength(1), maxLength(SAVED_COST_FILTER_LIMITS.maxNameLength)),
  description: Schema.optionalKey(
    Schema.String.check(maxLength(SAVED_COST_FILTER_LIMITS.maxDescriptionLength)),
  ),
  filters: Schema.mutable(Schema.Array(SavedCostFilterTerm))
    .check(maxLength(SAVED_COST_FILTER_LIMITS.maxFilters))
    .annotate({
      description: "The structured filter. May be omitted only when `query` is sent instead.",
    })
    .pipe(Schema.withDecodingDefaultKey(Effect.sync(() => []))),
  /** The same filter as query text: an alternative spelling of `filters`. */
  query: Schema.optionalKey(
    Schema.String.check(maxLength(COST_QUERY_MAX_LENGTH)).annotate({
      description:
        "The same filter written in the cost query language; an alternative spelling of " +
        "`filters`, compiled server-side into exactly that structure. Sending both a query " +
        "and a non-empty `filters` is a 400, not a precedence rule. Whichever spelling is " +
        "used, the result must be non-empty (an empty saved filter matches everything, which " +
        "is the same as no filter wearing a name) and every tag term must carry its key.",
      examples: ["tag['env'] = 'prod'"],
    }),
  ),
}).annotate({ identifier: "SavedCostFilterInput" });

export type SavedFilterSchemasMatchContract = [
  Exact<typeof SavedCostFilterInput.Type, SavedCostFilterInputContract>,
];
[true] satisfies SavedFilterSchemasMatchContract;
