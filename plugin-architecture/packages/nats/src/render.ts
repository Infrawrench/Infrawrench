import type {
  DetailViewSchema,
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

export function renderNatsDetail(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
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
        },
      );
    case "nats-stream":
      return base(
        joinSubtitle(str(f["kind"]) || "stream", `account ${str(f["account"])}`, f["storage"]),
        {
          status: {
            kind: "status-dot",
            status: f["sealed"] === true ? "info" : "healthy",
            label: f["sealed"] === true ? "Sealed" : `${str(f["messages"] || 0)} messages`,
          },
          describe: { language: "text" },
        },
      );
    case "nats-consumer":
      return base(joinSubtitle(`${str(f["mode"]) || ""} consumer`.trim(), f["stream"]), {
        status: { kind: "status-dot", ...consumerStatus(f) },
        describe: { language: "text" },
      });
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
