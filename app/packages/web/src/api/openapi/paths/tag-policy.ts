import { z } from "../zod";
import { strict, ErrorResponses, OrgIdParam } from "../common";
import type { BuildContext } from "../context";

const IsoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .openapi({ example: "2026-07-01" });

const RequiredTag = strict({
  key: z.string().min(1).max(128).openapi({ example: "owner" }),
  allowedValues: z
    .array(z.string().min(1).max(256))
    .max(64)
    .optional()
    .openapi({ description: "When set, the tag's value must be one of these (compared exactly)." }),
}).openapi("RequiredTag");

const TagPolicy = strict({
  requiredTags: z.array(RequiredTag).max(32),
  enforceOnCreate: z.boolean().openapi({
    description:
      "When true, resource creation is rejected with a 422 (`tag_policy_unmet`) if the " +
      "submitted fields carry a tag map missing a required tag. Types whose create form has " +
      "no `tags`/`labels` field are exempt.",
  }),
}).openapi("TagPolicy");

const TagPolicyViolation = strict({
  key: z.string(),
  reason: z.enum(["missing", "value_not_allowed"]),
  value: z.string().optional(),
  allowedValues: z.array(z.string()).optional(),
}).openapi("TagPolicyViolation");

/**
 * Body of the 422 returned when the org tag policy blocks a resource create.
 * Same protocol as `ChangeFreezeBlocked` (423): callers holding
 * `tag-policy:override` may retry with `x-tag-policy-override: true`; both
 * blocks and overrides are audit-logged.
 */
const TagPolicyBlocked = strict({
  error: z.string(),
  code: z.literal("tag_policy_unmet"),
  violations: z.array(TagPolicyViolation),
  requiredTags: z.array(RequiredTag),
}).openapi("TagPolicyBlocked");

/** 422 response slot for creates gated by the org tag policy. */
export const TagPolicyUnmetResponse = {
  description:
    "Blocked by the organization's tag policy: the submitted fields are missing a required tag " +
    "(or carry a disallowed value). Retry with the `x-tag-policy-override: true` header if you " +
    "hold `tag-policy:override`; both blocks and overrides are audit-logged.",
  content: { "application/json": { schema: TagPolicyBlocked } },
} as const;

const AccountTagCompliance = strict({
  accountId: z.string(),
  pluginId: z.string(),
  displayName: z.string(),
  totalResources: z.number().int(),
  evaluated: z.number().int().openapi({
    description: "Resources whose stored record exposes a tag map (the scoreable set).",
  }),
  compliant: z.number().int(),
  score: z.number().int().min(0).max(100).nullable().openapi({
    description: "Percent of evaluated resources carrying every required tag; null when none.",
  }),
}).openapi("AccountTagCompliance");

const TagComplianceReport = strict({
  policy: TagPolicy,
  accounts: z.array(AccountTagCompliance),
}).openapi("TagComplianceReport");

const CurrencyAmounts = z
  .record(z.string(), z.number())
  .openapi({ description: "Currency code → amount in the currency's major unit." });

const UntaggedSpendReport = strict({
  from: IsoDate,
  to: IsoDate,
  requiredKeys: z.array(z.string()),
  currencies: z.array(z.string()),
  totals: CurrencyAmounts,
  untaggedTotals: CurrencyAmounts.openapi({
    description: "Spend on rows missing at least one required tag key, per currency.",
  }),
  byKey: z.array(strict({ key: z.string(), untagged: CurrencyAmounts })),
  topUntagged: z.array(
    strict({
      accountId: z.string(),
      accountLabel: z.string(),
      service: z.string(),
      currency: z.string(),
      amount: z.number(),
    }),
  ),
}).openapi("UntaggedSpendReport");

const RangeQuery = strict({
  from: IsoDate.optional().openapi({ description: "Defaults to 30 days ago." }),
  to: IsoDate.optional().openapi({ description: "Defaults to today." }),
  basis: z
    .enum(["cash", "amortized"])
    .optional()
    .openapi({
      description:
        "Which money to sum. `cash` (the default) is what the provider charged on the day it " +
        "charged it; `amortized` spreads a commitment's up-front fee across the term it buys. " +
        "Providers that report no amortized amount fall back to their cash amount.",
    }),
});

export function registerTagPolicyPaths(ctx: BuildContext) {
  const { registry } = ctx;

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/tag-policy",
    tags: ["Tag Policy"],
    summary: "The org's required-tag policy",
    request: { params: OrgIdParam },
    responses: {
      200: { description: "Tag policy", content: { "application/json": { schema: TagPolicy } } },
    },
  });

  registry.registerPath({
    method: "put",
    path: "/api/org/{orgId}/tag-policy",
    tags: ["Tag Policy"],
    summary: "Replace the org's tag policy",
    description:
      "Sets the required tag keys (each optionally restricted to allowed values) and whether " +
      "resource creation is blocked when they are missing. Keys are matched case-insensitively " +
      "against the generic `tags`/`labels` field convention.",
    request: {
      params: OrgIdParam,
      body: { content: { "application/json": { schema: TagPolicy } }, required: true },
    },
    responses: {
      200: { description: "Saved", content: { "application/json": { schema: TagPolicy } } },
      400: ErrorResponses[400],
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/tag-policy/compliance",
    tags: ["Tag Policy"],
    summary: "Per-account tag compliance scores",
    description:
      "For each account: how many of its resources expose tags and how many of those carry " +
      "every required tag with an allowed value. `score` is over the evaluated (tag-capable) " +
      "set so untaggable resource types don't drag it.",
    request: { params: OrgIdParam },
    responses: {
      200: {
        description: "Compliance report",
        content: { "application/json": { schema: TagComplianceReport } },
      },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/costs/untagged",
    tags: ["Costs"],
    summary: "Untagged spend over the required tag keys",
    description:
      "Spend on cost rows missing at least one of the org's required tag keys, overall and per " +
      "key, plus the largest untagged (account, service) buckets. Empty when no tag policy is " +
      "configured — untagged is only meaningful against a policy.",
    request: { params: OrgIdParam, query: RangeQuery },
    responses: {
      200: {
        description: "Untagged spend report",
        content: { "application/json": { schema: UntaggedSpendReport } },
      },
      400: ErrorResponses[400],
    },
  });
}
