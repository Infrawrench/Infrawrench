/**
 * Detail renderer for Firestore databases.
 *
 * Builds the in-detail no-SQL document browser config, plus all the custom
 * tabs: indexes, disaster recovery, time-to-live, operations, usage, and
 * security (rules + IAM).
 */
import type {
  ActionNode,
  DashboardCardSchema,
  DetailViewSchema,
  DetailViewTab,
  HostAction,
  ResourceInstance,
  SchemaNode,
} from "@infrawrench/plugin-base";
import type {
  FirestoreIndexSummary,
  FirestoreBackupSchedule,
  FirestoreTtlConfig,
  FirestoreOperation,
  FirestoreRulesInfo,
  FirestoreBackupInfo,
  FirestoreDatabaseExtras,
  FirestoreUsageMetrics,
  FirestoreIamInfo,
} from "./firestore-handlers.js";
import {
  formatBackupSize,
  formatPitrRetention,
  formatRelativeTime,
  isPermissionError,
} from "./shared-renderers.js";

/** Apply the Firestore database renderer to `base`. */
export function renderFirestoreDatabase(resource: ResourceInstance, base: DetailViewSchema): void {
  const fields = resource.fields;
  const edition = String(fields["databaseEdition"] ?? "STANDARD");
  const type = String(fields["type"] ?? "FIRESTORE_NATIVE");
  const isMongoCompat = edition === "ENTERPRISE" && type === "FIRESTORE_NATIVE";
  base.subtitle =
    edition === "ENTERPRISE"
      ? "Firestore Enterprise"
      : type === "DATASTORE_MODE"
        ? "Firestore (Datastore mode)"
        : "Firestore Native";

  const parseJson = <T>(raw: unknown, fallback: T): T => {
    try {
      return JSON.parse(String(raw ?? "")) as T;
    } catch {
      return fallback;
    }
  };
  const collections = parseJson(resource.resolvedOutputs["firestoreCollections"], [] as string[]);
  const indexes = parseJson(
    resource.resolvedOutputs["firestoreIndexes"],
    [] as FirestoreIndexSummary[],
  );
  const schedules = parseJson(
    resource.resolvedOutputs["firestoreBackupSchedules"],
    [] as FirestoreBackupSchedule[],
  );
  const ttlConfigs = parseJson(
    resource.resolvedOutputs["firestoreTtl"],
    [] as FirestoreTtlConfig[],
  );
  const operations = parseJson(
    resource.resolvedOutputs["firestoreOperations"],
    [] as FirestoreOperation[],
  );
  const rulesInfo = parseJson(resource.resolvedOutputs["firestoreRules"], {
    rulesetName: "",
    content: "",
    updateTime: "",
    error: "",
  } as FirestoreRulesInfo);
  const backups = parseJson(
    resource.resolvedOutputs["firestoreBackups"],
    [] as FirestoreBackupInfo[],
  );
  const extras = parseJson(resource.resolvedOutputs["firestoreDatabaseExtras"], {
    earliestVersionTime: "",
    versionRetentionPeriod: "",
    pointInTimeRecoveryEnablement: "",
  } as FirestoreDatabaseExtras);
  const metrics = parseJson(resource.resolvedOutputs["firestoreUsageMetrics"], {
    reads24h: 0,
    writes24h: 0,
    deletes24h: 0,
    storageBytes: 0,
    available: false,
    error: "",
  } as FirestoreUsageMetrics);
  const iamInfo = parseJson(resource.resolvedOutputs["firestoreIam"], {
    bindings: [],
    etag: "",
    error: "",
  } as FirestoreIamInfo);
  const indexesError = String(resource.resolvedOutputs["firestoreIndexesError"] ?? "");

  // Inline document browser — MongoDB peer for Enterprise+MongoDB-compat
  // (host resolves a user-linked MongoDB account), otherwise native
  // Firestore REST.
  base.noSqlBrowser = {
    driver: isMongoCompat ? "mongodb-peer" : "firestore",
    databaseLabel: String(fields["name"] ?? resource.displayName),
    ...(isMongoCompat
      ? {
          helpText:
            "Enterprise databases with MongoDB compatibility speak the MongoDB wire protocol. Link a MongoDB account in your sidebar to browse this database inline.",
        }
      : {}),
  };

  // Render indexes and backup schedules as clickable pills in the
  // detail view's `children` grid. Each pill's `onClickAction` is a
  // `prompt-nosql-command` that deletes that specific resource — the
  // full name is pre-filled so the user only confirms the label.
  const indexPills: DashboardCardSchema[] = indexes.map((idx) => ({
    pluginId: "gcp",
    resourceTypeId: "firestore-index",
    // Not a real registered resource type — `onClickAction` replaces
    // the default navigate-to-resource behavior, so the id just needs
    // to be unique per pill.
    resourceId: idx.fullName,
    displayName: idx.fieldsDesc || idx.name,
    badges: [
      { kind: "badge", label: idx.collectionGroup || "—", color: "blue" },
      { kind: "badge", label: idx.state || "READY", color: "gray" },
    ],
    status: {
      kind: "status-dot",
      status:
        idx.state === "READY"
          ? "healthy"
          : idx.state === "CREATING"
            ? "provisioning"
            : idx.state === "NEEDS_REPAIR"
              ? "error"
              : "info",
      ...(idx.state ? { label: idx.state } : {}),
    },
    onClickAction: {
      type: "prompt-nosql-command",
      command: "deleteIndex",
      title: `Delete index on ${idx.collectionGroup}`,
      description: `${idx.fieldsDesc || idx.name} — queries that depended on this index will stop working.`,
      fields: [
        {
          key: "indexName",
          label: "Index resource name",
          kind: "text",
          required: true,
          defaultValue: idx.fullName,
          hidden: true,
        },
      ],
      submitLabel: "Delete index",
      danger: true,
    },
  }));
  const schedulePills: DashboardCardSchema[] = schedules.map((s) => ({
    pluginId: "gcp",
    resourceTypeId: "firestore-backup-schedule",
    resourceId: s.fullName,
    displayName: s.name,
    badges: [
      { kind: "badge", label: s.recurrence, color: "blue" },
      ...(s.retention
        ? [{ kind: "badge" as const, label: s.retention, color: "gray" as const }]
        : []),
    ],
    status: { kind: "status-dot", status: "healthy", label: "Active" },
    onClickAction: {
      type: "prompt-nosql-command",
      command: "deleteBackupSchedule",
      title: `Delete schedule ${s.name}`,
      description: `${s.recurrence} backup schedule retained for ${s.retention || "an unspecified period"} — existing backups are unaffected.`,
      fields: [
        {
          key: "scheduleName",
          label: "Schedule resource name",
          kind: "text",
          required: true,
          defaultValue: s.fullName,
          hidden: true,
        },
      ],
      submitLabel: "Delete schedule",
      danger: true,
    },
  }));

  const createIndexAction: HostAction = {
    type: "prompt-nosql-command",
    command: "createIndex",
    title: "Create composite index",
    fields: [
      {
        key: "collection",
        label: "Collection",
        description:
          "Collection group to index. Firestore applies the index to every sub-collection with this id.",
        kind: "text",
        required: true,
        placeholder: "users",
      },
      {
        key: "fields",
        label: "Fields",
        description: "Add each field you want to index and pick an order.",
        kind: "key-value-list",
        required: true,
        entryKeyName: "fieldPath",
        entryValueName: "order",
        entryKeyLabel: "Field path",
        entryKeyPlaceholder: "email",
        entryValueLabel: "Order",
        entryValueOptions: [
          { id: "ASCENDING", label: "Asc" },
          { id: "DESCENDING", label: "Desc" },
          { id: "CONTAINS", label: "Array contains" },
        ],
        entryValueDefault: "ASCENDING",
        addLabel: "+ Add field",
        minEntries: 1,
      },
      {
        key: "queryScope",
        label: "Query scope",
        kind: "select",
        required: true,
        defaultValue: "COLLECTION",
        options: [
          { id: "COLLECTION", label: "Collection" },
          { id: "COLLECTION_GROUP", label: "Collection group" },
        ],
      },
    ],
    submitLabel: "Create index",
  };

  const createScheduleAction: HostAction = {
    type: "prompt-nosql-command",
    command: "createBackupSchedule",
    title: "Create backup schedule",
    fields: [
      {
        key: "recurrence",
        label: "Recurrence",
        kind: "select",
        required: true,
        defaultValue: "daily",
        options: [
          { id: "daily", label: "Daily" },
          { id: "weekly", label: "Weekly" },
        ],
      },
      {
        key: "retentionSeconds",
        label: "Retention (seconds)",
        description: "How long each backup is kept. 604800 = 7 days; 3024000 = 35 days.",
        kind: "number",
        required: true,
        defaultValue: "604800",
        minValue: 3600,
        maxValue: 3024000,
        stepValue: 3600,
      },
      {
        key: "weekDay",
        label: "Day of week",
        kind: "select",
        required: true,
        defaultValue: "MONDAY",
        showWhen: { fieldKey: "recurrence", fieldValue: "weekly" },
        options: [
          { id: "MONDAY", label: "Monday" },
          { id: "TUESDAY", label: "Tuesday" },
          { id: "WEDNESDAY", label: "Wednesday" },
          { id: "THURSDAY", label: "Thursday" },
          { id: "FRIDAY", label: "Friday" },
          { id: "SATURDAY", label: "Saturday" },
          { id: "SUNDAY", label: "Sunday" },
        ],
      },
    ],
    submitLabel: "Create schedule",
  };

  const ttlPills: DashboardCardSchema[] = ttlConfigs.map((t) => ({
    pluginId: "gcp",
    resourceTypeId: "firestore-ttl-config",
    resourceId: t.fullName,
    displayName: `${t.collectionGroup}.${t.fieldPath}`,
    badges: [{ kind: "badge", label: t.state || "ACTIVE", color: "blue" }],
    status: {
      kind: "status-dot",
      status: t.state === "ACTIVE" ? "healthy" : "provisioning",
      ...(t.state ? { label: t.state } : {}),
    },
    onClickAction: {
      type: "prompt-nosql-command",
      command: "unsetTtl",
      title: `Remove TTL on ${t.collectionGroup}.${t.fieldPath}`,
      description:
        "Stop expiring documents based on this field. Existing documents are not deleted by this action.",
      fields: [
        {
          key: "fieldFullName",
          label: "Field resource name",
          kind: "text",
          required: true,
          defaultValue: t.fullName,
          hidden: true,
        },
      ],
      submitLabel: "Remove TTL",
      danger: true,
    },
  }));

  const operationPills: DashboardCardSchema[] = operations.map((op) => ({
    pluginId: "gcp",
    resourceTypeId: "firestore-operation",
    resourceId: op.fullName,
    displayName: op.kind || op.id,
    badges: [{ kind: "badge", label: op.state || "—", color: "gray" }],
    status: {
      kind: "status-dot",
      status:
        op.error || op.state === "FAILED"
          ? "error"
          : op.state === "SUCCESSFUL" || op.state === "DONE"
            ? "healthy"
            : op.state === "CANCELLED"
              ? "info"
              : "provisioning",
      label: op.error ? "Error" : op.state || "Running",
    },
    // Operations have no detail page to navigate to — render as
    // read-only status chips.
    nonInteractive: true,
  }));

  const firestoreCustomTabs: DetailViewTab[] = [
    {
      id: "indexes",
      label: "Indexes",
      childGroups: [
        {
          title: "Composite indexes",
          items: indexPills,
          emptyText: indexesError
            ? `Failed to list indexes: ${indexesError}`
            : isMongoCompat
              ? "No Firestore-native composite indexes defined. MongoDB-style indexes on Enterprise DBs are managed via the MongoDB driver (Documents tab)."
              : "No composite indexes defined.",
          createLabel: "+ Create index",
          createAction: createIndexAction,
        },
      ],
    },
    {
      id: "disaster-recovery",
      label: "Disaster recovery",
      childGroups: [
        {
          title: "Backup schedules",
          items: schedulePills,
          emptyText: "No backup schedules configured.",
          createLabel: "+ Create schedule",
          createAction: createScheduleAction,
        },
        {
          title: "Completed backups",
          items: backups.map((b) => ({
            pluginId: "gcp",
            resourceTypeId: "firestore-backup",
            resourceId: b.fullName,
            displayName: b.name,
            badges: [
              { kind: "badge", label: b.state || "—", color: "blue" },
              ...(b.sizeBytes
                ? [
                    {
                      kind: "badge" as const,
                      label: formatBackupSize(b.sizeBytes),
                      color: "gray" as const,
                    },
                  ]
                : []),
            ],
            status: {
              kind: "status-dot",
              status: b.state === "READY" ? "healthy" : "provisioning",
              label: b.snapshotTime ? formatRelativeTime(b.snapshotTime) : b.state,
            },
          })),
          emptyText: "No backups yet. Completed backups from your schedules will appear here.",
        },
      ],
      sections: [
        {
          kind: "section",
          title: "Point-in-time recovery",
          children: [
            {
              kind: "key-value-list",
              items: [
                {
                  key: "State",
                  value:
                    extras.pointInTimeRecoveryEnablement === "POINT_IN_TIME_RECOVERY_ENABLED"
                      ? "Enabled"
                      : "Disabled",
                },
                {
                  key: "Retention window",
                  value: formatPitrRetention(extras.versionRetentionPeriod),
                },
                {
                  key: "Earliest readable timestamp",
                  value: extras.earliestVersionTime || "—",
                },
              ],
            },
          ],
        },
      ],
    },
    {
      id: "ttl",
      label: "Time-to-live",
      childGroups: [
        {
          title: "TTL policies",
          items: ttlPills,
          emptyText: "No TTL policies configured. Add one to auto-delete documents by timestamp.",
          createLabel: "+ Set TTL",
          createAction: {
            type: "prompt-nosql-command",
            command: "setTtl",
            title: "Set TTL policy",
            description:
              "Documents in the chosen collection group whose field holds a past timestamp will be deleted within 24 hours.",
            fields: [
              {
                key: "collectionGroup",
                label: "Collection group",
                kind: "text",
                required: true,
                placeholder: "sessions",
              },
              {
                key: "fieldPath",
                label: "Field name",
                description:
                  "Name of a timestamp-typed field on your documents (e.g. expiresAt). Documents whose value at that field is in the past are deleted within 24 hours. Use dotted paths for nested fields.",
                kind: "text",
                required: true,
                placeholder: "expiresAt",
              },
            ],
            submitLabel: "Set TTL",
          },
        },
      ],
    },
    {
      id: "operations",
      label: "Operations",
      headerActions: [
        {
          kind: "action",
          label: "Export",
          action: {
            type: "prompt-nosql-command",
            command: "exportDocuments",
            title: "Export database",
            description:
              "Write all documents (or selected collections) to a GCS bucket. The service account must have `roles/storage.objectAdmin` on the destination bucket.",
            fields: [
              {
                key: "outputUri",
                label: "GCS output prefix",
                description:
                  "gs://bucket-name/some/path — an export folder will be created under it.",
                kind: "text",
                required: true,
                placeholder: "gs://my-bucket/firestore-exports",
              },
              {
                key: "collectionIds",
                label: "Collections to export (comma-separated)",
                description: "Leave blank to export every collection.",
                kind: "text",
                required: false,
                placeholder: "users, orders",
              },
            ],
            submitLabel: "Start export",
          },
        },
        {
          kind: "action",
          label: "Import",
          action: {
            type: "prompt-nosql-command",
            command: "importDocuments",
            title: "Import database",
            description:
              "Import documents from a previous Firestore export. Existing documents with the same id are overwritten.",
            fields: [
              {
                key: "inputUri",
                label: "GCS input prefix",
                kind: "text",
                required: true,
                placeholder: "gs://my-bucket/firestore-exports/2026-04-24T12:00:00Z",
              },
              {
                key: "collectionIds",
                label: "Collections to import (comma-separated)",
                description: "Leave blank to import every collection in the export.",
                kind: "text",
                required: false,
              },
            ],
            submitLabel: "Start import",
          },
        },
      ],
      childGroups: [
        {
          title: "Recent operations",
          items: operationPills,
          emptyText: "No recent import or export operations.",
        },
      ],
    },
    {
      id: "usage",
      label: "Usage",
      sections: [
        {
          kind: "section",
          title: "Last 24 hours",
          children: metrics.available
            ? [
                {
                  kind: "key-value-list",
                  items: [
                    { key: "Document reads", value: metrics.reads24h.toLocaleString() },
                    { key: "Document writes", value: metrics.writes24h.toLocaleString() },
                    { key: "Document deletes", value: metrics.deletes24h.toLocaleString() },
                    {
                      key: "Storage",
                      value: metrics.storageBytes
                        ? formatBackupSize(String(metrics.storageBytes))
                        : "—",
                    },
                  ],
                },
              ]
            : [
                {
                  kind: "text",
                  content: metrics.error || "Metrics unavailable.",
                  variant: "muted",
                },
                ...(isPermissionError(metrics.error)
                  ? [
                      {
                        kind: "text" as const,
                        content:
                          "Grant roles/monitoring.viewer to this service account to show live reads/writes/storage here.",
                        variant: "muted" as const,
                      },
                    ]
                  : []),
              ],
        },
        {
          kind: "section",
          title: "Resources",
          children: [
            {
              kind: "key-value-list",
              items: [
                { key: "Collections", value: String(collections.length) },
                { key: "Composite indexes", value: String(indexes.length) },
                { key: "Backup schedules", value: String(schedules.length) },
                { key: "Completed backups", value: String(backups.length) },
                { key: "TTL policies", value: String(ttlConfigs.length) },
                { key: "Recent operations", value: String(operations.length) },
              ],
            },
          ],
        },
      ],
    },
    (() => {
      const defaultRulesTemplate = `rules_version = '2';
service cloud.firestore {
match /databases/{database}/documents {
  match /{document=**} {
    allow read, write: if false;
  }
}
}
`;
      const editRulesAction: HostAction = {
        type: "prompt-nosql-command",
        command: "deployRules",
        title: rulesInfo.content ? "Edit security rules" : "Deploy security rules",
        description:
          "Compiles the source into a new ruleset and updates the release for this database. Takes effect in seconds.",
        fields: [
          {
            key: "source",
            label: "firestore.rules",
            description:
              "Firestore Security Rules source. See firebase.google.com/docs/rules/rules-language.",
            kind: "text",
            required: true,
            multiline: true,
            defaultValue: rulesInfo.content || defaultRulesTemplate,
          },
        ],
        submitLabel: "Deploy rules",
      };

      const rulesChildren: SchemaNode[] =
        rulesInfo.error && !rulesInfo.content
          ? [
              { kind: "text", content: rulesInfo.error, variant: "muted" },
              ...(isPermissionError(rulesInfo.error)
                ? [
                    {
                      kind: "text" as const,
                      content:
                        "Grant roles/firebaserules.viewer to this service account to show the deployed firestore.rules here.",
                      variant: "muted" as const,
                    },
                  ]
                : []),
            ]
          : rulesInfo.content
            ? [
                {
                  kind: "key-value-list",
                  items: [
                    ...(rulesInfo.updateTime
                      ? [
                          {
                            key: "Last deployed",
                            value: formatRelativeTime(rulesInfo.updateTime),
                          },
                        ]
                      : []),
                    ...(rulesInfo.rulesetName
                      ? [
                          {
                            key: "Ruleset",
                            value: rulesInfo.rulesetName.split("/").pop() ?? rulesInfo.rulesetName,
                          },
                        ]
                      : []),
                  ],
                },
                { kind: "text", content: rulesInfo.content, variant: "mono" },
              ]
            : [
                {
                  kind: "text",
                  content:
                    "No rules deployed to this database yet. Deploy rules to restrict access — without them, the database uses project-IAM-only access.",
                  variant: "muted",
                },
              ];

      const grantRoleAction: HostAction = {
        type: "prompt-nosql-command",
        command: "grantIamRole",
        title: "Grant Firestore role",
        description:
          "Adds a project IAM binding. Use the user:, serviceAccount:, or group: prefix for the principal.",
        fields: [
          {
            key: "role",
            label: "Role",
            kind: "select",
            required: true,
            options: [
              { id: "roles/datastore.user", label: "Datastore User (read/write)" },
              { id: "roles/datastore.viewer", label: "Datastore Viewer (read-only)" },
              { id: "roles/datastore.owner", label: "Datastore Owner (full access)" },
              { id: "roles/datastore.indexAdmin", label: "Datastore Index Admin" },
              {
                id: "roles/datastore.importExportAdmin",
                label: "Datastore Import/Export Admin",
              },
              {
                id: "roles/datastore.keyVisualizerViewer",
                label: "Datastore Key Visualizer Viewer",
              },
              { id: "roles/firebaserules.admin", label: "Firebase Rules Admin" },
              { id: "roles/firebaserules.viewer", label: "Firebase Rules Viewer" },
            ],
            defaultValue: "roles/datastore.user",
          },
          {
            key: "member",
            label: "Principal",
            description:
              "user:alice@example.com, serviceAccount:…@…iam.gserviceaccount.com, or group:ops@example.com",
            kind: "text",
            required: true,
            placeholder: "user:alice@example.com",
          },
        ],
        submitLabel: "Grant role",
      };

      const flatBindings = iamInfo.bindings.flatMap((b) =>
        b.members.map((m) => {
          const colon = m.indexOf(":");
          return {
            role: b.role,
            type: colon > 0 ? m.slice(0, colon) : "principal",
            principal: colon > 0 ? m.slice(colon + 1) : m,
            raw: m,
          };
        }),
      );

      const revokeAction: HostAction = {
        type: "prompt-nosql-command",
        command: "revokeIamMember",
        title: "Revoke Firestore role",
        description:
          "Removes one principal from one role binding. The binding is deleted when the last member is removed.",
        fields: [
          {
            key: "binding",
            label: "Binding to revoke",
            kind: "select",
            required: true,
            options: flatBindings.map((fb) => ({
              id: `${fb.role}|${fb.raw}`,
              label: `${fb.role.replace(/^roles\//, "")} — ${fb.raw}`,
            })),
            defaultValue:
              flatBindings.length > 0 ? `${flatBindings[0]!.role}|${flatBindings[0]!.raw}` : "",
          },
        ],
        submitLabel: "Revoke",
        danger: true,
      };

      const iamChildren: SchemaNode[] = iamInfo.error
        ? [
            { kind: "text", content: iamInfo.error, variant: "muted" },
            ...(isPermissionError(iamInfo.error)
              ? [
                  {
                    kind: "text" as const,
                    content:
                      "Grant roles/resourcemanager.projectIamAdmin (or roles/iam.securityReviewer for read-only) to list and manage IAM bindings.",
                    variant: "muted" as const,
                  },
                ]
              : []),
          ]
        : flatBindings.length === 0
          ? [
              {
                kind: "text",
                content:
                  "No Firestore-related IAM bindings on this project. Grant a role to let principals access the database.",
                variant: "muted",
              },
            ]
          : [
              {
                kind: "text",
                content:
                  "Firestore access is controlled by project-level IAM. Grant, revoke, or review role bindings below.",
                variant: "muted",
              },
              {
                kind: "table",
                emphasizeFirstColumn: true,
                columns: [
                  { key: "role", label: "Role" },
                  { key: "type", label: "Type", width: "narrow" },
                  { key: "principal", label: "Principal", mono: true },
                ],
                rows: flatBindings.map((fb) => ({
                  cells: {
                    role: fb.role.replace(/^roles\//, ""),
                    type: fb.type,
                    principal: fb.principal,
                  },
                })),
              },
            ];

      const headerActions: ActionNode[] = [
        {
          kind: "action",
          label: rulesInfo.content ? "Edit rules" : "Deploy rules",
          action: editRulesAction,
        },
        { kind: "action", label: "Grant role", action: grantRoleAction },
        ...(flatBindings.length > 0
          ? [
              {
                kind: "action" as const,
                label: "Revoke member",
                variant: "danger" as const,
                action: revokeAction,
              },
            ]
          : []),
      ];

      return {
        id: "security",
        label: "Security",
        headerActions,
        sections: [
          {
            kind: "section",
            title: "Active ruleset",
            children: rulesChildren,
          },
          {
            kind: "section",
            title: "IAM",
            children: iamChildren,
          },
        ],
      } as DetailViewTab;
    })(),
  ];
  base.customTabs = [...(base.customTabs ?? []), ...firestoreCustomTabs];
}
