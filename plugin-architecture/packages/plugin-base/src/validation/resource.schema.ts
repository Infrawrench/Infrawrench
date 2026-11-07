import { Schema } from "effect";
import { associationSourceSchema, peerGuidanceActionSchema } from "./create.schema.js";
import { Int, NonEmpty, Positive, PositiveInt, Url, rule } from "./primitives.js";

export const fieldDefinitionSchema = Schema.Struct({
  key: NonEmpty,
  label: NonEmpty,
  kind: Schema.Literals([
    "string",
    "number",
    "boolean",
    "enum",
    "secret",
    "association",
    "password",
  ]),
  required: Schema.Boolean,
  description: Schema.optional(Schema.String),
  enumValues: Schema.optional(Schema.Array(Schema.String)),
  resolvableOutputKeys: Schema.optional(Schema.Array(Schema.String)),
  resolvableFrom: Schema.optional(Schema.Array(associationSourceSchema)),
  allowLiteral: Schema.optional(Schema.Boolean),
  editable: Schema.optional(Schema.Boolean),
  showcase: Schema.optional(Schema.Boolean),
}).check(
  rule(
    (f) => !f.showcase || (f.kind !== "secret" && f.kind !== "password"),
    "a secret or password field can't be shown on a tile",
    ["showcase"],
  ),
);

const resourceOutputSchema = Schema.Struct({
  key: NonEmpty,
  label: NonEmpty,
  sensitive: Schema.Boolean,
  description: Schema.optional(Schema.String),
  hidden: Schema.optional(Schema.Boolean),
  dnsValue: Schema.optional(Schema.Literals(["ipv4", "ipv6", "hostname"])),
});

const peerPluginIntegrationSchema = Schema.Struct({
  pluginId: NonEmpty,
  credentialMappings: Schema.Array(
    Schema.Struct({
      outputKey: NonEmpty,
      credentialKey: NonEmpty,
    }),
  ),
  tabLabel: NonEmpty,
  showWhen: Schema.optional(
    Schema.Struct({
      fieldKey: NonEmpty,
      equals: Schema.optional(Schema.String),
      prefix: Schema.optional(Schema.String),
    }),
  ),
  requiresFields: Schema.optional(Schema.Array(NonEmpty)),
  unreachableWhen: Schema.optional(
    Schema.Struct({
      fieldsEmpty: Schema.Array(NonEmpty).check(Schema.isMinLength(1)),
      title: NonEmpty,
      suggestions: Schema.Array(NonEmpty),
    }),
  ),
  credentialSetupAction: Schema.optional(peerGuidanceActionSchema),
  exposeMetricsToParent: Schema.optional(Schema.Boolean),
});

const secretExportTemplateSchema = Schema.Struct({
  id: NonEmpty,
  displayName: NonEmpty,
  description: Schema.optional(Schema.String),
  entries: Schema.Array(
    Schema.Struct({
      envKey: NonEmpty,
      outputKey: NonEmpty,
      description: Schema.optional(Schema.String),
    }),
  ).check(Schema.isMinLength(1)),
});

const attachTargetSchema = Schema.Struct({
  pluginId: NonEmpty,
  resourceTypeId: NonEmpty,
  matchField: Schema.optional(Schema.String),
  verb: Schema.optional(Schema.String),
});

const orphanConditionSchema = Schema.Struct({
  fieldKey: NonEmpty,
  when: Schema.Literals(["empty", "equals", "notEquals"]),
  value: Schema.optional(Schema.String),
}).check(
  // `evaluateOrphanRule` falls back to comparing against "" when `value` is
  // absent, so an author who forgets it would silently get a rule that matches
  // empty-valued fields instead of a manifest error.
  rule(
    (c) => c.when === "empty" || c.value !== undefined,
    "orphan condition requires `value` when `when` is 'equals' or 'notEquals'",
    ["value"],
  ),
);

const expiryFieldRuleSchema = Schema.Struct({
  fieldKey: NonEmpty,
  from: Schema.Literals(["expiry", "created"]),
  kind: Schema.Literals([
    "tls-cert",
    "domain",
    "api-token",
    "access-key",
    "k8s-cert",
    "ssh-key",
    "secret-version",
    // "lease" and "extended-support" are deliberately absent: hosts derive those
    // rows, they are not kinds a plugin's lister can declare a field for.
    "other",
  ]),
  label: NonEmpty,
  maxAgeDays: Schema.optional(PositiveInt),
  fallbackFieldKey: Schema.optional(NonEmpty),
}).check(
  // A budget on an absolute deadline is dead config: the author almost certainly
  // meant `from: "created"`, so fail the manifest instead of silently ignoring it.
  rule(
    (r) => r.from === "created" || r.maxAgeDays === undefined,
    'maxAgeDays only applies to `from: "created"` rules',
    ["maxAgeDays"],
  ),
  rule(
    (r) => r.from === "created" || r.fallbackFieldKey === undefined,
    'fallbackFieldKey only applies to `from: "created"` rules',
    ["fallbackFieldKey"],
  ),
);

const orphanRuleSchema = Schema.Struct({
  conditions: Schema.Array(orphanConditionSchema).check(Schema.isMinLength(1)),
  reason: NonEmpty,
});

const severitySchema = Schema.Literals(["critical", "high", "medium", "low"]);

const postureConditionSchema = Schema.Union([
  Schema.Struct({
    fieldKey: NonEmpty,
    when: Schema.Literals(["empty", "equals", "notEquals", "truthy", "falsy"]),
    value: Schema.optional(Schema.String),
  }).check(
    // Same stance as orphan conditions: `evaluatePostureCondition` falls back to
    // comparing against "" when `value` is absent.
    rule(
      (c) => (c.when !== "equals" && c.when !== "notEquals") || c.value !== undefined,
      "posture condition requires `value` when `when` is 'equals' or 'notEquals'",
      ["value"],
    ),
    rule(
      (c) => c.when === "equals" || c.when === "notEquals" || c.value === undefined,
      "`value` only applies to 'equals' / 'notEquals' posture conditions",
      ["value"],
    ),
  ),
  Schema.Struct({
    fieldKey: NonEmpty,
    when: Schema.Literal("olderThanDays"),
    days: PositiveInt,
  }),
]);

const postureCheckRuleSchema = Schema.Struct({
  id: NonEmpty,
  title: NonEmpty,
  severity: severitySchema,
  category: Schema.Literals([
    "public-exposure",
    "encryption",
    "credential-age",
    "data-protection",
    "other",
  ]),
  conditions: Schema.Array(postureConditionSchema).check(Schema.isMinLength(1)),
  reason: NonEmpty,
});

const dnsRoleSchema = Schema.Union([
  Schema.Struct({
    role: Schema.Literal("zone"),
    domainKey: Schema.optional(NonEmpty),
    recordCountKey: Schema.optional(NonEmpty),
    statusKey: Schema.optional(NonEmpty),
    privateKey: Schema.optional(NonEmpty),
    privateValues: Schema.optional(Schema.Array(NonEmpty).check(Schema.isMinLength(1))),
    isPrivate: Schema.optional(Schema.Boolean),
  }).check(
    // A value list with no field to read is dead config; the `maxAgeDays` and
    // `runningValues` stance: fail the manifest rather than never match.
    rule(
      (r) => r.privateKey !== undefined || r.privateValues === undefined,
      "privateValues requires privateKey",
      ["privateKey"],
    ),
    // Two answers to one question: which wins is a coin flip the author didn't
    // intend, so fail rather than pick.
    rule(
      (r) => r.isPrivate === undefined || r.privateKey === undefined,
      "isPrivate and privateKey are mutually exclusive",
      ["isPrivate"],
    ),
  ),
  Schema.Struct({
    role: Schema.Literal("record"),
    nameKey: Schema.optional(NonEmpty),
    typeKey: Schema.optional(NonEmpty),
    contentKey: Schema.optional(NonEmpty),
    ttlKey: Schema.optional(NonEmpty),
    priorityKey: Schema.optional(NonEmpty),
    proxiedKey: Schema.optional(NonEmpty),
    zoneKey: Schema.optional(NonEmpty),
  }),
]).annotate({ expected: "a DNS role (zone or record)" });

const compilesAsRegex = (pattern: string): boolean => {
  try {
    new RegExp(pattern);
    return true;
  } catch {
    return false;
  }
};

// Count *actual* capturing groups structurally: appending an empty alternative
// makes the regex match "", and the match array's length is 1 + the number of
// capturing groups (named ones included). A source scan would miscount `(?=…)` /
// `(?!…)` lookarounds and escaped parens.
const hasCaptureGroup = (pattern: string): boolean => {
  try {
    return (new RegExp(`${pattern}|`).exec("")?.length ?? 1) > 1;
  } catch {
    return false;
  }
};

const dnsServiceHostSchema = Schema.Struct({
  id: NonEmpty,
  label: NonEmpty,
  hostPattern: NonEmpty,
  labelIs: Schema.optional(Schema.Literals(["name", "opaque"])),
  hostKeys: Schema.optional(Schema.Array(NonEmpty).check(Schema.isMinLength(1))),
  severity: Schema.optional(severitySchema),
  reason: NonEmpty,
}).check(
  // Same stance as `sizeFamilyPattern`: a pattern that doesn't compile, or has
  // nothing to capture, would silently classify every record as unmatched.
  rule((r) => compilesAsRegex(r.hostPattern), "hostPattern must be a valid regular expression", [
    "hostPattern",
  ]),
  rule(
    (r) => hasCaptureGroup(r.hostPattern),
    "hostPattern must contain at least one capture group",
    ["hostPattern"],
  ),
  // An opaque provider-minted label can never be matched by name, so without a
  // field holding the full hostname nothing could ever claim it and every record
  // into the namespace would read as dangling.
  rule(
    (r) => r.labelIs !== "opaque" || (r.hostKeys?.length ?? 0) > 0,
    '`labelIs: "opaque"` requires hostKeys',
    ["hostKeys"],
  ),
);

const backupRoleSchema = Schema.Struct({
  role: Schema.Literal("snapshot"),
  backupTypeKey: Schema.optional(NonEmpty),
  backupTypeValues: Schema.optional(Schema.Array(NonEmpty).check(Schema.isMinLength(1))),
  sourceKey: Schema.optional(NonEmpty),
  sourceTemplate: Schema.optional(NonEmpty),
  createdKey: Schema.optional(NonEmpty),
  sizeKey: Schema.optional(NonEmpty),
  sizeUnit: Schema.optional(Schema.Literals(["gib", "bytes"])),
}).check(
  // Neither half of the narrowing is usable alone (the `privateValues requires
  // privateKey` stance, in both directions here: a key with no list would let
  // nothing through).
  rule(
    (r) => (r.backupTypeKey === undefined) === (r.backupTypeValues === undefined),
    "backupTypeKey and backupTypeValues must be declared together",
    ["backupTypeValues"],
  ),
  // Two answers to "what does this protect?", which wins is a coin flip the
  // author didn't intend, so fail rather than pick (the `isPrivate` stance).
  rule(
    (r) => r.sourceKey === undefined || r.sourceTemplate === undefined,
    "sourceKey and sourceTemplate are mutually exclusive",
    ["sourceTemplate"],
  ),
  // A template with nothing to interpolate is a literal, which would match the
  // same resource for every backup of the type: silently attributing every
  // snapshot to one volume.
  rule(
    (r) => r.sourceTemplate === undefined || /\{[^}]+\}/.test(r.sourceTemplate),
    "sourceTemplate must interpolate at least one {field}",
    ["sourceTemplate"],
  ),
  // A unit with no size field to apply it to is dead config (the `maxAgeDays`
  // stance).
  rule((r) => r.sizeUnit === undefined || r.sizeKey !== undefined, "sizeUnit requires sizeKey", [
    "sizeKey",
  ]),
);

const backupPolicySchema = Schema.Struct({
  protectedBy: Schema.Array(NonEmpty),
  automatedBackupFieldKey: Schema.optional(NonEmpty),
  automatedBackupWhen: Schema.optional(Schema.Literals(["truthy", "present"])),
  retentionDaysFieldKey: Schema.optional(NonEmpty),
}).check(
  // A reading with no field to read is dead config, same stance again.
  rule(
    (p) => p.automatedBackupWhen === undefined || p.automatedBackupFieldKey !== undefined,
    "automatedBackupWhen requires automatedBackupFieldKey",
    ["automatedBackupFieldKey"],
  ),
  // A policy that names no protector type and no provider-native backup field can
  // never be judged either way: the type would sit on the surface as a permanent
  // "unknown". That is dead config, so fail the manifest (the `maxAgeDays` /
  // `runningValues` stance) rather than ship a row that means nothing.
  rule(
    (p) =>
      p.protectedBy.length > 0 ||
      p.automatedBackupFieldKey !== undefined ||
      p.retentionDaysFieldKey !== undefined,
    "backupPolicy needs at least one of protectedBy, automatedBackupFieldKey or retentionDaysFieldKey",
    ["protectedBy"],
  ),
);

const lifecycleActionsSchema = Schema.Struct({
  startActionId: NonEmpty,
  stopActionId: NonEmpty,
  statusFieldKey: Schema.optional(NonEmpty),
  runningValues: Schema.optional(Schema.Array(NonEmpty).check(Schema.isMinLength(1))),
  stoppedValues: Schema.optional(Schema.Array(NonEmpty).check(Schema.isMinLength(1))),
}).check(
  // A single action can't both stop and start: an identical pair is a typo that
  // would make every scheduled transition a no-op or a flap.
  rule((l) => l.startActionId !== l.stopActionId, "startActionId and stopActionId must differ", [
    "stopActionId",
  ]),
  // Value lists without a field to read are dead config; fail the manifest rather
  // than silently never matching (the `maxAgeDays` stance).
  rule(
    (l) => l.statusFieldKey !== undefined || (!l.runningValues && !l.stoppedValues),
    "runningValues/stoppedValues require statusFieldKey",
    ["statusFieldKey"],
  ),
);

const carbonSchema = Schema.Struct({
  role: Schema.optional(Schema.Literals(["instance", "aggregate"])),
  mayDuplicateInstance: Schema.optional(Schema.Boolean),
  regionFieldKey: NonEmpty,
  grid: Schema.optional(NonEmpty),
  gridFieldKey: Schema.optional(NonEmpty),
  vcpus: Schema.Union([
    Schema.Struct({
      from: Schema.Literal("field"),
      fieldKey: NonEmpty,
      format: Schema.optional(Schema.Literals(["number", "k8s-quantity"])),
    }),
    Schema.Struct({
      from: Schema.Literal("size"),
      sizeFieldKey: NonEmpty,
      catalogueTypeId: Schema.optional(NonEmpty),
      catalogueFieldKey: Schema.optional(NonEmpty),
      matchBy: Schema.optional(Schema.Literals(["id", "label"])),
      stripPrefix: Schema.optional(NonEmpty),
      stripSuffix: Schema.optional(NonEmpty),
      list: Schema.optional(Schema.Boolean),
    }),
  ]).annotate({ expected: "a vCPU source (field or size)" }),
  countFieldKey: Schema.optional(NonEmpty),
  countOffset: Schema.optional(Int.check(Schema.isGreaterThanOrEqualTo(0))),
});

const isoDay = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/, { message: "expected YYYY-MM-DD" }),
);

const extendedSupportConditionSchema = Schema.Struct({
  fieldKey: NonEmpty,
  in: Schema.optional(Schema.Array(NonEmpty).check(Schema.isMinLength(1))),
  notIn: Schema.optional(Schema.Array(NonEmpty).check(Schema.isMinLength(1))),
}).check(
  // A condition with neither list would always pass, which is a silent no-op.
  rule(
    (c) => (c.in === undefined) !== (c.notIn === undefined),
    "extended support condition needs exactly one of `in` / `notIn`",
  ),
);

const extendedSupportReleaseSchema = Schema.Struct({
  id: NonEmpty,
  product: NonEmpty,
  engines: Schema.optional(Schema.Array(NonEmpty).check(Schema.isMinLength(1))),
  versions: Schema.Array(NonEmpty).check(Schema.isMinLength(1)),
  standardSupportEnds: isoDay,
  extendedSupportEnds: Schema.optional(isoDay),
  targetVersion: NonEmpty,
  surcharge: Schema.optional(
    Schema.Struct({
      unit: Schema.Literals([
        "cluster-hour",
        "vcpu-hour",
        "vcore-hour",
        "node-hour",
        "instance-hour",
        "acu-hour",
      ]),
      currency: Schema.String.check(Schema.isBetweenLength(3, 3)),
      tiers: Schema.Array(
        Schema.Struct({
          from: isoDay,
          rate: Schema.optional(Positive),
          label: NonEmpty,
        }),
      ).check(
        Schema.isMinLength(1),
        // Hosts pick "the last tier whose `from` has passed", which only works
        // over an ascending list.
        rule(
          (tiers) => tiers.every((t, i) => i === 0 || tiers[i - 1]!.from < t.from),
          "surcharge tiers must be strictly ascending by `from`",
        ),
      ),
      pricingUrl: Url,
      priceNote: Schema.optional(NonEmpty),
    }),
  ),
  upgradeUrl: Url,
  note: Schema.optional(NonEmpty),
}).check(
  rule(
    (r) => !r.extendedSupportEnds || r.extendedSupportEnds > r.standardSupportEnds,
    "extendedSupportEnds must be after standardSupportEnds",
    ["extendedSupportEnds"],
  ),
);

const extendedSupportSchema = Schema.Struct({
  versionFieldKey: NonEmpty,
  engineFieldKey: Schema.optional(NonEmpty),
  quantityFieldKey: Schema.optional(NonEmpty),
  regionFieldKey: Schema.optional(NonEmpty),
  chargedWhen: Schema.optional(
    Schema.Array(extendedSupportConditionSchema).check(Schema.isMinLength(1)),
  ),
  notChargedNote: Schema.optional(NonEmpty),
  releases: Schema.Array(extendedSupportReleaseSchema).check(Schema.isMinLength(1)),
}).check(
  rule(
    (d) => new Set(d.releases.map((r) => r.id)).size === d.releases.length,
    "extended support release ids must be unique within the type",
    ["releases"],
  ),
  // Engine-scoped releases need somewhere to read the engine from, or they would
  // never match and the author would never find out why.
  rule(
    (d) => d.engineFieldKey !== undefined || d.releases.every((r) => !r.engines),
    "releases with `engines` need `engineFieldKey` on the declaration",
    ["engineFieldKey"],
  ),
);

const rightsizingSchema = Schema.Struct({
  sizeFieldKey: NonEmpty,
  createSizeFieldKey: Schema.optional(NonEmpty),
  regionFieldKey: Schema.optional(NonEmpty),
  diskFieldKey: Schema.optional(NonEmpty),
  cpuMetric: Schema.Struct({
    seriesLabel: NonEmpty,
    scale: Schema.optional(Schema.Literals(["percent", "fraction"])),
  }),
  memoryMetric: Schema.optional(
    Schema.Struct({
      seriesLabel: NonEmpty,
      interpretation: Schema.Literals(["percent", "used-bytes", "available-bytes"]),
    }),
  ),
  priceCurrency: Schema.optional(Schema.String.check(Schema.isBetweenLength(3, 3))),
  sizeFamilyPattern: Schema.optional(NonEmpty),
  resizeNote: Schema.optional(NonEmpty),
}).check(
  // A family guard that doesn't compile, or has nothing to capture, would silently
  // disable (or worse, never constrain) candidate filtering: fail the manifest
  // instead (the `maxAgeDays` stance).
  rule(
    (r) => r.sizeFamilyPattern === undefined || compilesAsRegex(r.sizeFamilyPattern),
    "sizeFamilyPattern must be a valid regular expression",
    ["sizeFamilyPattern"],
  ),
  rule(
    (r) => r.sizeFamilyPattern === undefined || hasCaptureGroup(r.sizeFamilyPattern),
    "sizeFamilyPattern must contain at least one capture group",
    ["sizeFamilyPattern"],
  ),
);

const principalRoleSchema = Schema.Struct({
  role: Schema.Literals(["user", "group", "role", "service-account", "key", "binding"]),
  lastUsedKey: Schema.optional(NonEmpty),
  createdKey: Schema.optional(NonEmpty),
  adminIndicatorKey: Schema.optional(NonEmpty),
  adminValues: Schema.optional(Schema.Array(NonEmpty).check(Schema.isMinLength(1))),
  parentKey: Schema.optional(NonEmpty),
  mfaKey: Schema.optional(NonEmpty),
  revokeActionId: Schema.optional(NonEmpty),
}).check(
  // A value list with no field to read is dead config; the `privateValues` /
  // `runningValues` / `maxAgeDays` stance: fail the manifest rather than silently
  // never match.
  rule(
    (p) => p.adminIndicatorKey !== undefined || p.adminValues === undefined,
    "adminValues requires adminIndicatorKey",
    ["adminIndicatorKey"],
  ),
  // Only a human sign-in identity can enrol a second factor. An `mfaKey` on a key,
  // a binding or a service account is a field that can never mean what the author
  // thought, and the "no MFA" finding it produced would be a permanent false
  // accusation.
  rule(
    (p) => p.mfaKey === undefined || p.role === "user",
    'mfaKey only applies to `role: "user"` principals',
    ["mfaKey"],
  ),
);

const runningImagesSchema = Schema.Struct({
  imageKeys: Schema.Array(NonEmpty).check(Schema.isMinLength(1)),
  digestKeys: Schema.optional(Schema.Array(NonEmpty).check(Schema.isMinLength(1))),
  runningKey: Schema.optional(NonEmpty),
  runningValues: Schema.optional(Schema.Array(NonEmpty).check(Schema.isMinLength(1))),
}).check(
  // A running field with no values (or values with no field) is dead config: the
  // `adminValues` stance.
  rule(
    (d) => (d.runningKey === undefined) === (d.runningValues === undefined),
    "runningKey and runningValues must be declared together",
    ["runningValues"],
  ),
);

export const resourceTypeDefinitionSchema = Schema.Struct({
  id: NonEmpty,
  displayName: NonEmpty,
  pluralDisplayName: NonEmpty,
  description: NonEmpty,
  fields: Schema.Array(fieldDefinitionSchema),
  outputs: Schema.Array(resourceOutputSchema),
  dependsOn: Schema.optional(
    Schema.Array(
      Schema.Struct({
        fieldKey: Schema.String,
        from: Schema.optional(Schema.Literals(["fields", "outputs"])),
        targetTypeId: Schema.optional(Schema.String),
        targetPluginId: Schema.optional(Schema.String),
        targetKey: Schema.optional(Schema.String),
        matchTemplate: Schema.optional(Schema.String),
        label: Schema.optional(Schema.String),
      }),
    ),
  ),
  expiryFields: Schema.optional(Schema.Array(expiryFieldRuleSchema)),
  parentTypeId: Schema.optional(Schema.String),
  showInSidebar: Schema.optional(Schema.Boolean),
  accountRoot: Schema.optional(Schema.Boolean),
  dashboardPinnable: Schema.Boolean,
  iconKey: Schema.optional(Schema.String),
  peerIntegrations: Schema.optional(Schema.Array(peerPluginIntegrationSchema)),
  sshEndpoint: Schema.optional(
    Schema.Struct({
      hostOutputKey: Schema.String,
      privateHostOutputKey: Schema.optional(Schema.String),
      runningWhen: Schema.optional(
        Schema.Struct({ fieldKey: Schema.String, value: Schema.String }),
      ),
      defaultUsername: Schema.optional(Schema.String),
      usernameFieldKey: Schema.optional(Schema.String),
    }),
  ),
  agentVm: Schema.optional(
    Schema.Struct({
      sshKeyFieldKey: Schema.String,
      defaultUsername: Schema.String,
      defaultFields: Schema.optional(Schema.Record(Schema.String, Schema.String)),
      defaultFieldLabels: Schema.optional(Schema.Record(Schema.String, Schema.String)),
      linuxImageDefaults: Schema.optional(Schema.Record(Schema.String, Schema.String)),
      hiddenFieldKeys: Schema.optional(Schema.Array(Schema.String)),
    }),
  ),
  sshTunnelAttachSource: Schema.optional(Schema.Boolean),
  supportsStorageBrowser: Schema.optional(Schema.Boolean),
  supportsCreate: Schema.optional(Schema.Boolean),
  supportsDelete: Schema.optional(Schema.Boolean),
  supportsUpdate: Schema.optional(Schema.Boolean),
  supportsTerminal: Schema.optional(Schema.Boolean),
  supportsSftpBrowser: Schema.optional(Schema.Boolean),
  secretExportTemplates: Schema.optional(Schema.Array(secretExportTemplateSchema)),
  resourceSqlDriver: Schema.optional(
    Schema.Struct({ driver: Schema.String, connectionStringOutputKey: Schema.String }),
  ),
  supportsRestQuery: Schema.optional(Schema.Boolean),
  eventSink: Schema.optional(Schema.Boolean),
  supportsMetrics: Schema.optional(Schema.Boolean),
  credentialFormats: Schema.optional(
    Schema.Array(
      Schema.Struct({
        id: Schema.String,
        label: Schema.String,
        description: Schema.optional(Schema.String),
        mediaType: Schema.Literals(["json", "text", "ini", "binary-base64"]),
        filenameTemplate: Schema.optional(Schema.String),
      }),
    ),
  ),
  attachTargets: Schema.optional(Schema.Array(attachTargetSchema)),
  orphanRule: Schema.optional(orphanRuleSchema),
  postureChecks: Schema.optional(Schema.Array(postureCheckRuleSchema)),
  dnsRole: Schema.optional(dnsRoleSchema),
  dnsServiceHosts: Schema.optional(Schema.Array(dnsServiceHostSchema)),
  backupRole: Schema.optional(backupRoleSchema),
  backupPolicy: Schema.optional(backupPolicySchema),
  lifecycle: Schema.optional(lifecycleActionsSchema),
  rightsizing: Schema.optional(rightsizingSchema),
  extendedSupport: Schema.optional(extendedSupportSchema),
  carbon: Schema.optional(carbonSchema),
  principalRole: Schema.optional(principalRoleSchema),
  runningImages: Schema.optional(runningImagesSchema),
});
