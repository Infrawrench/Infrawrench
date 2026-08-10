import { z } from "zod";
import type { CreateFieldConfig } from "../create.js";

const secretResolutionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("literal"),
    encryptedValue: z.string(),
    iv: z.string(),
  }),
  z.object({
    kind: z.literal("output-ref"),
    sourcePluginId: z.string(),
    sourceResourceTypeId: z.string(),
    sourceResourceId: z.string(),
    sourceAccountId: z.string(),
    outputKey: z.string(),
    cachedEncryptedValue: z.string().optional(),
    cachedIv: z.string().optional(),
    cachedAt: z.string().optional(),
  }),
  z.object({
    kind: z.literal("plaintext"),
    value: z.string(),
  }),
]);

const secretPlaceholderSchema = z.object({
  kind: z.literal("secret-placeholder"),
  fieldKey: z.string(),
  resolution: secretResolutionSchema,
});

const kvItemSchema = z.object({
  key: z.string(),
  value: z.union([z.string(), secretPlaceholderSchema]),
  copyable: z.boolean().optional(),
  sensitive: z.boolean().optional(),
});

const hostActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("reroll-secret"), fieldKey: z.string() }),
  z.object({
    type: z.literal("reroll-parent-output"),
    outputKey: z.string(),
    confirmMessage: z.string().optional(),
  }),
  z.object({ type: z.literal("open-url"), url: z.string() }),
  z.object({ type: z.literal("copy-to-clipboard"), fieldKey: z.string() }),
  z.object({
    type: z.literal("navigate-to-resource"),
    pluginId: z.string(),
    resourceTypeId: z.string(),
    resourceId: z.string(),
  }),
  z.object({ type: z.literal("refresh-resource") }),
  z.object({
    type: z.literal("plugin-action"),
    actionId: z.string(),
    confirmMessage: z.string().optional(),
    successMessage: z.string().optional(),
    // Zod strips unknown keys, so omitting this here silently dropped the
    // flag the change-freeze gate reads from re-validated schemas.
    destructive: z.boolean().optional(),
  }),
  z.object({
    type: z.literal("prompt-nosql-command"),
    command: z.string(),
    title: z.string().optional(),
    description: z.string().optional(),
    // Field definitions follow the CreateFieldConfig shape — kept loose here
    // since create-form validation lives in the TS type system rather than
    // the runtime schema (and the UI tolerates extra fields gracefully).
    fields: z.array(z.unknown()) as z.ZodType<CreateFieldConfig[]>,
    submitLabel: z.string().optional(),
    danger: z.boolean().optional(),
  }),
]);

const statusDotSchema = z.object({
  kind: z.literal("status-dot"),
  status: z.enum(["healthy", "degraded", "error", "unknown", "provisioning", "info"]),
  label: z.string().optional(),
});

// Recursive schema node — z.lazy needs an explicit annotation to break the
// self-referential type-inference cycle. We use ZodTypeAny rather than the
// authoritative SchemaNode type because the schema intentionally omits the
// rarely-used TableNode variant and exactOptionalPropertyTypes makes the two
// shapes structurally distinct.
export const schemaNodeSchema: z.ZodTypeAny = z.lazy(() =>
  z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("text"),
      content: z.string(),
      variant: z.enum(["heading", "subheading", "body", "mono", "muted"]).optional(),
    }),
    z.object({
      kind: z.literal("badge"),
      label: z.string(),
      color: z.enum(["green", "yellow", "red", "blue", "gray"]),
    }),
    statusDotSchema,
    z.object({
      kind: z.literal("key-value-list"),
      items: z.array(kvItemSchema),
    }),
    z.object({
      kind: z.literal("action"),
      label: z.string(),
      action: hostActionSchema,
      variant: z.enum(["default", "danger", "ghost"]).optional(),
    }),
    z.object({
      kind: z.literal("grid"),
      columns: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
      items: z.array(schemaNodeSchema),
    }),
    z.object({
      kind: z.literal("section"),
      title: z.string().optional(),
      children: z.array(schemaNodeSchema),
    }),
    z.object({
      kind: z.literal("link"),
      label: z.string(),
      url: z.string(),
    }),
    z.object({
      kind: z.literal("metric-chart"),
      title: z.string(),
      series: z.array(
        z.object({
          label: z.string(),
          unit: z.string().optional(),
          points: z.array(z.object({ timestamp: z.number(), value: z.number() })),
        }),
      ),
      timeRangeLabel: z.string().optional(),
    }),
    // `table` was in the TypeScript SchemaNode union but missing here, so
    // `detailViewSchema.safeParse` rejected any detail view containing one.
    // AWS (DynamoDB), Cloudflare (compute/storage), DigitalOcean (GenAI) and
    // GCP all emit `kind: "table"` — they pass the contract test only because
    // their mock fixtures never reach those branches. A new plugin whose
    // fixture does reach one fails with an opaque union error.
    z.object({
      kind: z.literal("table"),
      columns: z.array(
        z.object({
          key: z.string(),
          label: z.string(),
          width: z.enum(["auto", "narrow", "wide"]).optional(),
          mono: z.boolean().optional(),
        }),
      ),
      rows: z.array(
        z.object({
          cells: z.record(
            z.string(),
            z.union([
              z.string(),
              z.object({
                kind: z.literal("action"),
                label: z.string(),
                action: hostActionSchema,
                variant: z.enum(["default", "danger", "ghost"]).optional(),
              }),
            ]),
          ),
          depth: z.number().optional(),
        }),
      ),
      emphasizeFirstColumn: z.boolean().optional(),
    }),
  ]),
);

const badgeSchema = z.object({
  kind: z.literal("badge"),
  label: z.string(),
  color: z.enum(["green", "yellow", "red", "blue", "gray"]),
});

const dashboardStatSchema = z.object({
  label: z.string(),
  value: z.string(),
  variant: z.enum(["default", "status-healthy", "status-degraded", "status-error"]).optional(),
});

export const dashboardCardSchema = z.object({
  pluginId: z.string(),
  resourceTypeId: z.string(),
  resourceId: z.string(),
  displayName: z.string(),
  status: statusDotSchema.optional(),
  badges: z.array(badgeSchema).optional(),
  stats: z.array(dashboardStatSchema).optional(),
  onClickAction: hostActionSchema.optional(),
});

const sectionNodeSchema = z.object({
  kind: z.literal("section"),
  title: z.string().optional(),
  children: z.array(schemaNodeSchema),
});

const actionNodeSchema = z.object({
  kind: z.literal("action"),
  label: z.string(),
  action: hostActionSchema,
  variant: z.enum(["default", "danger", "ghost"]).optional(),
});

export const metricSeriesPointSchema = z.object({
  timestamp: z.number(),
  value: z.number(),
});

export const metricSeriesSchema = z.object({
  label: z.string(),
  unit: z.string().optional(),
  points: z.array(metricSeriesPointSchema),
});

export const queryCostEstimateSchema = z.object({
  bytesProcessed: z.number(),
  estimatedCostUsd: z.number().optional(),
  cacheHit: z.boolean().optional(),
  pricingNote: z.string().optional(),
});

export const queryResultSchema = z.object({
  rows: z.array(z.record(z.string(), z.unknown())),
  durationMs: z.number(),
});

export const queryExecuteResultSchema = z.object({
  affectedRows: z.number().optional(),
});

const childTableSchema = z.object({
  title: z.string(),
  typeId: z.string(),
  columns: z.array(
    z.object({
      key: z.string(),
      label: z.string(),
      width: z.enum(["auto", "narrow", "wide"]).optional(),
      source: z.union([
        z.object({ kind: z.literal("field"), fieldKey: z.string() }),
        z.object({ kind: z.literal("external-id") }),
        z.object({ kind: z.literal("display-name") }),
      ]),
      format: z
        .enum(["text", "mono", "type-badge", "proxy-status", "ttl", "boolean-yesno"])
        .optional(),
      stripSuffixFromFieldKey: z.string().optional(),
      valueMap: z.record(z.string(), z.string()).optional(),
    }),
  ),
  emptyText: z.string().optional(),
  createLabel: z.string().optional(),
  onRowClick: z.enum(["navigate", "edit", "none"]).optional(),
  readOnlyRowWhen: z.object({ fieldKey: z.string(), fieldValues: z.array(z.string()) }).optional(),
});

export const detailViewSchema = z.object({
  title: z.string(),
  subtitle: z.string().optional(),
  status: statusDotSchema.optional(),
  sections: z.array(sectionNodeSchema),
  children: z.array(dashboardCardSchema).optional(),
  childGroups: z
    .array(
      z.object({
        title: z.string(),
        items: z.array(dashboardCardSchema),
        createAction: hostActionSchema.optional(),
        createLabel: z.string().optional(),
        emptyText: z.string().optional(),
      }),
    )
    .optional(),
  childTables: z.array(childTableSchema).optional(),
  hiddenChildTypeIds: z.array(z.string()).optional(),
  settingsEditor: z
    .object({ tabLabel: z.string().optional(), description: z.string().optional() })
    .optional(),
  headerActions: z.array(actionNodeSchema).optional(),
  metricsCapability: z.object({ defaultTimeRangeMs: z.number().optional() }).optional(),
  noSqlBrowser: z
    .object({
      driver: z.enum(["firestore", "mongodb-peer", "dynamodb"]),
      databaseLabel: z.string(),
      helpText: z.string().optional(),
      singleCollection: z.boolean().optional(),
    })
    .optional(),
  customTabs: z
    .array(
      z.object({
        id: z.string(),
        label: z.string(),
        sections: z.array(sectionNodeSchema).optional(),
        childGroups: z
          .array(
            z.object({
              title: z.string(),
              items: z.array(dashboardCardSchema),
              createAction: hostActionSchema.optional(),
              createLabel: z.string().optional(),
              emptyText: z.string().optional(),
            }),
          )
          .optional(),
        childTables: z.array(childTableSchema).optional(),
        childResourceTypeIds: z.array(z.string()).optional(),
        headerActions: z.array(actionNodeSchema).optional(),
      }),
    )
    .optional(),
});
