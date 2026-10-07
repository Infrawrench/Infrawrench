import type {
  ActionNode,
  DetailViewSchema,
  PublishPanelCapability,
  KVItem,
  ResourceInstance,
  ResourceStatus,
  SchemaNode,
  SectionNode,
  SidebarItemSchema,
} from "@infrawrench/plugin-base";
import {
  camelToTitle,
  formatBytes,
  joinSubtitle,
  withMetricsCapability,
} from "@infrawrench/plugin-base";
import { RESOURCE_TYPES } from "./resource-types.js";

/** `prompt-nosql-command` command names, handled by `executeNoSqlCommand`. */
export const COMMANDS = {
  purge: "purge-stream",
  deleteMessage: "delete-message",
  pause: "pause-consumer",
} as const;

export interface RenderOptions {
  /** The account has a server URL, so publish and JetStream writes are available. */
  writable: boolean;
}

const NEEDS_SERVERS =
  "Add the server URL (nats://host:4222) and credentials to this account to publish and to manage JetStream.";

const str = (v: unknown): string => (v === undefined || v === null ? "" : String(v));
const BYTES =
  /(Bytes|bytes|Storage|Memory|memory)$|^bytes$|^maxBytes$|^maxPayload$|^maxMsgSize$|^pendingBytes$/;

function fieldsNode(r: ResourceInstance): SchemaNode {
  const def = RESOURCE_TYPES.find((t) => t.id === r.resourceTypeId);
  const labels = new Map(def?.fields.map((x) => [x.key, x.label]) ?? []);
  const items: KVItem[] = [];
  for (const [key, value] of Object.entries(r.fields)) {
    if (value === "") continue;
    let text = typeof value === "boolean" ? (value ? "Yes" : "No") : String(value);
    if (typeof value === "number" && BYTES.test(key) && !/Msgs|msgs/.test(key))
      text = formatBytes(value);
    items.push({
      key: (labels.get(key) ?? camelToTitle(key)).replace(/ \(bytes\)$/, ""),
      value: text,
    });
  }
  return { kind: "key-value-list", items };
}

const section = (title: string, children: SchemaNode[]): SectionNode => ({
  kind: "section",
  title,
  children,
});

function consumerStatus(f: ResourceInstance["fields"]): { status: ResourceStatus; label: string } {
  const pending = Number(f["pending"] ?? 0);
  if (Number(f["redelivered"] ?? 0) > 0)
    return { status: "degraded", label: `${str(f["redelivered"])} redelivered` };
  if (pending > 0) return { status: "info", label: `${pending} pending` };
  return { status: "healthy", label: "Caught up" };
}

function parseJson<T>(raw: string | undefined): T | undefined {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

const refresh: ActionNode = {
  kind: "action",
  label: "Refresh",
  action: { type: "refresh-resource" },
};

const headersField = {
  key: "headers",
  label: "Headers",
  kind: "key-value-list" as const,
  helpText: "Sent as NATS message headers.",
};

function serverPublish(writable: boolean): PublishPanelCapability {
  return {
    tabLabel: "Publish",
    subtitle: "Publish a message, or send a request and wait for its reply",
    bodyFormat: "text",
    defaultBody: '{"hello":"world"}',
    helpText:
      "Core NATS publish: subscribers on the subject receive it at once; nothing is stored unless a stream captures the subject. Request waits for the first reply.",
    submitLabel: "Send",
    extraFields: [
      {
        key: "subject",
        label: "Subject",
        kind: "text",
        placeholder: "orders.created",
        helpText: "A concrete subject: no spaces, * or >.",
      },
      {
        key: "mode",
        label: "Mode",
        kind: "select",
        defaultValue: "core",
        options: [
          { value: "core", label: "Publish" },
          { value: "request", label: "Request (wait for a reply)" },
          { value: "jetstream", label: "Publish to JetStream (wait for the stored ack)" },
        ],
      },
      {
        key: "timeoutMs",
        label: "Timeout (ms)",
        kind: "number",
        defaultValue: "5000",
        optional: true,
        helpText: "How long a request or JetStream publish waits.",
      },
      headersField,
    ],
    ...(writable ? {} : { disabledReason: NEEDS_SERVERS }),
  };
}

function streamPublish(f: ResourceInstance["fields"], writable: boolean): PublishPanelCapability {
  const subjects = str(f["subjects"]).split(/,\s*/).filter(Boolean);
  const concrete = subjects.find((x) => !/[*>]/.test(x));
  const example = subjects[0]?.replace(/\.>$/, ".example").replace(/\*/g, "example");
  return {
    tabLabel: "Publish",
    subtitle: `Publish a message into ${str(f["name"])} and wait for it to be stored`,
    bodyFormat: "text",
    defaultBody: '{"hello":"world"}',
    helpText: `JetStream publish: the server acknowledges with the message's sequence. Subjects: ${subjects.join(", ") || "none"}.`,
    submitLabel: "Publish",
    extraFields: [
      {
        key: "subject",
        label: "Subject",
        kind: "text",
        ...(concrete ? { defaultValue: concrete } : {}),
        ...(example ? { placeholder: example } : {}),
        helpText: "Must match one of the stream's subjects.",
      },
      {
        key: "msgId",
        label: "Message ID",
        kind: "text",
        optional: true,
        helpText: "Nats-Msg-Id: a repeat inside the duplicate window is not stored twice.",
      },
      headersField,
    ],
    ...(writable ? {} : { disabledReason: NEEDS_SERVERS }),
  };
}

function streamActions(f: ResourceInstance["fields"]): ActionNode[] {
  const name = str(f["name"]);
  const out: ActionNode[] = [];
  if (f["denyPurge"] !== true)
    out.push(
      {
        kind: "action",
        label: "Purge",
        variant: "danger",
        action: {
          type: "plugin-action",
          actionId: "purge",
          confirmMessage: `Remove every message from ${name}? Consumers keep their configuration.`,
          successMessage: "Stream purged",
          destructive: true,
        },
      },
      {
        kind: "action",
        label: "Purge Subject",
        action: {
          type: "prompt-nosql-command",
          command: COMMANDS.purge,
          title: `Purge part of ${name}`,
          description:
            "Removes messages on a subject (or all subjects), optionally keeping the newest few or everything from a sequence on.",
          descriptionVariant: "error",
          danger: true,
          submitLabel: "Purge",
          fields: [
            {
              key: "subject",
              label: "Subject",
              kind: "text",
              required: false,
              placeholder: "orders.cancelled",
              description: "Wildcards allowed; blank for every subject.",
            },
            {
              key: "keep",
              label: "Keep Newest",
              kind: "number",
              required: false,
              minValue: 0,
              stepValue: 1,
              description: "Keep this many of the newest matching messages.",
            },
            {
              key: "seq",
              label: "Up To Sequence",
              kind: "number",
              required: false,
              minValue: 1,
              stepValue: 1,
              description: "Remove messages below this sequence (ignored when Keep Newest is set).",
            },
          ],
        },
      },
    );
  if (f["denyDelete"] !== true)
    out.push({
      kind: "action",
      label: "Delete Message",
      action: {
        type: "prompt-nosql-command",
        command: COMMANDS.deleteMessage,
        title: `Delete a message from ${name}`,
        danger: true,
        submitLabel: "Delete",
        fields: [
          {
            key: "seq",
            label: "Sequence",
            kind: "number",
            required: true,
            minValue: 1,
            stepValue: 1,
            ...(f["lastSeq"] !== undefined ? { placeholder: str(f["lastSeq"]) } : {}),
          },
          {
            key: "erase",
            label: "Overwrite On Disk",
            kind: "select",
            required: false,
            defaultValue: "false",
            options: [
              { id: "false", label: "No: mark deleted" },
              { id: "true", label: "Yes: erase the stored bytes" },
            ],
          },
        ],
      },
    });
  return out;
}

function historyTable(raw: string | undefined): SchemaNode[] {
  const rows = parseJson<
    Array<{
      key: string;
      revision: number;
      operation: string;
      created: string;
      size: number;
      data?: string;
    }>
  >(raw);
  if (!rows) return [];
  if (rows.length === 0) return [{ kind: "text", content: "No revisions yet.", variant: "muted" }];
  return [
    {
      kind: "table",
      columns: [
        { key: "key", label: "Key", mono: true },
        { key: "revision", label: "Revision", width: "narrow" },
        { key: "operation", label: "Operation", width: "narrow" },
        { key: "created", label: "Written" },
        { key: "value", label: "Value", mono: true, width: "wide" },
      ],
      rows: rows.map((e) => ({
        cells: {
          key: e.key,
          revision: String(e.revision),
          operation: e.operation === "PUT" ? "put" : e.operation === "DEL" ? "delete" : "purge",
          created: e.created,
          value:
            e.operation !== "PUT"
              ? ""
              : e.data !== undefined
                ? e.data
                : `${formatBytes(e.size)} (binary)`,
        },
      })),
    },
  ];
}

function objectsTable(raw: string | undefined): SchemaNode[] {
  const rows = parseJson<
    Array<{
      name: string;
      size: number;
      chunks: number;
      mtime: string;
      digest: string;
      description?: string;
    }>
  >(raw);
  if (!rows) return [];
  if (rows.length === 0) return [{ kind: "text", content: "No objects yet.", variant: "muted" }];
  return [
    {
      kind: "table",
      columns: [
        { key: "name", label: "Name", mono: true },
        { key: "size", label: "Size", width: "narrow" },
        { key: "chunks", label: "Chunks", width: "narrow" },
        { key: "mtime", label: "Modified" },
        { key: "digest", label: "Digest", mono: true },
      ],
      rows: rows.map((o) => ({
        cells: {
          name: o.name,
          size: formatBytes(o.size),
          chunks: String(o.chunks),
          mtime: o.mtime,
          digest: o.digest,
        },
      })),
    },
  ];
}

export function renderNatsDetail(
  r: ResourceInstance,
  opts: RenderOptions = { writable: false },
): DetailViewSchema {
  const f = r.fields;
  const { writable } = opts;
  const base = (subtitle: string, extra: Partial<DetailViewSchema> = {}): DetailViewSchema =>
    withMetricsCapability(
      {
        title: r.displayName || "NATS",
        subtitle,
        sections: [section("Details", [fieldsNode(r)])],
        ...extra,
      },
      RESOURCE_TYPES,
      r.resourceTypeId,
    );
  switch (r.resourceTypeId) {
    case "nats-server":
      return base(
        joinSubtitle("nats-server", f["version"] ? `v${str(f["version"])}` : "", f["cluster"]),
        {
          status: {
            kind: "status-dot",
            status:
              f["health"] === "ok"
                ? Number(f["slowConsumers"] ?? 0) > 0
                  ? "degraded"
                  : "healthy"
                : "error",
            label: f["health"] === "ok" ? "Healthy" : str(f["health"]) || "Unhealthy",
          },
          describe: { language: "text" },
          publishPanel: serverPublish(writable),
        },
      );
    case "nats-stream": {
      const plain = str(f["kind"]) === "stream" || !f["kind"];
      return base(
        joinSubtitle(str(f["kind"]) || "stream", `account ${str(f["account"])}`, f["storage"]),
        {
          status: {
            kind: "status-dot",
            status: f["sealed"] === true ? "info" : "healthy",
            label: f["sealed"] === true ? "Sealed" : `${str(f["messages"] || 0)} messages`,
          },
          describe: { language: "text" },
          ...(writable
            ? {
                kvBrowser: {
                  namespaceLabel: `Messages in ${str(f["name"])}`,
                  defaultPageSize: 50,
                  helpText:
                    "Newest first. Filter with a subject (wildcards allowed) or jump to a sequence number. Open a message to read it; delete removes it by sequence. + Add key publishes: the key is the subject and the value the body.",
                },
                manifestEditor: { language: "json" as const, resourceKind: "Configuration" },
                headerActions: [...streamActions(f), refresh],
              }
            : { headerActions: [refresh] }),
          ...(plain ? { publishPanel: streamPublish(f, writable) } : {}),
        },
      );
    }
    case "nats-consumer": {
      const paused = f["paused"] === true;
      return base(joinSubtitle(`${str(f["mode"]) || ""} consumer`.trim(), f["stream"]), {
        status: paused
          ? {
              kind: "status-dot",
              status: "info",
              label: f["pausedUntil"] ? `Paused until ${str(f["pausedUntil"])}` : "Paused",
            }
          : { kind: "status-dot", ...consumerStatus(f) },
        describe: { language: "text" },
        ...(writable
          ? {
              manifestEditor: { language: "json" as const, resourceKind: "Configuration" },
              headerActions: [
                paused
                  ? {
                      kind: "action",
                      label: "Resume",
                      action: {
                        type: "plugin-action",
                        actionId: "resume",
                        successMessage: "Consumer resumed",
                      },
                    }
                  : {
                      kind: "action",
                      label: "Pause",
                      action: {
                        type: "prompt-nosql-command",
                        command: COMMANDS.pause,
                        title: `Pause ${r.displayName}`,
                        description:
                          "Stops deliveries until the time below (nats-server 2.11 or later). Messages keep accumulating as pending.",
                        submitLabel: "Pause",
                        fields: [
                          { key: "until", label: "Resume At", kind: "datetime", required: true },
                        ],
                      },
                    },
                refresh,
              ],
            }
          : {}),
      });
    }
    case "nats-kv-bucket": {
      const history = historyTable(r.resolvedOutputs["history"]);
      return base(joinSubtitle("Key-value bucket", `account ${str(f["account"])}`, f["storage"]), {
        status: { kind: "status-dot", status: "healthy", label: `${str(f["keys"] || 0)} keys` },
        describe: { language: "text" },
        sections: [
          section("Details", [fieldsNode(r)]),
          ...(history.length ? [section("Recent Revisions", history)] : []),
        ],
        ...(writable
          ? {
              kvBrowser: {
                namespaceLabel: str(f["bucket"]) || r.displayName,
                defaultPageSize: 100,
                helpText:
                  "Values are read and written as UTF-8 text. Deleting a key leaves a delete marker in its history; the Describe tab lists every key's revisions.",
              },
            }
          : {}),
        headerActions: [refresh],
      });
    }
    case "nats-object-store": {
      const objects = objectsTable(r.resolvedOutputs["objects"]);
      return base(joinSubtitle("Object store", `account ${str(f["account"])}`, f["storage"]), {
        status: {
          kind: "status-dot",
          status: f["sealed"] === true ? "info" : "healthy",
          label: f["sealed"] === true ? "Sealed" : formatBytes(Number(f["bytes"] ?? 0)),
        },
        describe: { language: "text" },
        sections: [
          section("Details", [fieldsNode(r)]),
          ...(objects.length ? [section("Objects", objects)] : []),
        ],
        ...(writable ? { storageBrowser: { bucketName: str(f["bucket"]) || r.displayName } } : {}),
        headerActions: [refresh],
      });
    }
    case "nats-account":
      return base(joinSubtitle("Account", f["system"] === true ? "system" : ""));
    case "nats-peer":
      return base(camelToTitle(str(f["kind"]) || "peer"));
    case "nats-connection":
      return base(joinSubtitle("Connection", f["account"], f["client"]));
    default:
      return base("NATS");
  }
}

export function renderNatsSidebar(r: ResourceInstance): SidebarItemSchema {
  return {
    id: r.id,
    label: r.displayName || r.externalId || r.id,
    ...(r.resourceTypeId === "nats-consumer"
      ? { status: { kind: "status-dot" as const, status: consumerStatus(r.fields).status } }
      : {}),
  };
}
