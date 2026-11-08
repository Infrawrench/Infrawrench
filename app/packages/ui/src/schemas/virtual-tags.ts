/**
 * Virtual tag bodies (POST/PUT /virtual-tags), as Effect schemas.
 *
 * Shape only, like the billing rules: the cross-field rules (a split's
 * percentages sum to 100, a filter must parse, a key is listed once) are
 * `virtualTagInputError` in client-core, so the editor and the API refuse in
 * identical words. Every kind-specific field is nullable with a default, so a
 * PUT round-trip of a rule this client did not author still decodes.
 */
import { Effect, Schema } from "effect";
import {
  COST_QUERY_MAX_LENGTH,
  TAG_POLICY_LIMITS,
  VIRTUAL_TAG_KEY_PATTERN,
  VIRTUAL_TAG_LIMITS,
  VIRTUAL_TAG_RULE_KINDS,
  VIRTUAL_TAG_VALUE_TRANSFORMS,
  type VirtualTagAllocation as VirtualTagAllocationContract,
  type VirtualTagInput as VirtualTagInputContract,
  type VirtualTagRule as VirtualTagRuleContract,
  type VirtualTagSource as VirtualTagSourceContract,
} from "@infrawrench/client-core";
import { maxLength, minLength, pattern } from "./checks";
import type { Exact } from "./contract";
import { IsoDate, NonEmptyString, UuidRef } from "./primitives";

const L = VIRTUAL_TAG_LIMITS;
const CostQueryText = Schema.String.check(maxLength(COST_QUERY_MAX_LENGTH));

export const VirtualTagSource = Schema.Struct({
  tagKey: Schema.String.check(minLength(1), maxLength(TAG_POLICY_LIMITS.maxKeyLength)).annotate({
    examples: ["Environment"],
  }),
  valuePrefix: Schema.NullOr(Schema.String.check(maxLength(L.maxPrefixLength)))
    .annotate({ description: "Prepended to the copied value, e.g. `az-`.", default: null })
    .pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
  query: Schema.NullOr(CostQueryText)
    .annotate({
      description:
        "Cost-query-language filter that must also hold for this key to be read, e.g. " +
        "`provider = 'azure'`. Null for always.",
      default: null,
    })
    .pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
}).annotate({ identifier: "VirtualTagSource" });

export const VirtualTagAllocation = Schema.Struct({
  value: Schema.String.check(minLength(1), maxLength(L.maxValueLength)),
  percent: Schema.NullOr(
    Schema.Finite.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(100)),
  )
    .annotate({ description: "`split` only. The shares of one rule sum to 100.", default: null })
    .pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
  metricId: Schema.NullOr(UuidRef)
    .annotate({
      description:
        "`metric_split` only. The business metric whose daily value weights this share. A day " +
        "where any share's metric has no value carries the last good day's weights forward, or " +
        "splits evenly when there is none.",
      default: null,
    })
    .pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
}).annotate({ identifier: "VirtualTagAllocation" });

const RuleDay = Schema.NullOr(IsoDate);

export const VirtualTagRule = Schema.Struct({
  query: CostQueryText.annotate({
    description:
      "Cost-query-language filter a row must match, e.g. `provider = 'aws' AND service = " +
      "'AmazonRDS'`. Empty matches every row. May filter on another virtual tag " +
      "(`virtual_tag['team'] = 'payments'`) that gives each row one value (no split rules), " +
      "as long as the references form no cycle and no chain is more than five tags deep.",
    default: "",
  }).pipe(Schema.withDecodingDefaultKey(Effect.succeed(""))),
  description: Schema.NullOr(Schema.String.check(maxLength(L.maxDescriptionLength)))
    .annotate({ default: null })
    .pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
  startsOn: RuleDay.annotate({
    description: "Inclusive UTC day the rule starts applying; null for no start.",
    default: null,
  }).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
  endsOn: RuleDay.annotate({
    description: "Inclusive UTC day the rule stops applying; null for no end.",
    default: null,
  }).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
  kind: Schema.Literals(VIRTUAL_TAG_RULE_KINDS).annotate({
    description:
      "`value`: a fixed value. `tag`: copy the value from the first present provider tag key " +
      "in `sources` (key collapsing). `split`: divide the row across `allocations` by " +
      "percentage. `metric_split`: divide it in proportion to business metrics, day by day.",
  }),
  value: Schema.NullOr(Schema.String.check(maxLength(L.maxValueLength)))
    .annotate({ description: "`value` only.", default: null })
    .pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
  sources: Schema.mutable(Schema.Array(VirtualTagSource))
    .check(maxLength(L.maxSources))
    .annotate({ description: "`tag` only.", default: [] })
    .pipe(Schema.withDecodingDefaultKey(Effect.sync(() => []))),
  valueTransform: Schema.Literals(VIRTUAL_TAG_VALUE_TRANSFORMS)
    .annotate({
      description: "`tag` only. Case fold applied to the copied value before the prefix.",
      default: "none",
    })
    .pipe(Schema.withDecodingDefaultKey(Effect.succeed("none"))),
  allocations: Schema.mutable(Schema.Array(VirtualTagAllocation))
    .check(maxLength(L.maxAllocations))
    .annotate({ description: "`split` and `metric_split` only; at least two.", default: [] })
    .pipe(Schema.withDecodingDefaultKey(Effect.sync(() => []))),
}).annotate({ identifier: "VirtualTagRule" });

export const VirtualTagInput = Schema.Struct({
  key: Schema.String.check(
    minLength(1),
    maxLength(L.maxKeyLength),
    pattern(VIRTUAL_TAG_KEY_PATTERN, {
      message: "letters, digits and _ - . : / only, starting with a letter or digit",
    }),
  ).annotate({
    examples: ["team"],
    description:
      "How filters address the tag: `virtual_tag['team'] = 'payments'`. Immutable after " +
      "creation, because saved filters, budgets, reports and exports store it.",
  }),
  name: Schema.String.check(minLength(1), maxLength(L.maxNameLength)).annotate({
    examples: ["Team"],
  }),
  description: Schema.optionalKey(
    Schema.NullOr(Schema.String.check(maxLength(L.maxDescriptionLength))),
  ),
  defaultValue: Schema.optionalKey(
    Schema.NullOr(Schema.String.check(maxLength(L.maxValueLength))).annotate({
      description: "Value for rows no rule matches; null leaves them unset.",
    }),
  ),
  rules: Schema.mutable(Schema.Array(VirtualTagRule)).check(maxLength(L.maxRules)).annotate({
    description: "Evaluated in order; the first rule a row matches decides its value.",
  }),
}).annotate({ identifier: "VirtualTagInput" });

export type VirtualTagSchemasMatchContract = [
  Exact<typeof VirtualTagSource.Type, VirtualTagSourceContract>,
  Exact<typeof VirtualTagAllocation.Type, VirtualTagAllocationContract>,
  Exact<typeof VirtualTagRule.Type, VirtualTagRuleContract>,
  Exact<typeof VirtualTagInput.Type, VirtualTagInputContract>,
];
[true, true, true, true] satisfies VirtualTagSchemasMatchContract;
