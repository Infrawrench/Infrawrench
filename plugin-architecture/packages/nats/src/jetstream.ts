/**
 * JetStream forms and the configuration objects they turn into.
 *
 * Wire shapes are the JetStream API's (`$JS.API.STREAM.CREATE` and friends,
 * as NATS.js v3 sends them): snake_case keys, durations in nanoseconds,
 * `-1` for "no limit". Key-value buckets and object stores are streams named
 * `KV_<bucket>` / `OBJ_<bucket>`; NATS.js builds their stream config from
 * `KvOptions` (ttl in milliseconds) and `ObjectStoreOptions` (ttl in
 * nanoseconds), and an edit is a stream update on the backing stream.
 *
 * Reference: https://docs.nats.io/nats-concepts/jetstream/streams,
 * .../jetstream/consumers, ADR-8 (KV) and ADR-20 (object store), NATS.js
 * 3.4 `jsapi_types.ts` (read 2026-10).
 */
import type { CreateFieldConfig } from "@infrawrench/plugin-base";

export const NAME_RE = /^[^\s.*>/\\]+$/;
export const BUCKET_RE = /^[-\w]+$/;

const NS = 1e9;

const yesNo = [
  { id: "false", label: "No" },
  { id: "true", label: "Yes" },
];

const storageOptions = [
  { id: "file", label: "File" },
  { id: "memory", label: "Memory" },
];

function num(
  key: string,
  label: string,
  description: string,
  extra: Partial<CreateFieldConfig> = {},
): CreateFieldConfig {
  return {
    key,
    label,
    kind: "number",
    required: false,
    description,
    minValue: 0,
    stepValue: 1,
    ...extra,
  };
}

export function streamCreateFields(): CreateFieldConfig[] {
  return [
    {
      key: "name",
      label: "Name",
      kind: "text",
      required: true,
      placeholder: "ORDERS",
      description: "Letters, digits, - and _; no spaces, dots, * or >.",
    },
    {
      key: "subjects",
      label: "Subjects",
      kind: "string-list",
      required: true,
      placeholder: "orders.>",
      description: "Subjects the stream captures; * matches one token, > the rest.",
    },
    { key: "description", label: "Description", kind: "text", required: false },
    {
      key: "retention",
      label: "Retention",
      kind: "select",
      required: true,
      defaultValue: "limits",
      options: [
        { id: "limits", label: "Limits: keep until a limit is hit" },
        { id: "interest", label: "Interest: keep while a consumer still needs it" },
        { id: "workqueue", label: "Work queue: remove once acknowledged" },
      ],
    },
    {
      key: "storage",
      label: "Storage",
      kind: "select",
      required: true,
      defaultValue: "file",
      options: storageOptions,
    },
    {
      key: "replicas",
      label: "Replicas",
      kind: "select",
      required: true,
      defaultValue: "1",
      options: ["1", "2", "3", "4", "5"].map((v) => ({ id: v, label: v })),
      description: "Copies across the JetStream cluster; 3 survives a server loss.",
    },
    {
      key: "discard",
      label: "When Full",
      kind: "select",
      required: true,
      defaultValue: "old",
      options: [
        { id: "old", label: "Discard the oldest messages" },
        { id: "new", label: "Refuse new messages" },
      ],
    },
    num("maxMsgs", "Max Messages", "Leave blank for no limit."),
    num("maxBytes", "Max Bytes", "Leave blank for no limit."),
    num("maxAgeSeconds", "Max Age (seconds)", "Leave blank to keep messages forever."),
    num("maxMsgsPerSubject", "Max Messages Per Subject", "Leave blank for no limit."),
    num("maxMsgSize", "Max Message Size (bytes)", "Leave blank for the server's max payload."),
    num(
      "duplicateWindowSeconds",
      "Duplicate Window (seconds)",
      "Nats-Msg-Id deduplication window. Defaults to 120.",
      {
        placeholder: "120",
      },
    ),
    {
      key: "compression",
      label: "Compression",
      kind: "select",
      required: false,
      defaultValue: "none",
      options: [
        { id: "none", label: "None" },
        { id: "s2", label: "S2" },
      ],
    },
    {
      key: "allowDirect",
      label: "Allow Direct Get",
      kind: "select",
      required: false,
      defaultValue: "true",
      options: yesNo,
      description: "Lets any replica answer message reads.",
    },
    {
      key: "denyDelete",
      label: "Deny Message Delete",
      kind: "select",
      required: false,
      defaultValue: "false",
      options: yesNo,
    },
    {
      key: "denyPurge",
      label: "Deny Purge",
      kind: "select",
      required: false,
      defaultValue: "false",
      options: yesNo,
    },
  ];
}

const has = (f: Record<string, string>, k: string) => k in f;
const text = (f: Record<string, string>, k: string) => (f[k] ?? "").trim();

/** A blank limit is "no limit" (-1). */
function limitValue(f: Record<string, string>, k: string, scale = 1): number {
  const v = text(f, k);
  if (!v) return -1;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new Error(`NATS plugin: ${k} must be a positive number`);
  return Math.round(n * scale);
}

/** A blank duration is "none" (0). */
function durationNs(f: Record<string, string>, k: string): number {
  const v = text(f, k);
  if (!v) return 0;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new Error(`NATS plugin: ${k} must be a positive number`);
  return Math.round(n * NS);
}

export function list(v: string): string[] {
  return v
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Form fields to stream configuration. With `partial`, only the keys present
 * in `f` are emitted (an edit sends only what changed; NATS.js merges the
 * rest from the current config).
 */
export function streamConfigFromFields(
  f: Record<string, string>,
  partial = false,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const want = (k: string) => !partial || has(f, k);
  if (!partial) {
    const name = text(f, "name");
    if (!NAME_RE.test(name))
      throw new Error("NATS plugin: the stream name may not contain spaces, dots, * or >");
    out["name"] = name;
  }
  if (want("subjects")) {
    const subjects = list(f["subjects"] ?? "");
    if (!partial && subjects.length === 0) throw new Error("NATS plugin: add at least one subject");
    out["subjects"] = subjects;
  }
  if (want("description")) out["description"] = text(f, "description");
  if (!partial || has(f, "retention"))
    if (text(f, "retention")) out["retention"] = text(f, "retention");
  if (!partial || has(f, "storage")) if (text(f, "storage")) out["storage"] = text(f, "storage");
  if (want("replicas") && text(f, "replicas")) out["num_replicas"] = Number(text(f, "replicas"));
  if (want("discard") && text(f, "discard")) out["discard"] = text(f, "discard");
  if (want("maxMsgs")) out["max_msgs"] = limitValue(f, "maxMsgs");
  if (want("maxBytes")) out["max_bytes"] = limitValue(f, "maxBytes");
  if (want("maxAgeSeconds")) out["max_age"] = durationNs(f, "maxAgeSeconds");
  if (want("maxMsgsPerSubject")) out["max_msgs_per_subject"] = limitValue(f, "maxMsgsPerSubject");
  if (want("maxMsgSize")) out["max_msg_size"] = limitValue(f, "maxMsgSize");
  if (want("duplicateWindowSeconds") && text(f, "duplicateWindowSeconds"))
    out["duplicate_window"] = durationNs(f, "duplicateWindowSeconds");
  if (want("compression") && text(f, "compression")) out["compression"] = text(f, "compression");
  if (want("allowDirect") && text(f, "allowDirect"))
    out["allow_direct"] = text(f, "allowDirect") === "true";
  if (want("denyDelete") && text(f, "denyDelete"))
    out["deny_delete"] = text(f, "denyDelete") === "true";
  if (want("denyPurge") && text(f, "denyPurge"))
    out["deny_purge"] = text(f, "denyPurge") === "true";
  return out;
}

export function consumerCreateFields(streams: string[] | undefined): CreateFieldConfig[] {
  const fields: CreateFieldConfig[] = [];
  if (streams)
    fields.push({
      key: "stream",
      label: "Stream",
      kind: "select",
      required: true,
      options: streams.map((s) => ({ id: s, label: s })),
      ...(streams[0] ? { defaultValue: streams[0] } : {}),
    });
  fields.push(
    {
      key: "name",
      label: "Durable Name",
      kind: "text",
      required: true,
      placeholder: "billing",
      description: "A durable consumer keeps its position across disconnects.",
    },
    { key: "description", label: "Description", kind: "text", required: false },
    {
      key: "mode",
      label: "Mode",
      kind: "select",
      required: true,
      defaultValue: "pull",
      options: [
        { id: "pull", label: "Pull: clients fetch batches" },
        { id: "push", label: "Push: the server delivers to a subject" },
      ],
    },
    {
      key: "deliverSubject",
      label: "Deliver Subject",
      kind: "text",
      required: true,
      placeholder: "deliver.billing",
      showWhen: { fieldKey: "mode", fieldValue: "push" },
    },
    {
      key: "deliverGroup",
      label: "Deliver Group",
      kind: "text",
      required: false,
      description: "Queue group that shares the push deliveries.",
      showWhen: { fieldKey: "mode", fieldValue: "push" },
    },
    {
      key: "filterSubjects",
      label: "Filter Subjects",
      kind: "string-list",
      required: false,
      placeholder: "orders.created",
      description: "Only these subjects; leave empty for the whole stream.",
    },
    {
      key: "deliverPolicy",
      label: "Start From",
      kind: "select",
      required: true,
      defaultValue: "all",
      options: [
        { id: "all", label: "The first message" },
        { id: "last", label: "The last message" },
        { id: "new", label: "New messages only" },
        { id: "last_per_subject", label: "The last message on each subject" },
        { id: "by_start_sequence", label: "A sequence number" },
        { id: "by_start_time", label: "A point in time" },
      ],
    },
    {
      key: "optStartSeq",
      label: "Start Sequence",
      kind: "number",
      required: true,
      minValue: 1,
      stepValue: 1,
      showWhen: { fieldKey: "deliverPolicy", fieldValue: "by_start_sequence" },
    },
    {
      key: "optStartTime",
      label: "Start Time",
      kind: "datetime",
      required: true,
      showWhen: { fieldKey: "deliverPolicy", fieldValue: "by_start_time" },
    },
    {
      key: "ackPolicy",
      label: "Ack Policy",
      kind: "select",
      required: true,
      defaultValue: "explicit",
      options: [
        { id: "explicit", label: "Explicit: every message" },
        { id: "all", label: "All: an ack covers earlier messages" },
        { id: "none", label: "None" },
      ],
    },
    num(
      "ackWaitSeconds",
      "Ack Wait (seconds)",
      "Time before an unacknowledged message is redelivered. Defaults to 30.",
      {
        placeholder: "30",
      },
    ),
    num("maxDeliver", "Max Deliveries", "Leave blank for unlimited redeliveries.", { minValue: 1 }),
    num(
      "maxAckPending",
      "Max Ack Pending",
      "Outstanding unacknowledged messages. Defaults to 1000.",
      {
        placeholder: "1000",
      },
    ),
    {
      key: "replayPolicy",
      label: "Replay",
      kind: "select",
      required: false,
      defaultValue: "instant",
      options: [
        { id: "instant", label: "As fast as possible" },
        { id: "original", label: "At the original rate" },
      ],
    },
    {
      ...num("maxWaiting", "Max Waiting Pulls", "Concurrent pull requests. Defaults to 512.", {
        placeholder: "512",
      }),
      showWhen: { fieldKey: "mode", fieldValue: "pull" },
    },
  );
  return fields;
}

export function consumerConfigFromFields(
  f: Record<string, string>,
  partial = false,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const want = (k: string) => !partial || has(f, k);
  if (!partial) {
    const name = text(f, "name");
    if (!NAME_RE.test(name))
      throw new Error("NATS plugin: the consumer name may not contain spaces, dots, * or >");
    out["durable_name"] = name;
    out["name"] = name;
    out["deliver_policy"] = text(f, "deliverPolicy") || "all";
    out["ack_policy"] = text(f, "ackPolicy") || "explicit";
    out["replay_policy"] = text(f, "replayPolicy") || "instant";
    if (out["deliver_policy"] === "by_start_sequence")
      out["opt_start_seq"] = Number(text(f, "optStartSeq"));
    if (out["deliver_policy"] === "by_start_time") {
      const t = new Date(text(f, "optStartTime"));
      if (Number.isNaN(t.getTime())) throw new Error("NATS plugin: pick a start time");
      out["opt_start_time"] = t.toISOString();
    }
    if (text(f, "mode") === "push") {
      if (!text(f, "deliverSubject"))
        throw new Error("NATS plugin: a push consumer needs a deliver subject");
      out["deliver_subject"] = text(f, "deliverSubject");
      if (text(f, "deliverGroup")) out["deliver_group"] = text(f, "deliverGroup");
    } else if (text(f, "maxWaiting")) out["max_waiting"] = Number(text(f, "maxWaiting"));
  } else if (has(f, "deliverSubject") && text(f, "deliverSubject")) {
    out["deliver_subject"] = text(f, "deliverSubject");
  }
  if (want("description")) out["description"] = text(f, "description");
  if (want("filterSubjects")) {
    const subjects = list(f["filterSubjects"] ?? "");
    if (subjects.length === 1) {
      out["filter_subject"] = subjects[0];
      if (partial) out["filter_subjects"] = [];
    } else if (subjects.length > 1) {
      out["filter_subjects"] = subjects;
      if (partial) out["filter_subject"] = "";
    } else if (partial) {
      out["filter_subject"] = "";
      out["filter_subjects"] = [];
    }
  }
  if (want("ackWaitSeconds") && text(f, "ackWaitSeconds"))
    out["ack_wait"] = durationNs(f, "ackWaitSeconds");
  if (want("maxDeliver")) out["max_deliver"] = limitValue(f, "maxDeliver");
  if (want("maxAckPending") && text(f, "maxAckPending"))
    out["max_ack_pending"] = Number(text(f, "maxAckPending"));
  return out;
}

function bucketFields(kind: "kv" | "obj"): CreateFieldConfig[] {
  return [
    {
      key: "name",
      label: "Bucket Name",
      kind: "text",
      required: true,
      placeholder: kind === "kv" ? "config" : "assets",
      description: "Letters, digits, - and _.",
    },
    { key: "description", label: "Description", kind: "text", required: false },
    ...(kind === "kv"
      ? [
          {
            key: "history",
            label: "History",
            kind: "number" as const,
            required: false,
            defaultValue: "1",
            minValue: 1,
            maxValue: 64,
            stepValue: 1,
            description: "Revisions kept per key (1 to 64).",
          },
          num(
            "maxValueSize",
            "Max Value Size (bytes)",
            "Leave blank for the server's max payload.",
          ),
        ]
      : []),
    num("ttlSeconds", "Expire After (seconds)", "Leave blank to keep entries forever."),
    num("maxBytes", "Max Bytes", "Leave blank for no limit."),
    {
      key: "storage",
      label: "Storage",
      kind: "select",
      required: true,
      defaultValue: "file",
      options: storageOptions,
    },
    {
      key: "replicas",
      label: "Replicas",
      kind: "select",
      required: true,
      defaultValue: "1",
      options: ["1", "2", "3", "4", "5"].map((v) => ({ id: v, label: v })),
    },
    {
      key: "compression",
      label: "Compression",
      kind: "select",
      required: false,
      defaultValue: "false",
      options: yesNo,
    },
  ];
}

export const kvCreateFields = (): CreateFieldConfig[] => bucketFields("kv");
export const objCreateFields = (): CreateFieldConfig[] => bucketFields("obj");

export function bucketName(f: Record<string, string>): string {
  const name = text(f, "name");
  if (!BUCKET_RE.test(name))
    throw new Error("NATS plugin: bucket names use letters, digits, - and _ only");
  return name;
}

/** NATS.js `KvOptions`: ttl in milliseconds. */
export function kvOptionsFromFields(f: Record<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {
    storage: text(f, "storage") || "file",
    replicas: Number(text(f, "replicas") || 1),
    history: Number(text(f, "history") || 1),
    compression: text(f, "compression") === "true",
  };
  if (text(f, "description")) out["description"] = text(f, "description");
  if (text(f, "ttlSeconds")) out["ttl"] = Math.round(Number(text(f, "ttlSeconds")) * 1000);
  if (text(f, "maxBytes")) out["max_bytes"] = Number(text(f, "maxBytes"));
  if (text(f, "maxValueSize")) out["maxValueSize"] = Number(text(f, "maxValueSize"));
  return out;
}

/** NATS.js `ObjectStoreOptions`: ttl in nanoseconds. */
export function objOptionsFromFields(f: Record<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {
    storage: text(f, "storage") || "file",
    replicas: Number(text(f, "replicas") || 1),
    compression: text(f, "compression") === "true",
  };
  if (text(f, "description")) out["description"] = text(f, "description");
  if (text(f, "ttlSeconds")) out["ttl"] = durationNs(f, "ttlSeconds");
  if (text(f, "maxBytes")) out["max_bytes"] = Number(text(f, "maxBytes"));
  return out;
}

/** A bucket edit, as a partial update of its backing stream. */
export function bucketStreamUpdate(f: Record<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (has(f, "description")) out["description"] = text(f, "description");
  if (has(f, "history")) {
    const h = Number(text(f, "history") || 1);
    if (!Number.isInteger(h) || h < 1 || h > 64) throw new Error("NATS plugin: history is 1 to 64");
    out["max_msgs_per_subject"] = h;
  }
  if (has(f, "ttlSeconds")) out["max_age"] = durationNs(f, "ttlSeconds");
  if (has(f, "maxBytes")) out["max_bytes"] = limitValue(f, "maxBytes");
  if (has(f, "maxValueSize")) out["max_msg_size"] = limitValue(f, "maxValueSize");
  if (has(f, "replicas") && text(f, "replicas")) out["num_replicas"] = Number(text(f, "replicas"));
  return out;
}
