import { z } from "zod";

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
  z.object({ type: z.literal("open-url"), url: z.string() }),
  z.object({ type: z.literal("copy-to-clipboard"), fieldKey: z.string() }),
  z.object({
    type: z.literal("navigate-to-resource"),
    pluginId: z.string(),
    resourceTypeId: z.string(),
    resourceId: z.string(),
  }),
  z.object({ type: z.literal("refresh-resource") }),
]);

const statusDotSchema = z.object({
  kind: z.literal("status-dot"),
  status: z.enum(["healthy", "degraded", "error", "unknown", "provisioning"]),
  label: z.string().optional(),
});

// Recursive schema node — use z.ZodTypeAny to avoid circular type alias
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const schemaNodeSchema: z.ZodType<any> = z.lazy(() =>
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

export const detailViewSchema = z.object({
  title: z.string(),
  subtitle: z.string().optional(),
  status: statusDotSchema.optional(),
  sections: z.array(sectionNodeSchema),
  children: z.array(dashboardCardSchema).optional(),
  headerActions: z.array(actionNodeSchema).optional(),
  metricsCapability: z.object({ defaultTimeRangeMs: z.number().optional() }).optional(),
});
