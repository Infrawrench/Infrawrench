/** Cost centre and allocation rule bodies, as Effect schemas. */
import { Schema } from "effect";
import {
  TAG_POLICY_LIMITS,
  VIRTUAL_TAG_LIMITS,
  type AllocationRuleInput as AllocationRuleInputContract,
  type AllocationRuleMatch as AllocationRuleMatchContract,
} from "@infrawrench/client-core";
import { maxLength, minLength } from "./checks";
import type { Exact } from "./contract";
import { NonEmptyString, UuidRef } from "./primitives";

export const CostCentreInput = Schema.Struct({
  name: Schema.String.check(minLength(1), maxLength(120)).annotate({ examples: ["Platform"] }),
  description: Schema.optionalKey(Schema.String.check(maxLength(2000))),
  /**
   * `null` is the top level; **omitting** it on an update leaves the centre
   * where it is, so a client that predates nesting cannot promote a centre to
   * the root just by renaming it.
   */
  parentId: Schema.optionalKey(
    Schema.NullOr(UuidRef).annotate({
      description:
        "Cost centre to nest this one under; null is the top level. On an update, moving a " +
        "centre is this field changing; omitting it leaves the centre where it is. Rejected " +
        "with 400 when the parent is unknown, is the centre itself or one of its own " +
        "descendants, or when the resulting tree would be more than 4 levels deep (measured " +
        "over the whole subtree being moved).",
    }),
  ),
}).annotate({ identifier: "CostCentreInput" });

/** The tag half of a match: a value is only meaningful with its key. */
export const tagValueRequiresKey = Schema.makeFilter(
  (m: { readonly tagKey?: string; readonly tagValue?: string }) =>
    !m.tagValue?.trim() || !!m.tagKey?.trim()
      ? undefined
      : { path: ["tagValue"], issue: "tagValue requires tagKey" },
);

export const matchTagFields = {
  tagKey: Schema.optionalKey(
    Schema.String.check(minLength(1), maxLength(TAG_POLICY_LIMITS.maxKeyLength)),
  ),
  tagValue: Schema.optionalKey(
    Schema.String.check(maxLength(TAG_POLICY_LIMITS.maxValueLength)).annotate({
      description: "Only meaningful with tagKey; alone, tagKey matches rows carrying the key.",
    }),
  ),
  accountId: Schema.optionalKey(NonEmptyString),
  pluginId: Schema.optionalKey(NonEmptyString),
  service: Schema.optionalKey(NonEmptyString),
};

/** All set fields must match; an empty match is a catch-all. */
export const AllocationRuleMatch = Schema.Struct({
  ...matchTagFields,
  /** One of the org's virtual tags, by key: route a computed value to a centre. */
  virtualTagKey: Schema.optionalKey(
    Schema.String.check(minLength(1), maxLength(VIRTUAL_TAG_LIMITS.maxKeyLength)).annotate({
      description:
        "One of the organization's virtual tags, by key. Alone it matches rows where the tag is " +
        "set; a split virtual tag routes each share separately.",
    }),
  ),
  virtualTagValue: Schema.optionalKey(
    Schema.String.check(maxLength(VIRTUAL_TAG_LIMITS.maxValueLength)).annotate({
      description: "Only meaningful with virtualTagKey.",
    }),
  ),
})
  .check(
    tagValueRequiresKey,
    Schema.makeFilter((m) =>
      !m.virtualTagValue?.trim() || !!m.virtualTagKey?.trim()
        ? undefined
        : { path: ["virtualTagValue"], issue: "virtualTagValue requires virtualTagKey" },
    ),
  )
  .annotate({
    identifier: "AllocationRuleMatch",
    description:
      "All set fields must match (AND). A rule with no fields is a catch-all that claims " +
      "everything reaching it.",
  });

export const AllocationRuleInput = Schema.Struct({
  costCentreId: UuidRef,
  priority: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100_000 })).annotate({
    description: "Lower fires first; the first matching rule wins.",
  }),
  match: AllocationRuleMatch,
}).annotate({ identifier: "AllocationRuleInput" });

export type CostCentreSchemasMatchContract = [
  Exact<typeof AllocationRuleMatch.Type, AllocationRuleMatchContract>,
  Exact<typeof AllocationRuleInput.Type, AllocationRuleInputContract>,
];
[true, true] satisfies CostCentreSchemasMatchContract;
