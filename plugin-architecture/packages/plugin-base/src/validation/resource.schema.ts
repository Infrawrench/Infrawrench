import { z } from "zod";

const associationSourceSchema = z.object({
  pluginId: z.string(),
  resourceTypeId: z.string(),
  outputKey: z.string(),
});

export const fieldDefinitionSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  kind: z.enum(["string", "number", "boolean", "enum", "secret", "association", "password"]),
  required: z.boolean(),
  description: z.string().optional(),
  enumValues: z.array(z.string()).optional(),
  resolvableOutputKeys: z.array(z.string()).optional(),
  resolvableFrom: z.array(associationSourceSchema).optional(),
  allowLiteral: z.boolean().optional(),
});

const resourceOutputSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  sensitive: z.boolean(),
  description: z.string().optional(),
});

const peerPluginIntegrationSchema = z.object({
  pluginId: z.string().min(1),
  credentialMappings: z.array(
    z.object({
      outputKey: z.string().min(1),
      credentialKey: z.string().min(1),
    }),
  ),
  tabLabel: z.string().min(1),
  showWhen: z
    .object({
      fieldKey: z.string().min(1),
      equals: z.string().optional(),
      prefix: z.string().optional(),
    })
    .optional(),
  requiresFields: z.array(z.string().min(1)).optional(),
  unreachableWhen: z
    .object({
      fieldsEmpty: z.array(z.string().min(1)).min(1),
      title: z.string().min(1),
      suggestions: z.array(z.string().min(1)),
    })
    .optional(),
  exposeMetricsToParent: z.boolean().optional(),
});

const secretExportEntrySchema = z.object({
  envKey: z.string().min(1),
  outputKey: z.string().min(1),
  description: z.string().optional(),
});

const secretExportTemplateSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1),
  description: z.string().optional(),
  entries: z.array(secretExportEntrySchema).min(1),
});

const attachTargetSchema = z.object({
  pluginId: z.string().min(1),
  resourceTypeId: z.string().min(1),
  matchField: z.string().optional(),
  verb: z.string().optional(),
});

const orphanConditionSchema = z
  .object({
    fieldKey: z.string().min(1),
    when: z.enum(["empty", "equals", "notEquals"]),
    value: z.string().optional(),
  })
  // `evaluateOrphanRule` falls back to comparing against "" when `value` is
  // absent, so an author who forgets it would silently get a rule that matches
  // empty-valued fields instead of a manifest error.
  .refine((c) => c.when === "empty" || c.value !== undefined, {
    message: "orphan condition requires `value` when `when` is 'equals' or 'notEquals'",
    path: ["value"],
  });

const orphanRuleSchema = z.object({
  conditions: z.array(orphanConditionSchema).min(1),
  reason: z.string().min(1),
});

export const resourceTypeDefinitionSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1),
  pluralDisplayName: z.string().min(1),
  description: z.string().min(1),
  fields: z.array(fieldDefinitionSchema),
  outputs: z.array(resourceOutputSchema),
  parentTypeId: z.string().optional(),
  dashboardPinnable: z.boolean(),
  iconKey: z.string().optional(),
  peerIntegrations: z.array(peerPluginIntegrationSchema).optional(),
  secretExportTemplates: z.array(secretExportTemplateSchema).optional(),
  attachTargets: z.array(attachTargetSchema).optional(),
  supportsMetrics: z.boolean().optional(),
  orphanRule: orphanRuleSchema.optional(),
});
