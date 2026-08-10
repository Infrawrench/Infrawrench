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

const expiryFieldRuleSchema = z
  .object({
    fieldKey: z.string().min(1),
    from: z.enum(["expiry", "created"]),
    kind: z.enum([
      "tls-cert",
      "domain",
      "api-token",
      "access-key",
      "k8s-cert",
      "ssh-key",
      "secret-version",
      // "lease" is deliberately absent: leases are host-managed rows, not a
      // kind a plugin's lister can declare a field for.
      "other",
    ]),
    label: z.string().min(1),
    maxAgeDays: z.number().int().positive().optional(),
    fallbackFieldKey: z.string().min(1).optional(),
  })
  // A budget on an absolute deadline is dead config — the author almost
  // certainly meant `from: "created"`, so fail the manifest instead of
  // silently ignoring it.
  .refine((r) => r.from === "created" || r.maxAgeDays === undefined, {
    message: 'maxAgeDays only applies to `from: "created"` rules',
    path: ["maxAgeDays"],
  })
  .refine((r) => r.from === "created" || r.fallbackFieldKey === undefined, {
    message: 'fallbackFieldKey only applies to `from: "created"` rules',
    path: ["fallbackFieldKey"],
  });

const orphanRuleSchema = z.object({
  conditions: z.array(orphanConditionSchema).min(1),
  reason: z.string().min(1),
});

const postureConditionSchema = z.union([
  z
    .object({
      fieldKey: z.string().min(1),
      when: z.enum(["empty", "equals", "notEquals", "truthy", "falsy"]),
      value: z.string().optional(),
    })
    // Same stance as orphan conditions: `evaluatePostureCondition` falls back
    // to comparing against "" when `value` is absent, so an author who forgets
    // it would silently get a rule that matches empty-valued fields instead of
    // a manifest error.
    .refine((c) => (c.when !== "equals" && c.when !== "notEquals") || c.value !== undefined, {
      message: "posture condition requires `value` when `when` is 'equals' or 'notEquals'",
      path: ["value"],
    })
    .refine((c) => c.when === "equals" || c.when === "notEquals" || c.value === undefined, {
      message: "`value` only applies to 'equals' / 'notEquals' posture conditions",
      path: ["value"],
    }),
  z.object({
    fieldKey: z.string().min(1),
    when: z.literal("olderThanDays"),
    days: z.number().int().positive(),
  }),
]);

const postureCheckRuleSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  severity: z.enum(["critical", "high", "medium", "low"]),
  category: z.enum(["public-exposure", "encryption", "credential-age", "data-protection", "other"]),
  conditions: z.array(postureConditionSchema).min(1),
  reason: z.string().min(1),
});

// A plain union, not `discriminatedUnion`: the zone arm carries `.refine`s,
// and a refined option isn't a valid discriminated-union member in zod 3.
const dnsRoleSchema = z.union([
  z
    .object({
      role: z.literal("zone"),
      domainKey: z.string().min(1).optional(),
      recordCountKey: z.string().min(1).optional(),
      statusKey: z.string().min(1).optional(),
      privateKey: z.string().min(1).optional(),
      privateValues: z.array(z.string().min(1)).min(1).optional(),
      isPrivate: z.boolean().optional(),
    })
    // A value list with no field to read is dead config — the `maxAgeDays` and
    // `runningValues` stance: fail the manifest rather than never match.
    .refine((r) => r.privateKey !== undefined || r.privateValues === undefined, {
      message: "privateValues requires privateKey",
      path: ["privateKey"],
    })
    // Two answers to one question: which wins is a coin flip the author didn't
    // intend, so fail rather than pick.
    .refine((r) => r.isPrivate === undefined || r.privateKey === undefined, {
      message: "isPrivate and privateKey are mutually exclusive",
      path: ["isPrivate"],
    }),
  z.object({
    role: z.literal("record"),
    nameKey: z.string().min(1).optional(),
    typeKey: z.string().min(1).optional(),
    contentKey: z.string().min(1).optional(),
    ttlKey: z.string().min(1).optional(),
    priorityKey: z.string().min(1).optional(),
    proxiedKey: z.string().min(1).optional(),
    zoneKey: z.string().min(1).optional(),
  }),
]);

const dnsServiceHostSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    hostPattern: z.string().min(1),
    labelIs: z.enum(["name", "opaque"]).optional(),
    hostKeys: z.array(z.string().min(1)).min(1).optional(),
    severity: z.enum(["critical", "high", "medium", "low"]).optional(),
    reason: z.string().min(1),
  })
  // Same stance as `sizeFamilyPattern`: a pattern that doesn't compile, or has
  // nothing to capture, would silently classify every record as unmatched.
  .refine(
    (r) => {
      try {
        new RegExp(r.hostPattern);
        return true;
      } catch {
        return false;
      }
    },
    { message: "hostPattern must be a valid regular expression", path: ["hostPattern"] },
  )
  .refine(
    (r) => {
      try {
        return (new RegExp(`${r.hostPattern}|`).exec("")?.length ?? 1) > 1;
      } catch {
        return false; // invalid regex — already reported above
      }
    },
    { message: "hostPattern must contain at least one capture group", path: ["hostPattern"] },
  )
  // An opaque provider-minted label can never be matched by name, so without a
  // field holding the full hostname nothing could ever claim it and every
  // record into the namespace would read as dangling.
  .refine((r) => r.labelIs !== "opaque" || (r.hostKeys?.length ?? 0) > 0, {
    message: '`labelIs: "opaque"` requires hostKeys',
    path: ["hostKeys"],
  });

const lifecycleActionsSchema = z
  .object({
    startActionId: z.string().min(1),
    stopActionId: z.string().min(1),
    statusFieldKey: z.string().min(1).optional(),
    runningValues: z.array(z.string().min(1)).min(1).optional(),
    stoppedValues: z.array(z.string().min(1)).min(1).optional(),
  })
  // A single action can't both stop and start — an identical pair is a typo
  // that would make every scheduled transition a no-op or a flap.
  .refine((l) => l.startActionId !== l.stopActionId, {
    message: "startActionId and stopActionId must differ",
    path: ["stopActionId"],
  })
  // Value lists without a field to read are dead config; fail the manifest
  // rather than silently never matching (the `maxAgeDays` stance).
  .refine((l) => l.statusFieldKey !== undefined || (!l.runningValues && !l.stoppedValues), {
    message: "runningValues/stoppedValues require statusFieldKey",
    path: ["statusFieldKey"],
  });

const rightsizingSchema = z
  .object({
    sizeFieldKey: z.string().min(1),
    createSizeFieldKey: z.string().min(1).optional(),
    regionFieldKey: z.string().min(1).optional(),
    diskFieldKey: z.string().min(1).optional(),
    cpuMetric: z.object({
      seriesLabel: z.string().min(1),
      scale: z.enum(["percent", "fraction"]).optional(),
    }),
    memoryMetric: z
      .object({
        seriesLabel: z.string().min(1),
        interpretation: z.enum(["percent", "used-bytes", "available-bytes"]),
      })
      .optional(),
    priceCurrency: z.string().length(3).optional(),
    sizeFamilyPattern: z.string().min(1).optional(),
    resizeNote: z.string().min(1).optional(),
  })
  // A family guard that doesn't compile, or has nothing to capture, would
  // silently disable (or worse, never constrain) candidate filtering — fail
  // the manifest instead (the `maxAgeDays` stance).
  .refine(
    (r) => {
      if (r.sizeFamilyPattern === undefined) return true;
      try {
        return new RegExp(r.sizeFamilyPattern).exec("probe") !== undefined;
      } catch {
        return false;
      }
    },
    {
      message: "sizeFamilyPattern must be a valid regular expression",
      path: ["sizeFamilyPattern"],
    },
  )
  .refine(
    (r) => {
      if (r.sizeFamilyPattern === undefined) return true;
      // Count *actual* capturing groups structurally: appending an empty
      // alternative makes the regex match "", and the match array's length is
      // 1 + the number of capturing groups (named ones included). A source
      // scan would miscount `(?=…)` / `(?!…)` lookarounds and escaped parens.
      try {
        return (new RegExp(`${r.sizeFamilyPattern}|`).exec("")?.length ?? 1) > 1;
      } catch {
        return false; // invalid regex — already reported by the refine above
      }
    },
    {
      message: "sizeFamilyPattern must contain at least one capture group",
      path: ["sizeFamilyPattern"],
    },
  );

export const resourceTypeDefinitionSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1),
  pluralDisplayName: z.string().min(1),
  description: z.string().min(1),
  fields: z.array(fieldDefinitionSchema),
  outputs: z.array(resourceOutputSchema),
  parentTypeId: z.string().optional(),
  showInSidebar: z.boolean().optional(),
  accountRoot: z.boolean().optional(),
  dashboardPinnable: z.boolean(),
  iconKey: z.string().optional(),
  peerIntegrations: z.array(peerPluginIntegrationSchema).optional(),
  secretExportTemplates: z.array(secretExportTemplateSchema).optional(),
  attachTargets: z.array(attachTargetSchema).optional(),
  supportsMetrics: z.boolean().optional(),
  orphanRule: orphanRuleSchema.optional(),
  postureChecks: z.array(postureCheckRuleSchema).optional(),
  expiryFields: z.array(expiryFieldRuleSchema).optional(),
  dnsRole: dnsRoleSchema.optional(),
  dnsServiceHosts: z.array(dnsServiceHostSchema).optional(),
  lifecycle: lifecycleActionsSchema.optional(),
  rightsizing: rightsizingSchema.optional(),
});
