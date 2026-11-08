import { Schema } from "effect";
import { createFieldConfigSchema, peerGuidanceActionSchema } from "./create.schema.js";
import { NonEmpty, Num } from "./primitives.js";

const secretResolutionSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("literal"),
    encryptedValue: Schema.String,
    iv: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("output-ref"),
    sourcePluginId: Schema.String,
    sourceResourceTypeId: Schema.String,
    sourceResourceId: Schema.String,
    sourceAccountId: Schema.String,
    outputKey: Schema.String,
    cachedEncryptedValue: Schema.optional(Schema.String),
    cachedIv: Schema.optional(Schema.String),
    cachedAt: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    kind: Schema.Literal("plaintext"),
    value: Schema.String,
  }),
]).annotate({ expected: "a secret resolution (literal, output-ref or plaintext)" });

const secretPlaceholderSchema = Schema.Struct({
  kind: Schema.Literal("secret-placeholder"),
  fieldKey: Schema.String,
  resolution: secretResolutionSchema,
});

const kvItemSchema = Schema.Struct({
  key: Schema.String,
  value: Schema.Union([Schema.String, secretPlaceholderSchema]),
  copyable: Schema.optional(Schema.Boolean),
  sensitive: Schema.optional(Schema.Boolean),
});

const hostActionSchema = Schema.Union([
  Schema.Struct({ type: Schema.Literal("reroll-secret"), fieldKey: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("reroll-parent-output"),
    outputKey: Schema.String,
    confirmMessage: Schema.optional(Schema.String),
  }),
  Schema.Struct({ type: Schema.Literal("open-url"), url: Schema.String }),
  Schema.Struct({ type: Schema.Literal("copy-to-clipboard"), fieldKey: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("navigate-to-resource"),
    pluginId: Schema.String,
    resourceTypeId: Schema.String,
    resourceId: Schema.String,
  }),
  Schema.Struct({ type: Schema.Literal("refresh-resource") }),
  Schema.Struct({
    type: Schema.Literal("plugin-action"),
    actionId: Schema.String,
    confirmMessage: Schema.optional(Schema.String),
    successMessage: Schema.optional(Schema.String),
    // Unknown keys are stripped, so omitting this here silently dropped the flag
    // the change-freeze gate reads from re-validated schemas.
    destructive: Schema.optional(Schema.Boolean),
  }),
  Schema.Struct({
    type: Schema.Literal("prompt-nosql-command"),
    command: Schema.String,
    title: Schema.optional(Schema.String),
    description: Schema.optional(Schema.String),
    descriptionVariant: Schema.optional(Schema.Literals(["info", "error"])),
    blocked: Schema.optional(Schema.Boolean),
    fields: Schema.Array(createFieldConfigSchema),
    submitLabel: Schema.optional(Schema.String),
    danger: Schema.optional(Schema.Boolean),
  }),
]).annotate({ expected: "a host action with a known `type`" });

const resourceStatusSchema = Schema.Literals([
  "healthy",
  "degraded",
  "error",
  "unknown",
  "provisioning",
  "info",
]);

const statusDotSchema = Schema.Struct({
  kind: Schema.Literal("status-dot"),
  status: resourceStatusSchema,
  label: Schema.optional(Schema.String),
});

const badgeSchema = Schema.Struct({
  kind: Schema.Literal("badge"),
  label: Schema.String,
  color: Schema.Literals(["green", "yellow", "red", "blue", "gray"]),
});

const actionNodeSchema = Schema.Struct({
  kind: Schema.Literal("action"),
  label: Schema.String,
  action: hostActionSchema,
  variant: Schema.optional(Schema.Literals(["default", "danger", "ghost"])),
});

export const metricSeriesPointSchema = Schema.Struct({
  timestamp: Num,
  value: Num,
});

export const metricSeriesSchema = Schema.Struct({
  label: Schema.String,
  unit: Schema.optional(Schema.String),
  points: Schema.Array(metricSeriesPointSchema),
});

/** `POST /resources/:pluginId/:typeId/metrics` answers this. */
export const metricsResponseSchema = Schema.Struct({
  series: Schema.Array(metricSeriesSchema),
});

const leafNodeSchemas = [
  Schema.Struct({
    kind: Schema.Literal("text"),
    content: Schema.String,
    variant: Schema.optional(Schema.Literals(["heading", "subheading", "body", "mono", "muted"])),
    copyable: Schema.optional(Schema.Boolean),
  }),
  badgeSchema,
  statusDotSchema,
  Schema.Struct({
    kind: Schema.Literal("key-value-list"),
    items: Schema.Array(kvItemSchema),
  }),
  actionNodeSchema,
  Schema.Struct({
    kind: Schema.Literal("link"),
    label: Schema.String,
    url: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("metric-chart"),
    title: Schema.String,
    series: Schema.Array(metricSeriesSchema),
    timeRangeLabel: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    kind: Schema.Literal("table"),
    columns: Schema.Array(
      Schema.Struct({
        key: Schema.String,
        label: Schema.String,
        width: Schema.optional(Schema.Literals(["auto", "narrow", "wide"])),
        mono: Schema.optional(Schema.Boolean),
      }),
    ),
    rows: Schema.Array(
      Schema.Struct({
        cells: Schema.Record(Schema.String, Schema.Union([Schema.String, actionNodeSchema])),
        depth: Schema.optional(Num),
      }),
    ),
    emphasizeFirstColumn: Schema.optional(Schema.Boolean),
  }),
] as const;

// Grid and section are the only nodes that hold nodes, so they are the only ones
// whose decoded types have to be written out to break the inference cycle.
export interface DecodedGridNode {
  readonly kind: "grid";
  readonly columns: 1 | 2 | 3 | 4;
  readonly items: ReadonlyArray<DecodedSchemaNode>;
}

export interface DecodedSectionNode {
  readonly kind: "section";
  readonly title?: string | undefined;
  readonly children: ReadonlyArray<DecodedSchemaNode>;
}

export type DecodedSchemaNode =
  (typeof leafNodeSchemas)[number]["Type"] | DecodedGridNode | DecodedSectionNode;

const gridNodeSchema: Schema.Codec<DecodedGridNode> = Schema.Struct({
  kind: Schema.Literal("grid"),
  columns: Schema.Literals([1, 2, 3, 4]),
  items: Schema.Array(Schema.suspend(() => schemaNodeSchema)),
});

const sectionNodeSchema: Schema.Codec<DecodedSectionNode> = Schema.Struct({
  kind: Schema.Literal("section"),
  title: Schema.optional(Schema.String),
  children: Schema.Array(Schema.suspend(() => schemaNodeSchema)),
});

export const schemaNodeSchema: Schema.Codec<DecodedSchemaNode> = Schema.Union([
  ...leafNodeSchemas,
  gridNodeSchema,
  sectionNodeSchema,
]).annotate({ expected: "a schema node with a known `kind`" });

const dashboardStatSchema = Schema.Struct({
  label: Schema.String,
  value: Schema.String,
  variant: Schema.optional(
    Schema.Literals(["default", "status-healthy", "status-degraded", "status-error"]),
  ),
});

export const dashboardCardSchema = Schema.Struct({
  pluginId: Schema.String,
  resourceTypeId: Schema.String,
  resourceId: Schema.String,
  displayName: Schema.String,
  status: Schema.optional(statusDotSchema),
  badges: Schema.optional(Schema.Array(badgeSchema)),
  stats: Schema.optional(Schema.Array(dashboardStatSchema)),
  onClickAction: Schema.optional(hostActionSchema),
  nonInteractive: Schema.optional(Schema.Boolean),
});

export const queryCostEstimateSchema = Schema.Struct({
  bytesProcessed: Num,
  estimatedCostUsd: Schema.optional(Num),
  cacheHit: Schema.optional(Schema.Boolean),
  pricingNote: Schema.optional(Schema.String),
});

export const queryResultSchema = Schema.Struct({
  rows: Schema.mutable(Schema.Array(Schema.Record(Schema.String, Schema.Unknown))),
  durationMs: Num,
});

export const queryExecuteResultSchema = Schema.Struct({
  affectedRows: Schema.optional(Num),
});

const childGroupSchema = Schema.Struct({
  title: Schema.String,
  items: Schema.Array(dashboardCardSchema),
  createAction: Schema.optional(hostActionSchema),
  createLabel: Schema.optional(Schema.String),
  emptyText: Schema.optional(Schema.String),
});

const childTableSchema = Schema.Struct({
  title: Schema.String,
  typeId: Schema.String,
  columns: Schema.Array(
    Schema.Struct({
      key: Schema.String,
      label: Schema.String,
      width: Schema.optional(Schema.Literals(["auto", "narrow", "wide"])),
      source: Schema.Union([
        Schema.Struct({ kind: Schema.Literal("field"), fieldKey: Schema.String }),
        Schema.Struct({ kind: Schema.Literal("external-id") }),
        Schema.Struct({ kind: Schema.Literal("display-name") }),
      ]).annotate({ expected: "a column source (field, external-id or display-name)" }),
      format: Schema.optional(
        Schema.Literals(["text", "mono", "type-badge", "proxy-status", "ttl", "boolean-yesno"]),
      ),
      stripSuffixFromFieldKey: Schema.optional(Schema.String),
      valueMap: Schema.optional(Schema.Record(Schema.String, Schema.String)),
    }),
  ),
  emptyText: Schema.optional(Schema.String),
  createLabel: Schema.optional(Schema.String),
  onRowClick: Schema.optional(Schema.Literals(["navigate", "edit", "none"])),
  readOnlyRowWhen: Schema.optional(
    Schema.Struct({ fieldKey: Schema.String, fieldValues: Schema.Array(Schema.String) }),
  ),
});

const speechPanelOptionSchema = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  description: Schema.optional(Schema.String),
  languageIds: Schema.optional(Schema.Array(Schema.String)),
});

const valueLabelSchema = Schema.Struct({ value: Schema.String, label: Schema.String });

export const detailViewSchema = Schema.Struct({
  execConsole: Schema.optional(Schema.Boolean),
  title: Schema.String,
  subtitle: Schema.optional(Schema.String),
  status: Schema.optional(statusDotSchema),
  sections: Schema.Array(sectionNodeSchema),
  children: Schema.optional(Schema.Array(dashboardCardSchema)),
  childGroups: Schema.optional(Schema.Array(childGroupSchema)),
  childTables: Schema.optional(Schema.Array(childTableSchema)),
  hiddenChildTypeIds: Schema.optional(Schema.Array(Schema.String)),
  headerActions: Schema.optional(Schema.Array(actionNodeSchema)),
  sqlEditor: Schema.optional(
    Schema.Struct({
      connectionStringOutputKey: Schema.String,
      defaultQuery: Schema.optional(Schema.String),
      tables: Schema.optional(
        Schema.Array(
          Schema.Struct({
            name: Schema.String,
            columns: Schema.Array(Schema.Struct({ name: Schema.String, type: Schema.String })),
            pkColumns: Schema.optional(Schema.Array(Schema.String)),
          }),
        ),
      ),
      supportsQueryCost: Schema.optional(Schema.Boolean),
    }),
  ),
  storageBrowser: Schema.optional(Schema.Struct({ bucketName: Schema.String })),
  artifactRegistry: Schema.optional(
    Schema.Struct({
      format: Schema.optional(Schema.String),
      supportsTags: Schema.optional(Schema.Boolean),
      defaultPrefix: Schema.optional(Schema.String),
    }),
  ),
  manifestEditor: Schema.optional(
    Schema.Struct({
      language: Schema.Literals(["json", "yaml"]),
      resourceKind: Schema.optional(Schema.String),
      readOnly: Schema.optional(Schema.Boolean),
    }),
  ),
  settingsEditor: Schema.optional(
    Schema.Struct({
      tabLabel: Schema.optional(Schema.String),
      description: Schema.optional(Schema.String),
    }),
  ),
  bucketPolicyEditor: Schema.optional(
    Schema.Struct({
      bucketArn: Schema.String,
      bucketName: Schema.String,
      vendor: Schema.Literals(["aws-s3", "do-spaces", "scaleway-os"]),
    }),
  ),
  describe: Schema.optional(
    Schema.Struct({ language: Schema.optional(Schema.Literals(["text", "yaml"])) }),
  ),
  logs: Schema.optional(
    Schema.Struct({
      defaultTailLines: Schema.optional(Num),
      supportsPrevious: Schema.optional(Schema.Boolean),
    }),
  ),
  secretVersions: Schema.optional(
    Schema.Struct({
      supportsFileUpload: Schema.optional(Schema.Boolean),
      helpText: Schema.optional(Schema.String),
      supportsReveal: Schema.optional(Schema.Boolean),
      valuelessAdd: Schema.optional(Schema.Boolean),
    }),
  ),
  metricsCapability: Schema.optional(Schema.Struct({ defaultTimeRangeMs: Schema.optional(Num) })),
  instancePricing: Schema.optional(
    Schema.Struct({
      platform: NonEmpty,
      instanceTypes: Schema.Array(NonEmpty).check(Schema.isMinLength(1)),
      region: Schema.optional(Schema.String),
      selection: Schema.optional(Schema.Record(Schema.String, Schema.String)),
    }),
  ),
  noSqlBrowser: Schema.optional(
    Schema.Struct({
      driver: Schema.Literals(["firestore", "mongodb-peer", "dynamodb"]),
      databaseLabel: Schema.String,
      helpText: Schema.optional(Schema.String),
      singleCollection: Schema.optional(Schema.Boolean),
    }),
  ),
  kvBrowser: Schema.optional(
    Schema.Struct({
      namespaceLabel: Schema.optional(Schema.String),
      defaultPageSize: Schema.optional(Num),
      helpText: Schema.optional(Schema.String),
    }),
  ),
  customTabs: Schema.optional(
    Schema.Array(
      Schema.Struct({
        id: Schema.String,
        label: Schema.String,
        sections: Schema.optional(Schema.Array(sectionNodeSchema)),
        childGroups: Schema.optional(Schema.Array(childGroupSchema)),
        childTables: Schema.optional(Schema.Array(childTableSchema)),
        childResourceTypeIds: Schema.optional(Schema.Array(Schema.String)),
        headerActions: Schema.optional(Schema.Array(actionNodeSchema)),
      }),
    ),
  ),
  chatPanel: Schema.optional(
    Schema.Struct({
      tabLabel: Schema.optional(Schema.String),
      subtitle: Schema.optional(Schema.String),
      greeting: Schema.optional(Schema.String),
      inputPlaceholder: Schema.optional(Schema.String),
      disabledReason: Schema.optional(Schema.String),
      models: Schema.optional(Schema.Array(Schema.String)),
      defaultModel: Schema.optional(Schema.String),
      modelLabel: Schema.optional(Schema.String),
    }),
  ),
  publishPanel: Schema.optional(
    Schema.Struct({
      tabLabel: Schema.optional(Schema.String),
      subtitle: Schema.optional(Schema.String),
      bodyFormat: Schema.optional(Schema.Literals(["json", "text"])),
      defaultBody: Schema.optional(Schema.String),
      helpText: Schema.optional(Schema.String),
      submitLabel: Schema.optional(Schema.String),
      extraFields: Schema.optional(
        Schema.Array(
          Schema.Struct({
            key: Schema.String,
            label: Schema.String,
            kind: Schema.Literals(["text", "number", "select", "key-value-list"]),
            placeholder: Schema.optional(Schema.String),
            defaultValue: Schema.optional(Schema.String),
            options: Schema.optional(Schema.Array(valueLabelSchema)),
            helpText: Schema.optional(Schema.String),
            optional: Schema.optional(Schema.Boolean),
          }),
        ),
      ),
      disabledReason: Schema.optional(Schema.String),
    }),
  ),
  speechPanel: Schema.optional(
    Schema.Struct({
      modes: Schema.Array(Schema.Literals(["tts", "stt"])),
      tabLabel: Schema.optional(Schema.String),
      subtitle: Schema.optional(Schema.String),
      helpText: Schema.optional(Schema.String),
      disabledReason: Schema.optional(Schema.String),
      voices: Schema.optional(Schema.Array(speechPanelOptionSchema)),
      defaultVoice: Schema.optional(Schema.String),
      voiceLabel: Schema.optional(Schema.String),
      defaultText: Schema.optional(Schema.String),
      maxCharacters: Schema.optional(Num),
      synthesizeLabel: Schema.optional(Schema.String),
      languages: Schema.optional(Schema.Array(speechPanelOptionSchema)),
      defaultLanguage: Schema.optional(Schema.String),
      languageLabel: Schema.optional(Schema.String),
      acceptedAudioTypes: Schema.optional(Schema.Array(Schema.String)),
      maxAudioBytes: Schema.optional(Num),
      transcribeLabel: Schema.optional(Schema.String),
      disableRecording: Schema.optional(Schema.Boolean),
      recordingDisabledReason: Schema.optional(Schema.String),
      models: Schema.optional(Schema.Array(speechPanelOptionSchema)),
      defaultModel: Schema.optional(Schema.String),
      modelLabel: Schema.optional(Schema.String),
    }),
  ),
});

const peerPaneResourceSchema = Schema.Struct({
  id: Schema.String,
  pluginId: Schema.String,
  resourceTypeId: Schema.String,
  displayName: Schema.String,
  subtitle: Schema.optional(Schema.String),
  status: Schema.optional(resourceStatusSchema),
  fields: Schema.Record(Schema.String, Schema.Unknown),
  externalId: Schema.optional(Schema.String),
  supportsExec: Schema.optional(Schema.Boolean),
  containerName: Schema.optional(Schema.String),
  namespace: Schema.optional(Schema.String),
});

export const peerPaneSchema = Schema.Struct({
  status: Schema.optional(statusDotSchema),
  supportsK9s: Schema.optional(Schema.Boolean),
  supportsSecretImport: Schema.optional(Schema.Boolean),
  supportsYamlImport: Schema.optional(Schema.Boolean),
  resourceGroups: Schema.Array(
    Schema.Struct({
      title: Schema.String,
      resourceTypeId: Schema.String,
      iconKey: Schema.optional(Schema.String),
      pluginId: Schema.String,
      items: Schema.Array(peerPaneResourceSchema),
      supportsCreate: Schema.optional(Schema.Boolean),
      role: Schema.optional(Schema.Literals(["namespace", "service"])),
    }),
  ),
  guidance: Schema.optional(
    Schema.Struct({
      title: Schema.String,
      suggestions: Schema.Array(Schema.String),
      action: Schema.optional(peerGuidanceActionSchema),
    }),
  ),
});
