/** The org tag policy and tag key preferences, as Effect schemas. */
import { Schema } from "effect";
import {
  TAG_KEY_SETTINGS_LIMITS,
  TAG_POLICY_LIMITS,
  tagKeyPatternError,
  type RequiredTag as RequiredTagContract,
  type TagKeySettings as TagKeySettingsContract,
  type TagPolicy as TagPolicyContract,
} from "@infrawrench/client-core";
import { maxLength, minLength, trimmed } from "./checks";
import type { Exact } from "./contract";

/** One required tag in the org policy: a key, optionally with allowed values. */
export const RequiredTag = Schema.Struct({
  key: Schema.String.check(minLength(1), maxLength(TAG_POLICY_LIMITS.maxKeyLength)).annotate({
    examples: ["owner"],
  }),
  allowedValues: Schema.optionalKey(
    Schema.mutable(
      Schema.Array(Schema.String.check(minLength(1), maxLength(TAG_POLICY_LIMITS.maxValueLength))),
    )
      .check(maxLength(TAG_POLICY_LIMITS.maxAllowedValues))
      .annotate({
        description: "When set, the tag's value must be one of these (compared exactly).",
      }),
  ),
}).annotate({ identifier: "RequiredTag" });

/** The org tag policy (PUT /tag-policy). */
export const TagPolicy = Schema.Struct({
  requiredTags: Schema.mutable(Schema.Array(RequiredTag)).check(
    maxLength(TAG_POLICY_LIMITS.maxRequiredTags),
  ),
  enforceOnCreate: Schema.Boolean.annotate({
    description:
      "When true, resource creation is rejected with a 422 (`tag_policy_unmet`) if the " +
      "submitted fields carry a tag map missing a required tag. Types whose create form has " +
      "no `tags`/`labels` field are exempt.",
  }),
}).annotate({ identifier: "TagPolicy" });

/** A tag key preference entry: trimmed, then bounded. */
const tagKeyEntryChecks = [minLength(1), maxLength(TAG_KEY_SETTINGS_LIMITS.maxKeyLength)] as const;

/**
 * The org's tag key preferences (PUT /tag-keys/settings). Whole-document, no
 * defaults: a client that omits a list is refused rather than clearing it.
 * Entries are trimmed before they are checked; the cross-list rule (a key both
 * hidden and preferred) is `tagKeySettingsError`'s, run by the route after this.
 */
export const TagKeySettings = Schema.Struct({
  hidden: Schema.mutable(
    Schema.Array(
      trimmed([
        ...tagKeyEntryChecks,
        Schema.makeFilter((p: string) => tagKeyPatternError(p) === null, {
          message:
            "expected an exact key or a prefix ending in a single *, e.g. aws:cloudformation:*",
        }),
      ]),
    ),
  )
    .check(maxLength(TAG_KEY_SETTINGS_LIMITS.maxHidden))
    .annotate({
      description:
        "Tag keys left out of every tag picker. Each entry is an exact key (`Name`) or a prefix " +
        "pattern ending in a single `*` (`aws:cloudformation:*`). A lone `*` and a `*` anywhere " +
        "but the end are rejected. Matching is case-sensitive. Hidden keys' data is untouched: " +
        "stored, exported, and queryable by a filter naming them.",
      examples: [["aws:cloudformation:*", "aws:autoscaling:*", "Name"]],
    }),
  preferred: Schema.mutable(
    Schema.Array(
      trimmed([
        ...tagKeyEntryChecks,
        Schema.makeFilter((k: string) => !k.includes("*"), {
          message: "preferred keys are exact keys, not patterns",
        }),
      ]),
    ),
  )
    .check(maxLength(TAG_KEY_SETTINGS_LIMITS.maxPreferred))
    .annotate({
      description:
        "Exact tag keys pinned to the top of every tag picker, in this order. A key cannot be " +
        "both hidden and preferred; a preferred key under a hidden prefix stays visible.",
      examples: [["team", "env", "cost-centre"]],
    }),
}).annotate({ identifier: "TagKeySettings" });

export type TagSchemasMatchContract = [
  Exact<typeof RequiredTag.Type, RequiredTagContract>,
  Exact<typeof TagPolicy.Type, TagPolicyContract>,
  Exact<typeof TagKeySettings.Type, TagKeySettingsContract>,
];
[true, true, true] satisfies TagSchemasMatchContract;
