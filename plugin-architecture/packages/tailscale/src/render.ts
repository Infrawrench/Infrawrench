import {
  labeledFieldItems,
  type DetailViewSchema,
  type ResourceInstance,
  type ResourceStatus,
} from "@infrawrench/plugin-base";
import type { LogStreamConfig, LogStreamStatus, ServiceHost } from "./api.js";
import { resourceTypes } from "./resource-types.js";

type Section = DetailViewSchema["sections"][number];
type HeaderAction = NonNullable<DetailViewSchema["headerActions"]>[number];

const ADMIN_CONSOLE = "https://login.tailscale.com/admin";

const REFRESH: HeaderAction = {
  kind: "action",
  label: "Refresh",
  action: { type: "refresh-resource" },
};

function parse<T>(resource: ResourceInstance, key: string, fallback: T): T {
  const raw = resource.resolvedOutputs[key];
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** Field rows labelled from the type definition, booleans shown as Yes/No. */
function fieldList(resource: ResourceInstance, omit: string[] = []): Section["children"][number] {
  const fields = Object.fromEntries(
    Object.entries(resource.fields)
      .filter(([key]) => !omit.includes(key))
      .map(([key, value]) => [key, typeof value === "boolean" ? (value ? "Yes" : "No") : value]),
  );
  return {
    kind: "key-value-list",
    items: labeledFieldItems(fields, resourceTypes, resource.resourceTypeId),
  };
}

function section(title: string, children: Section["children"]): Section {
  return { kind: "section", title, children };
}

export function sidebarStatus(resource: ResourceInstance): {
  kind: "status-dot";
  status: ResourceStatus;
  label?: string;
} {
  const f = resource.fields;
  const dot = (status: ResourceStatus, label?: string) => ({
    kind: "status-dot" as const,
    status,
    ...(label ? { label } : {}),
  });
  switch (resource.resourceTypeId) {
    case "device": {
      if (f.authorized !== true) return dot("degraded", "Awaiting approval");
      return f.connected === true ? dot("healthy", "Connected") : dot("unknown", "Offline");
    }
    case "user": {
      const status = String(f.status ?? "");
      if (status === "suspended") return dot("degraded", "Suspended");
      if (status === "needs-approval") return dot("provisioning", "Needs approval");
      if (status === "over-billing-limit") return dot("error", "Over billing limit");
      return f.currentlyConnected === true
        ? dot("healthy", "Connected")
        : dot("info", status || "Idle");
    }
    case "key":
      return f.revoked || f.invalid === true
        ? dot("degraded", "Revoked or expired")
        : dot("healthy", "Active");
    case "posture-integration":
      return f.syncError ? dot("error", "Sync failing") : dot("healthy", "Syncing");
    case "user-invite":
      return dot("provisioning", "Pending");
    default:
      return dot("info");
  }
}

export function renderDetail(resource: ResourceInstance): DetailViewSchema {
  const base = {
    title: resource.displayName,
    status: sidebarStatus(resource),
  };
  switch (resource.resourceTypeId) {
    case "tailnet":
      return { ...base, subtitle: "Tailnet", ...renderTailnet(resource) };
    case "device":
      return { ...base, subtitle: String(resource.fields.name), ...renderDevice(resource) };
    case "user":
      return { ...base, subtitle: String(resource.fields.loginName), ...renderUser(resource) };
    case "user-invite":
      return {
        ...base,
        subtitle: `Invite · ${String(resource.fields.role)}`,
        sections: [
          section("Invite", [
            fieldList(resource),
            {
              kind: "text",
              variant: "muted",
              content:
                "The invite link is the sensitive inviteUrl output. Deleting the invite stops the link working.",
            },
          ]),
        ],
        headerActions: [
          REFRESH,
          ...(resource.fields.email
            ? [
                {
                  kind: "action" as const,
                  label: "Resend email",
                  action: {
                    type: "plugin-action" as const,
                    actionId: "resend",
                    successMessage: "Invite email resent.",
                  },
                },
              ]
            : []),
        ],
      };
    case "key":
      return {
        ...base,
        subtitle: `${String(resource.fields.keyType)} key`,
        sections: [
          section("Key", [
            fieldList(resource),
            {
              kind: "text",
              variant: "muted",
              content:
                "Tailscale shows a key's secret only when it is created. Deleting a key revokes it; devices already joined with it stay connected.",
            },
          ]),
        ],
        headerActions: [REFRESH],
      };
    case "webhook":
      return {
        ...base,
        subtitle: "Webhook",
        sections: [
          section("Webhook", [fieldList(resource, ["subscriptions"])]),
          section("Events", [
            {
              kind: "table",
              columns: [{ key: "event", label: "Event", mono: true }],
              rows: String(resource.fields.subscriptions)
                .split(",")
                .map((event) => event.trim())
                .filter(Boolean)
                .map((event) => ({ cells: { event } })),
            },
          ]),
        ],
        headerActions: [
          REFRESH,
          {
            kind: "action",
            label: "Send test event",
            action: {
              type: "plugin-action",
              actionId: "test",
              successMessage: "Test event queued.",
            },
          },
        ],
      };
    case "service":
      return { ...base, subtitle: String(resource.fields.name), ...renderService(resource) };
    case "posture-integration":
      return {
        ...base,
        subtitle: "Device posture integration",
        sections: [
          section("Integration", [
            fieldList(resource),
            ...(resource.fields.syncError
              ? [
                  {
                    kind: "text" as const,
                    content: `Last sync failed: ${String(resource.fields.syncError)}`,
                  },
                ]
              : []),
          ]),
        ],
        headerActions: [REFRESH],
      };
    default:
      return {
        ...base,
        sections: [section("Resource", [fieldList(resource)])],
        headerActions: [REFRESH],
      };
  }
}

type Body = Pick<DetailViewSchema, "sections" | "headerActions"> & Partial<DetailViewSchema>;

function renderTailnet(resource: ResourceInstance): Body {
  const streams = parse<
    Array<{ logType: string; config?: LogStreamConfig; status?: LogStreamStatus }>
  >(resource, "__streams__", []);
  const settingsKeys = [
    "magicDNS",
    "overrideLocalDNS",
    "nameservers",
    "searchPaths",
    "splitDNS",
    "accountContact",
    "securityContact",
    "supportContact",
  ];
  const only = (keys: string[]) =>
    ({
      ...resource,
      fields: Object.fromEntries(Object.entries(resource.fields).filter(([k]) => keys.includes(k))),
    }) as ResourceInstance;
  const sections: Section[] = [
    section("Settings", [fieldList(resource, settingsKeys)]),
    section("DNS", [fieldList(only(settingsKeys.slice(0, 5)))]),
    section("Contacts", [fieldList(only(settingsKeys.slice(5)))]),
  ];
  const configured = streams.filter((s) => s.config?.destinationType);
  sections.push(
    section("Log streaming", [
      configured.length
        ? {
            kind: "table",
            columns: [
              { key: "log", label: "Logs" },
              { key: "destination", label: "Destination" },
              { key: "lastActivity", label: "Last upload" },
              { key: "sent", label: "Entries sent" },
              { key: "failed", label: "Failed requests" },
              { key: "error", label: "Last error" },
            ],
            rows: configured.map((s) => ({
              cells: {
                log: s.logType,
                destination: [s.config?.destinationType, s.config?.url || s.config?.s3Bucket]
                  .filter(Boolean)
                  .join(" · "),
                lastActivity: s.status?.lastActivity ?? "",
                sent: String(s.status?.numEntriesSent ?? ""),
                failed: String(s.status?.numFailedRequests ?? ""),
                error: s.status?.lastError ?? "",
              },
            })),
          }
        : {
            kind: "text",
            variant: "muted",
            content: "No log streams are configured, or this token cannot read them.",
          },
    ]),
  );
  return {
    sections,
    headerActions: [
      REFRESH,
      {
        kind: "action",
        label: "Open admin console",
        action: { type: "open-url", url: `${ADMIN_CONSOLE}/settings/general` },
      },
    ],
    logs: { defaultTailLines: 200 },
  };
}

function renderDevice(resource: ResourceInstance): Body {
  const attributes = parse<Record<string, unknown>>(resource, "__attributes__", {});
  const connectivity = parse<{
    endpoints?: string[];
    latency?: Record<string, { latencyMs?: number; preferred?: boolean }>;
  }>(resource, "__connectivity__", {});
  const sections: Section[] = [
    section("Device", [
      fieldList(resource),
      {
        kind: "text",
        content:
          "Connect using the Tailscale IP from a machine on this tailnet. Infrawrench Cloud needs a network path to the tailnet; adding an API account alone does not provide one.",
      },
    ]),
  ];
  const latency = Object.entries(connectivity.latency ?? {}).sort(
    ([, a], [, b]) => (a.latencyMs ?? Infinity) - (b.latencyMs ?? Infinity),
  );
  if (latency.length) {
    sections.push(
      section("DERP latency", [
        {
          kind: "table",
          columns: [
            { key: "region", label: "Region" },
            { key: "latency", label: "Latency", width: "narrow" },
            { key: "preferred", label: "Preferred", width: "narrow" },
          ],
          rows: latency.map(([region, l]) => ({
            cells: {
              region,
              latency: l.latencyMs === undefined ? "" : `${l.latencyMs.toFixed(1)} ms`,
              preferred: l.preferred ? "Yes" : "",
            },
          })),
        },
        ...(connectivity.endpoints?.length
          ? [
              {
                kind: "text" as const,
                variant: "muted" as const,
                content: `Endpoints: ${connectivity.endpoints.join(", ")}`,
              },
            ]
          : []),
      ]),
    );
  }
  const attributeRows = Object.entries(attributes);
  if (attributeRows.length) {
    sections.push(
      section("Posture attributes", [
        {
          kind: "table",
          columns: [
            { key: "key", label: "Attribute", mono: true },
            { key: "value", label: "Value" },
          ],
          rows: attributeRows.map(([key, value]) => ({
            cells: { key, value: typeof value === "string" ? value : JSON.stringify(value) },
          })),
        },
      ]),
    );
  }
  const authorized = resource.fields.authorized === true;
  return {
    sections,
    headerActions: [
      REFRESH,
      authorized
        ? {
            kind: "action",
            label: "Revoke approval",
            variant: "danger",
            action: {
              type: "plugin-action",
              actionId: "deauthorize",
              confirmMessage:
                "Revoke this device's approval? It is disconnected from the tailnet until approved again.",
              successMessage: "Device approval revoked.",
            },
          }
        : {
            kind: "action",
            label: "Approve device",
            action: {
              type: "plugin-action",
              actionId: "approve",
              confirmMessage: "Approve this device to connect to your tailnet?",
              successMessage: "Device approved.",
            },
          },
      {
        kind: "action",
        label: "Expire device key",
        action: {
          type: "plugin-action",
          actionId: "expire",
          destructive: true,
          confirmMessage: "Expire this device's key? It will need to authenticate again.",
          successMessage: "Device key expired.",
        },
      },
    ],
  };
}

function renderUser(resource: ResourceInstance): Body {
  const status = String(resource.fields.status ?? "");
  const actions: HeaderAction[] = [REFRESH];
  if (status === "needs-approval")
    actions.push({
      kind: "action",
      label: "Approve",
      action: { type: "plugin-action", actionId: "approve", successMessage: "User approved." },
    });
  if (status === "suspended")
    actions.push({
      kind: "action",
      label: "Restore",
      action: { type: "plugin-action", actionId: "restore", successMessage: "User restored." },
    });
  else
    actions.push({
      kind: "action",
      label: "Suspend",
      variant: "danger",
      action: {
        type: "plugin-action",
        actionId: "suspend",
        confirmMessage:
          "Suspend this user? Their devices lose access to the tailnet until they are restored.",
        successMessage: "User suspended.",
      },
    });
  return {
    sections: [
      section("User", [
        fieldList(resource),
        {
          kind: "text",
          variant: "muted",
          content: "Deleting a user also removes every device they own.",
        },
      ]),
    ],
    headerActions: actions,
  };
}

function renderService(resource: ResourceInstance): Body {
  const hosts = parse<Array<ServiceHost & { hostname?: string }>>(resource, "__hosts__", []);
  const hostOption = (h: ServiceHost & { hostname?: string }) => ({
    id: h.stableNodeID,
    label: h.hostname || h.stableNodeID,
  });
  const pending = hosts.filter((h) => h.approvalLevel === "not-approved");
  const approved = hosts.filter((h) => h.approvalLevel && h.approvalLevel !== "not-approved");
  const actions: HeaderAction[] = [REFRESH];
  if (pending.length)
    actions.push({
      kind: "action",
      label: "Approve host…",
      action: {
        type: "prompt-nosql-command",
        command: "approve-host",
        title: "Approve a host for this Service",
        fields: [
          {
            key: "deviceId",
            label: "Device",
            kind: "select",
            required: true,
            options: pending.map(hostOption),
            defaultValue: pending[0]!.stableNodeID,
          },
        ],
        submitLabel: "Approve",
      },
    });
  if (approved.length)
    actions.push({
      kind: "action",
      label: "Withdraw host…",
      variant: "danger",
      action: {
        type: "prompt-nosql-command",
        command: "revoke-host",
        title: "Withdraw a host's approval",
        description: "The device stops receiving this Service's traffic.",
        fields: [
          {
            key: "deviceId",
            label: "Device",
            kind: "select",
            required: true,
            options: approved.map(hostOption),
            defaultValue: approved[0]!.stableNodeID,
          },
        ],
        submitLabel: "Withdraw",
        danger: true,
      },
    });
  return {
    sections: [
      section("Service", [fieldList(resource)]),
      section("Hosts", [
        hosts.length
          ? {
              kind: "table",
              columns: [
                { key: "device", label: "Device" },
                { key: "approval", label: "Approval" },
                { key: "configured", label: "Configured" },
              ],
              rows: hosts.map((h) => ({
                cells: {
                  device: h.hostname || h.stableNodeID,
                  approval: h.approvalLevel ?? "",
                  configured: h.configured ?? "",
                },
              })),
            }
          : {
              kind: "text",
              variant: "muted",
              content:
                "No device advertises this Service yet. Run `tailscale serve --service=<name>` on a tagged host to add one.",
            },
      ]),
    ],
    headerActions: actions,
  };
}
