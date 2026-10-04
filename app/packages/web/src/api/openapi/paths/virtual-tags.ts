import { z } from "../zod";
import { strict, ErrorResponses, Ok, OrgIdParam, Uuid, IsoDateTime } from "../common";
import type { BuildContext } from "../context";

const IsoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const VirtualTagSource = strict({
  tagKey: z.string().min(1).max(128).openapi({ example: "Environment" }),
  valuePrefix: z.string().max(64).nullable().default(null).openapi({
    description: "Prepended to the copied value, e.g. `az-`.",
  }),
  query: z
    .string()
    .max(4000)
    .nullable()
    .default(null)
    .openapi({
      description:
        "Cost-query-language filter that must also hold for this key to be read, e.g. " +
        "`provider = 'azure'`. Null for always.",
    }),
}).openapi("VirtualTagSource");

const VirtualTagAllocation = strict({
  value: z.string().min(1).max(256),
  percent: z.number().gt(0).max(100).nullable().default(null).openapi({
    description: "`split` only. The shares of one rule sum to 100.",
  }),
  metricId: Uuid.nullable()
    .default(null)
    .openapi({
      description:
        "`metric_split` only. The business metric whose daily value weights this share. A day " +
        "where any share's metric has no value carries the last good day's weights forward, or " +
        "splits evenly when there is none.",
    }),
}).openapi("VirtualTagAllocation");

const VirtualTagRule = strict({
  query: z
    .string()
    .max(4000)
    .default("")
    .openapi({
      description:
        "Cost-query-language filter a row must match, e.g. `provider = 'aws' AND service = " +
        "'AmazonRDS'`. Empty matches every row. May not reference another virtual tag.",
    }),
  description: z.string().max(2000).nullable().default(null),
  startsOn: IsoDay.nullable().default(null).openapi({
    description: "Inclusive UTC day the rule starts applying; null for no start.",
  }),
  endsOn: IsoDay.nullable().default(null).openapi({
    description: "Inclusive UTC day the rule stops applying; null for no end.",
  }),
  kind: z.enum(["value", "tag", "split", "metric_split"]).openapi({
    description:
      "`value`: a fixed value. `tag`: copy the value from the first present provider tag key " +
      "in `sources` (key collapsing). `split`: divide the row across `allocations` by " +
      "percentage. `metric_split`: divide it in proportion to business metrics, day by day.",
  }),
  value: z.string().max(256).nullable().default(null).openapi({ description: "`value` only." }),
  sources: z.array(VirtualTagSource).max(10).default([]).openapi({ description: "`tag` only." }),
  valueTransform: z.enum(["none", "lower", "upper"]).default("none").openapi({
    description: "`tag` only. Case fold applied to the copied value before the prefix.",
  }),
  allocations: z
    .array(VirtualTagAllocation)
    .max(20)
    .default([])
    .openapi({ description: "`split` and `metric_split` only; at least two." }),
}).openapi("VirtualTagRule");

const VirtualTagInput = strict({
  key: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9][A-Za-z0-9_.:/-]*$/)
    .openapi({
      example: "team",
      description:
        "How filters address the tag: `virtual_tag['team'] = 'payments'`. Immutable after " +
        "creation, because saved filters, budgets, reports and exports store it.",
    }),
  name: z.string().min(1).max(120).openapi({ example: "Team" }),
  description: z.string().max(2000).nullable().optional(),
  defaultValue: z.string().max(256).nullable().optional().openapi({
    description: "Value for rows no rule matches; null leaves them unset.",
  }),
  rules: z.array(VirtualTagRule).max(100).openapi({
    description: "Evaluated in order; the first rule a row matches decides its value.",
  }),
}).openapi("VirtualTagInput");

const VirtualTagCurrencyStats = strict({
  currency: z.string(),
  total: z.number(),
  unmatched: z.number().openapi({ description: "Spend no rule matched." }),
  byRule: z.array(z.number()).openapi({ description: "Spend each rule claimed, in rule order." }),
  topValues: z.array(strict({ value: z.string(), amount: z.number() })),
}).openapi("VirtualTagCurrencyStats");

const VirtualTagStats = strict({
  from: IsoDay.nullable(),
  to: IsoDay.nullable(),
  currencies: z.array(VirtualTagCurrencyStats),
  metricFallbackDays: z.number().int().openapi({
    description: "Days a metric split carried weights forward or split evenly.",
  }),
  distinctValues: z.number().int(),
}).openapi("VirtualTagStats");

const VirtualTag = strict({
  id: Uuid,
  key: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  defaultValue: z.string().nullable(),
  rules: z.array(VirtualTagRule),
  status: strict({
    state: z.enum(["pending", "processing", "ready", "failed"]),
    processedAt: IsoDateTime.nullable(),
    error: z.string().nullable(),
    stats: VirtualTagStats.nullable(),
  }).openapi({
    description:
      "The background evaluation over stored history. Queries never wait on it: a saved rule " +
      "applies to every read immediately; this is the account of what the rules do.",
  }),
  createdByUserId: z.string().nullable(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
}).openapi("VirtualTag");

export function registerVirtualTagPaths(ctx: BuildContext) {
  const { registry } = ctx;
  const idParam = OrgIdParam.extend({
    id: Uuid.openapi({ param: { name: "id", in: "path" } }),
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/virtual-tags",
    tags: ["Virtual Tags"],
    summary: "List virtual tags",
    description:
      "Virtual tags are tags the organisation computes from its own ordered rules: merge " +
      "`env`/`Environment`/`ENV` into one key, assign values by any cost filter, split shared " +
      "spend by percentage or by a business metric, with optional start and end dates per " +
      "rule. They work as the `virtual_tag` cost dimension everywhere a tag does.\n\n" +
      "**They are computed at query time and never written into stored cost data**, and " +
      "splits are weighted so a total never changes.",
    request: { params: OrgIdParam },
    responses: {
      200: {
        description: "Virtual tags, by key",
        content: { "application/json": { schema: z.array(VirtualTag) } },
      },
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/virtual-tags",
    tags: ["Virtual Tags"],
    summary: "Create a virtual tag",
    description: "Queues the background evaluation over stored history at once.",
    request: {
      params: OrgIdParam,
      body: { content: { "application/json": { schema: VirtualTagInput } }, required: true },
    },
    responses: {
      200: { description: "Created", content: { "application/json": { schema: VirtualTag } } },
      400: ErrorResponses[400],
      409: ErrorResponses[409],
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/virtual-tags/preview",
    tags: ["Virtual Tags"],
    summary: "Preview an unsaved virtual tag",
    description:
      "Evaluates a definition over the trailing 30 days without storing it: spend per rule, " +
      "unmatched spend and the top values. Validates exactly as a save would.",
    request: {
      params: OrgIdParam,
      body: { content: { "application/json": { schema: VirtualTagInput } }, required: true },
    },
    responses: {
      200: {
        description: "Evaluation",
        content: { "application/json": { schema: VirtualTagStats } },
      },
      400: ErrorResponses[400],
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/virtual-tags/{id}",
    tags: ["Virtual Tags"],
    summary: "Get a virtual tag",
    request: { params: idParam },
    responses: {
      200: { description: "The tag", content: { "application/json": { schema: VirtualTag } } },
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "put",
    path: "/api/org/{orgId}/virtual-tags/{id}",
    tags: ["Virtual Tags"],
    summary: "Update a virtual tag",
    description:
      "A full replace, rule order included. The key cannot change (400). Saving re-queues the " +
      "background evaluation.",
    request: {
      params: idParam,
      body: { content: { "application/json": { schema: VirtualTagInput } }, required: true },
    },
    responses: {
      200: { description: "Updated", content: { "application/json": { schema: VirtualTag } } },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/virtual-tags/{id}/reprocess",
    tags: ["Virtual Tags"],
    summary: "Re-run a virtual tag's evaluation",
    request: { params: idParam },
    responses: {
      200: { description: "Queued", content: { "application/json": { schema: VirtualTag } } },
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "delete",
    path: "/api/org/{orgId}/virtual-tags/{id}",
    tags: ["Virtual Tags"],
    summary: "Delete a virtual tag",
    description:
      "Refused with a 409 that names every saved filter, budget, report, dashboard card, " +
      "change alert, allocation rule, cost export or business metric still referencing the " +
      "key: deleting it would make those fail rather than quietly widen to all spend.",
    request: { params: idParam },
    responses: {
      200: { description: "Deleted", content: { "application/json": { schema: Ok } } },
      404: ErrorResponses[404],
      409: ErrorResponses[409],
    },
  });
}
