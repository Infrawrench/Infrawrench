/**
 * DynamoDB-specific detail renderer pieces — the "Schema & indexes" tab
 * and the `_indexesJson` payload decoder shared with the lister.
 *
 * Kept separate from the catch-all render-resource.ts so the GSI/LSI logic
 * doesn't bloat the generic renderer for every resource type.
 */
import type {
  ChildGroupSchema,
  DashboardCardSchema,
  DetailViewTab,
  HostAction,
  SectionNode,
} from "@infrawrench/plugin-base";

export interface DynamoIndexesPayload {
  attributeDefinitions: Array<{ AttributeName?: string; AttributeType?: string }>;
  keySchema: Array<{ AttributeName?: string; KeyType?: string }>;
  globalSecondaryIndexes: Array<Record<string, unknown>>;
  localSecondaryIndexes: Array<Record<string, unknown>>;
}

export function decodeIndexesField(raw: unknown): DynamoIndexesPayload {
  if (typeof raw !== "string" || raw.length === 0) {
    return {
      attributeDefinitions: [],
      keySchema: [],
      globalSecondaryIndexes: [],
      localSecondaryIndexes: [],
    };
  }
  try {
    const parsed = JSON.parse(raw) as DynamoIndexesPayload;
    return {
      attributeDefinitions: parsed.attributeDefinitions ?? [],
      keySchema: parsed.keySchema ?? [],
      globalSecondaryIndexes: parsed.globalSecondaryIndexes ?? [],
      localSecondaryIndexes: parsed.localSecondaryIndexes ?? [],
    };
  } catch {
    return {
      attributeDefinitions: [],
      keySchema: [],
      globalSecondaryIndexes: [],
      localSecondaryIndexes: [],
    };
  }
}

function describeKeys(ks: Array<{ AttributeName?: string; KeyType?: string }>): string {
  const pk = ks.find((k) => k.KeyType === "HASH")?.AttributeName;
  const sk = ks.find((k) => k.KeyType === "RANGE")?.AttributeName;
  if (!pk) return "—";
  return sk ? `${pk} / ${sk}` : pk;
}

function projectionLabel(p: Record<string, unknown> | undefined): string {
  if (!p) return "—";
  const t = String(p["ProjectionType"] ?? "");
  if (t === "INCLUDE") {
    const cols = (p["NonKeyAttributes"] as string[] | undefined) ?? [];
    return `INCLUDE (${cols.join(", ") || "—"})`;
  }
  return t || "—";
}

/** Map a DynamoDB IndexStatus string onto the host's status-dot palette. */
function gsiStatusDot(status: string): {
  status: "healthy" | "provisioning" | "error" | "info";
  label: string;
} {
  if (status === "ACTIVE") return { status: "healthy", label: "Active" };
  if (status === "CREATING") return { status: "provisioning", label: "Creating" };
  if (status === "UPDATING") return { status: "provisioning", label: "Updating" };
  if (status === "DELETING") return { status: "provisioning", label: "Deleting" };
  return { status: "info", label: status || "Unknown" };
}

const ATTR_TYPE_OPTIONS = [
  { id: "S", label: "String" },
  { id: "N", label: "Number" },
  { id: "B", label: "Binary" },
];
const PROJECTION_OPTIONS = [
  { id: "ALL", label: "All attributes" },
  { id: "KEYS_ONLY", label: "Keys only" },
  { id: "INCLUDE", label: "Keys + listed attributes" },
];

/**
 * Build the Schema & indexes tab for a DynamoDB table. Partition/sort keys and
 * LSIs are immutable post-create (DynamoDB rule), so they render as read-only
 * info; only GSIs surface add/delete actions.
 */
export function buildDynamoSchemaTab(payload: DynamoIndexesPayload): DetailViewTab {
  const keySchemaSection: SectionNode = {
    kind: "section",
    title: "Primary key",
    children: [
      {
        kind: "key-value-list",
        items: [
          {
            key: "Partition key",
            value: payload.keySchema.find((k) => k.KeyType === "HASH")?.AttributeName ?? "—",
          },
          {
            key: "Sort key",
            value: payload.keySchema.find((k) => k.KeyType === "RANGE")?.AttributeName ?? "—",
          },
        ],
      },
    ],
  };

  const attrSection: SectionNode = {
    kind: "section",
    title: "Attribute definitions",
    children: [
      payload.attributeDefinitions.length === 0
        ? { kind: "text", content: "No attributes declared.", variant: "muted" }
        : {
            kind: "table",
            columns: [
              { key: "name", label: "Attribute" },
              { key: "type", label: "Type", width: "narrow" },
            ],
            rows: payload.attributeDefinitions.map((a) => ({
              cells: {
                name: a.AttributeName ?? "—",
                type: a.AttributeType ?? "—",
              },
            })),
          },
    ],
  };

  const gsiPills: DashboardCardSchema[] = payload.globalSecondaryIndexes.map((g) => {
    const name = String(g["IndexName"] ?? "—");
    const ks = (g["KeySchema"] as Array<{ AttributeName?: string; KeyType?: string }>) ?? [];
    const proj = g["Projection"] as Record<string, unknown> | undefined;
    const status = String(g["IndexStatus"] ?? "");
    const tp = (g["ProvisionedThroughput"] as Record<string, unknown> | undefined) ?? {};
    const rcu = Number(tp["ReadCapacityUnits"] ?? 0);
    const wcu = Number(tp["WriteCapacityUnits"] ?? 0);
    const itemCount = Number(g["ItemCount"] ?? 0);
    const isProvisioned = rcu > 0 || wcu > 0;
    const sd = gsiStatusDot(status);
    const stats = [
      { label: "Keys", value: describeKeys(ks) },
      { label: "Projection", value: projectionLabel(proj) },
      { label: "Items", value: itemCount.toLocaleString() },
      ...(isProvisioned ? [{ label: "Throughput", value: `${rcu} RCU / ${wcu} WCU` }] : []),
    ];
    return {
      pluginId: "aws",
      resourceTypeId: "dynamodb-gsi",
      resourceId: name,
      displayName: name,
      status: { kind: "status-dot", status: sd.status, label: sd.label },
      stats,
      onClickAction: {
        type: "prompt-nosql-command",
        command: "deleteIndex",
        title: `Delete GSI ${name}`,
        description:
          "Deleting a GSI is asynchronous and can take minutes for large tables. Queries that relied on this index will start failing immediately.",
        fields: [
          {
            key: "indexName",
            label: "Index name",
            kind: "text",
            required: true,
            defaultValue: name,
            hidden: true,
          },
        ],
        submitLabel: "Delete index",
        danger: true,
      },
    };
  });

  const lsiPills: DashboardCardSchema[] = payload.localSecondaryIndexes.map((l) => {
    const name = String(l["IndexName"] ?? "—");
    const ks = (l["KeySchema"] as Array<{ AttributeName?: string; KeyType?: string }>) ?? [];
    const proj = l["Projection"] as Record<string, unknown> | undefined;
    const itemCount = Number(l["ItemCount"] ?? 0);
    return {
      pluginId: "aws",
      resourceTypeId: "dynamodb-lsi",
      resourceId: name,
      displayName: name,
      // LSIs are creation-only in DynamoDB — they have no lifecycle state and
      // can't be deleted, so they render as static informational chips.
      status: { kind: "status-dot", status: "info", label: "Read-only" },
      stats: [
        { label: "Keys", value: describeKeys(ks) },
        { label: "Projection", value: projectionLabel(proj) },
        { label: "Items", value: itemCount.toLocaleString() },
      ],
      nonInteractive: true,
    };
  });

  const createGsiAction: HostAction = {
    type: "prompt-nosql-command",
    command: "createIndex",
    title: "Create global secondary index",
    description:
      "DynamoDB only allows one GSI add/remove per UpdateTable call. The index builds in the background and is queryable once it reports ACTIVE.",
    fields: [
      {
        key: "indexName",
        label: "Index name",
        kind: "text",
        required: true,
        placeholder: "GSI1",
      },
      {
        key: "partitionKey",
        label: "Partition key attribute",
        kind: "text",
        required: true,
        placeholder: "pk",
      },
      {
        key: "partitionKeyType",
        label: "Partition key type",
        kind: "select",
        required: true,
        defaultValue: "S",
        options: ATTR_TYPE_OPTIONS,
      },
      {
        key: "sortKey",
        label: "Sort key attribute (optional)",
        kind: "text",
        required: false,
        placeholder: "createdAt",
      },
      {
        key: "sortKeyType",
        label: "Sort key type",
        description: "Only used when a sort key is specified above.",
        kind: "select",
        required: false,
        defaultValue: "S",
        options: ATTR_TYPE_OPTIONS,
      },
      {
        key: "projection",
        label: "Projection",
        description:
          "Which non-key attributes get copied into the index. ALL is the most flexible but costs the most storage; KEYS_ONLY is cheapest but every query needs a GetItem follow-up.",
        kind: "select",
        required: true,
        defaultValue: "ALL",
        options: PROJECTION_OPTIONS,
      },
      {
        key: "projectionInclude",
        label: "Included attributes",
        description: "Comma-separated list of non-key attributes to project.",
        kind: "text",
        required: false,
        placeholder: "name, createdAt",
        showWhen: { fieldKey: "projection", fieldValue: "INCLUDE" },
      },
    ],
    submitLabel: "Create index",
  };

  const gsiGroup: ChildGroupSchema = {
    title: "Global secondary indexes",
    items: gsiPills,
    emptyText: "No GSIs defined. Click + Create index to add one.",
    createLabel: "+ Create index",
    createAction: createGsiAction,
  };

  const childGroups: ChildGroupSchema[] = [gsiGroup];
  if (lsiPills.length > 0) {
    childGroups.push({
      title: "Local secondary indexes (read-only)",
      items: lsiPills,
      emptyText: "No LSIs defined.",
    });
  }

  return {
    id: "schema",
    label: "Schema & indexes",
    sections: [keySchemaSection, attrSection],
    childGroups,
  };
}
