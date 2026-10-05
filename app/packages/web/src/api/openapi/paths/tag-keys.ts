import { z } from "../zod";
import { strict, ErrorResponses, OrgIdParam } from "../common";
import type { BuildContext } from "../context";

const TagKeySettings = strict({
  hidden: z
    .array(z.string().min(1).max(512))
    .max(200)
    .openapi({
      description:
        "Tag keys left out of every tag picker. Each entry is an exact key (`Name`) or a prefix " +
        "pattern ending in a single `*` (`aws:cloudformation:*`). A lone `*` and a `*` anywhere " +
        "but the end are rejected. Matching is case-sensitive. Hidden keys' data is untouched: " +
        "stored, exported, and queryable by a filter naming them.",
      example: ["aws:cloudformation:*", "aws:autoscaling:*", "Name"],
    }),
  preferred: z
    .array(z.string().min(1).max(512))
    .max(50)
    .openapi({
      description:
        "Exact tag keys pinned to the top of every tag picker, in this order. A key cannot be " +
        "both hidden and preferred; a preferred key under a hidden prefix stays visible.",
      example: ["team", "env", "cost-centre"],
    }),
}).openapi("TagKeySettings");

const DiscoveredTagKey = strict({
  key: z.string(),
  providers: z.array(z.string()).openapi({
    description: "Plugin ids whose cost rows or resources carry the key.",
  }),
  sources: z.array(z.enum(["costs", "resources"])),
  costRowCount: z.number().int().openapi({
    description: "Cost rows in the lookback window carrying the key.",
  }),
  costResourceCount: z.number().int().openapi({
    description: "Distinct billed resource ids among those rows.",
  }),
  inventoryCount: z.number().int().openapi({
    description: "Synced resources whose tags or labels carry the key (newest 2,000 scanned).",
  }),
  lastSeen: z.string().nullable().openapi({
    description: "Most recent cost day carrying the key; null when only in the inventory.",
  }),
  hidden: z.boolean(),
  hiddenBy: z.string().nullable().openapi({
    description: "The hidden entry (exact key or prefix pattern) that matched.",
  }),
  preferred: z.boolean(),
}).openapi("DiscoveredTagKey");

const DiscoveredTagKeys = strict({
  keys: z.array(DiscoveredTagKey),
  settings: TagKeySettings,
  lookbackDays: z.number().int(),
  truncated: z.boolean(),
}).openapi("DiscoveredTagKeys");

export function registerTagKeyPaths(ctx: BuildContext) {
  const { registry } = ctx;

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/tag-keys",
    tags: ["Tag Policy"],
    summary: "Discovered tag keys with usage",
    description:
      "Every tag key the org's cost data (trailing 90 days) and resource inventory carry, with " +
      "the providers using it, row and resource counts, and whether the tag key settings hide " +
      "or pin it. Preferred keys first, then by usage. Cost counts are included only when the " +
      "caller also holds `costs:read`.",
    request: { params: OrgIdParam },
    responses: {
      200: {
        description: "Discovered tag keys",
        content: { "application/json": { schema: DiscoveredTagKeys } },
      },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/tag-keys/settings",
    tags: ["Tag Policy"],
    summary: "The org's hidden and preferred tag keys",
    request: { params: OrgIdParam },
    responses: {
      200: {
        description: "Tag key settings",
        content: { "application/json": { schema: TagKeySettings } },
      },
    },
  });

  registry.registerPath({
    method: "put",
    path: "/api/org/{orgId}/tag-keys/settings",
    tags: ["Tag Policy"],
    summary: "Replace the org's hidden and preferred tag keys",
    description:
      "Applied to every tag-key listing the API serves (`GET /costs/dimensions?dimension=" +
      "tag-keys`, the metric alert selector options, the MCP tools): preferred keys first, " +
      "hidden keys omitted. A display preference only; no stored data changes.",
    request: {
      params: OrgIdParam,
      body: { content: { "application/json": { schema: TagKeySettings } }, required: true },
    },
    responses: {
      200: { description: "Saved", content: { "application/json": { schema: TagKeySettings } } },
      400: ErrorResponses[400],
    },
  });
}
