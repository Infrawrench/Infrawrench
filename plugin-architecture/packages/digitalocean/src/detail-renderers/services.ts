/**
 * Detail views for DigitalOcean's networking and platform services: load
 * balancers, Cloud Firewalls, CDN endpoints, Uptime checks, NAT gateways,
 * App Platform apps and Droplet autoscale pools. Pure over the resource; the
 * picker catalogs and side tables come from `enrichDoServiceDetail`.
 */
import type {
  ActionNode,
  CreateFieldConfig,
  DetailViewSchema,
  ResourceInstance,
  SchemaNode,
  SectionNode,
} from "@infrawrench/plugin-base";
import { CDN_TTL_OPTIONS, UPTIME_REGIONS } from "../create-handlers/services.js";
import { describeFirewallRule, describeForwardingRule } from "../service-listers.js";
import { parseJsonArray, safeParseJson } from "./shared.js";

type Option = { id: string; label: string };
type Json = Record<string, unknown>;

function action(label: string, act: ActionNode["action"], variant?: ActionNode["variant"]) {
  return { kind: "action" as const, label, ...(variant ? { variant } : {}), action: act };
}

function section(title: string, children: SchemaNode[]): SectionNode {
  return { kind: "section", title, children };
}

function muted(content: string): SchemaNode {
  return { kind: "text", variant: "muted", content };
}

/** A prompt that degrades to an explanatory, blocked modal when `options` is empty. */
function pickerPrompt(
  command: string,
  title: string,
  field: Omit<CreateFieldConfig, "options" | "policies"> & { kind: "select" | "policy-picker" },
  options: Option[],
  opts: { description?: string; empty: string; submitLabel: string; danger?: boolean },
): ActionNode["action"] {
  if (options.length === 0) {
    return {
      type: "prompt-nosql-command",
      command,
      title,
      description: opts.empty,
      descriptionVariant: "error",
      blocked: true,
      fields: [],
    };
  }
  const pickerField: CreateFieldConfig =
    field.kind === "policy-picker"
      ? { ...field, policies: options.map((o) => ({ ...o, category: field.label })) }
      : { ...field, options, defaultValue: options[0]!.id };
  return {
    type: "prompt-nosql-command",
    command,
    title,
    ...(opts.description ? { description: opts.description } : {}),
    fields: [pickerField],
    submitLabel: opts.submitLabel,
    ...(opts.danger ? { danger: true } : {}),
  };
}

const ENTRY_PROTOCOLS: Option[] = ["http", "https", "http2", "http3", "tcp", "udp"].map((p) => ({
  id: p,
  label: p.toUpperCase(),
}));
const TARGET_PROTOCOLS: Option[] = ["http", "https", "http2", "tcp", "udp"].map((p) => ({
  id: p,
  label: p.toUpperCase(),
}));

export function applyLoadBalancerDetail(detail: DetailViewSchema, resource: ResourceInstance) {
  const fields = resource.fields;
  const out = resource.resolvedOutputs;
  const rules = parseJsonArray<Json>(out["__rules__"]);
  const health = (safeParseJson(out["__healthCheck__"] ?? "{}") ?? {}) as Json;
  const droplets = parseJsonArray<Option>(out["__droplets__"]);
  const certs = parseJsonArray<Option>(out["__certificates__"]);
  const current = String(fields["dropletIds"] ?? "")
    .split(",")
    .filter(Boolean);
  const byTag = !!fields["dropletTag"];
  const attached = droplets.filter((d) => current.includes(d.id));
  const available = droplets.filter((d) => !current.includes(d.id));
  const isGlobal = fields["lbType"] === "GLOBAL";

  detail.sections.push(
    section("Endpoint", [
      {
        kind: "key-value-list",
        items: [
          { key: "IPv4", value: String(out["ip"] ?? "") || "Not assigned yet", copyable: true },
          ...(out["ipv6"] ? [{ key: "IPv6", value: String(out["ipv6"]), copyable: true }] : []),
          {
            key: "Targets",
            value: byTag
              ? `Droplets tagged "${String(fields["dropletTag"])}"`
              : `${current.length} Droplet${current.length === 1 ? "" : "s"}`,
          },
        ],
      },
    ]),
    section("Forwarding Rules", [
      rules.length > 0
        ? {
            kind: "table",
            columns: [
              { key: "rule", label: "Rule" },
              { key: "remove", label: "", width: "narrow" },
            ],
            rows: rules.map((r) => ({
              cells: {
                rule: describeForwardingRule(r),
                remove: action(
                  "Remove",
                  {
                    type: "prompt-nosql-command",
                    command: "lb-remove-rule",
                    title: "Remove forwarding rule",
                    description: `Stop forwarding ${describeForwardingRule(r)}?`,
                    danger: true,
                    submitLabel: "Remove",
                    fields: [
                      {
                        key: "rule",
                        label: "Rule",
                        kind: "text",
                        required: true,
                        hidden: true,
                        defaultValue: JSON.stringify(r),
                      },
                    ],
                  },
                  "ghost",
                ),
              },
            })),
          }
        : muted("No forwarding rules."),
    ]),
    section("Health Check", [
      {
        kind: "key-value-list",
        items: [
          {
            key: "Probe",
            value: `${String(health["protocol"] ?? "http")}:${String(health["port"] ?? 80)}${health["protocol"] === "tcp" ? "" : String(health["path"] ?? "/")}`,
          },
          { key: "Interval", value: `${String(health["check_interval_seconds"] ?? 10)} s` },
          { key: "Timeout", value: `${String(health["response_timeout_seconds"] ?? 5)} s` },
          {
            key: "Thresholds",
            value: `${String(health["unhealthy_threshold"] ?? 5)} fails to remove, ${String(health["healthy_threshold"] ?? 3)} passes to restore`,
          },
        ],
      },
    ]),
  );
  if (!byTag && !isGlobal) {
    detail.sections.push(
      section("Target Droplets", [
        attached.length > 0 || current.length > 0
          ? {
              kind: "table",
              columns: [{ key: "droplet", label: "Droplet" }],
              rows: current.map((id) => ({
                cells: { droplet: attached.find((d) => d.id === id)?.label ?? `Droplet ${id}` },
              })),
            }
          : muted("No Droplets behind this load balancer. It is still billed per node."),
      ]),
    );
  }

  const headerActions = detail.headerActions ?? [];
  headerActions.push(
    action(
      "+ Add rule",
      {
        type: "prompt-nosql-command",
        command: "lb-add-rule",
        title: "Add forwarding rule",
        submitLabel: "Add",
        fields: [
          {
            key: "entryProtocol",
            label: "Entry Protocol",
            kind: "select",
            required: true,
            options: ENTRY_PROTOCOLS,
            defaultValue: "https",
          },
          {
            key: "entryPort",
            label: "Entry Port",
            kind: "number",
            required: true,
            defaultValue: "443",
            minValue: 1,
            maxValue: 65535,
          },
          {
            key: "targetProtocol",
            label: "Target Protocol",
            kind: "select",
            required: true,
            options: TARGET_PROTOCOLS,
            defaultValue: "http",
          },
          {
            key: "targetPort",
            label: "Target Port",
            kind: "number",
            required: true,
            defaultValue: "80",
            minValue: 1,
            maxValue: 65535,
          },
          {
            key: "tlsPassthrough",
            label: "TLS Passthrough",
            kind: "select",
            required: false,
            defaultValue: "false",
            options: [
              { id: "false", label: "No, terminate TLS here" },
              { id: "true", label: "Yes, pass encrypted traffic to the Droplets" },
            ],
            showWhen: { fieldKey: "entryProtocol", fieldValues: ["https", "http2", "http3"] },
          },
          {
            key: "certificateId",
            label: "Certificate",
            kind: "select",
            required: false,
            options: certs,
            ...(certs[0] ? { defaultValue: certs[0].id } : {}),
            showWhen: {
              allOf: [
                { fieldKey: "entryProtocol", fieldValues: ["https", "http2", "http3"] },
                { fieldKey: "tlsPassthrough", fieldValue: "false" },
              ],
            },
          },
        ],
      },
      "ghost",
    ),
    action(
      "Health check…",
      {
        type: "prompt-nosql-command",
        command: "lb-health-check",
        title: "Edit health check",
        submitLabel: "Save",
        fields: [
          {
            key: "protocol",
            label: "Protocol",
            kind: "select",
            required: true,
            defaultValue: String(health["protocol"] ?? "http"),
            options: [
              { id: "http", label: "HTTP" },
              { id: "https", label: "HTTPS" },
              { id: "tcp", label: "TCP" },
            ],
          },
          {
            key: "port",
            label: "Port",
            kind: "number",
            required: true,
            defaultValue: String(health["port"] ?? 80),
            minValue: 1,
            maxValue: 65535,
          },
          {
            key: "path",
            label: "Path",
            kind: "text",
            required: false,
            defaultValue: String(health["path"] ?? "/"),
            showWhen: { fieldKey: "protocol", fieldValues: ["http", "https"] },
          },
          {
            key: "checkIntervalSeconds",
            label: "Interval (s)",
            kind: "number",
            required: true,
            defaultValue: String(health["check_interval_seconds"] ?? 10),
            minValue: 3,
            maxValue: 300,
          },
          {
            key: "responseTimeoutSeconds",
            label: "Timeout (s)",
            kind: "number",
            required: true,
            defaultValue: String(health["response_timeout_seconds"] ?? 5),
            minValue: 3,
            maxValue: 300,
          },
          {
            key: "unhealthyThreshold",
            label: "Unhealthy Threshold",
            kind: "number",
            required: true,
            defaultValue: String(health["unhealthy_threshold"] ?? 5),
            minValue: 2,
            maxValue: 10,
          },
          {
            key: "healthyThreshold",
            label: "Healthy Threshold",
            kind: "number",
            required: true,
            defaultValue: String(health["healthy_threshold"] ?? 3),
            minValue: 2,
            maxValue: 10,
          },
        ],
      },
      "ghost",
    ),
  );
  if (!byTag && !isGlobal) {
    headerActions.push(
      action(
        "+ Add Droplets",
        pickerPrompt(
          "lb-add-droplets",
          "Add Droplets",
          { key: "dropletIds", label: "Droplets", kind: "policy-picker", required: true },
          available,
          {
            description: "Only Droplets in the load balancer's region are listed.",
            empty: "Every Droplet in this region is already behind the load balancer.",
            submitLabel: "Add",
          },
        ),
        "ghost",
      ),
    );
    if (current.length > 0) {
      headerActions.push(
        action(
          "Remove Droplets…",
          pickerPrompt(
            "lb-remove-droplets",
            "Remove Droplets",
            { key: "dropletIds", label: "Droplets", kind: "policy-picker", required: true },
            current.map(
              (id) => attached.find((d) => d.id === id) ?? { id, label: `Droplet ${id}` },
            ),
            {
              description: "Traffic stops reaching these Droplets; the Droplets keep running.",
              empty: "",
              submitLabel: "Remove",
              danger: true,
            },
          ),
          "ghost",
        ),
      );
    }
  }
  detail.headerActions = headerActions;
}

export function applyFirewallDetail(detail: DetailViewSchema, resource: ResourceInstance) {
  const fields = resource.fields;
  const out = resource.resolvedOutputs;
  const inbound = parseJsonArray<Json>(out["__inbound__"]);
  const outbound = parseJsonArray<Json>(out["__outbound__"]);
  const pending = parseJsonArray<Json>(out["__pending__"]);
  const droplets = parseJsonArray<Option>(out["__droplets__"]);
  const allTags = parseJsonArray<string>(out["__tags__"]);
  const current = String(fields["dropletIds"] ?? "")
    .split(",")
    .filter(Boolean);
  const currentTags = String(fields["tags"] ?? "")
    .split(",")
    .filter(Boolean);

  const ruleRows = (rules: Json[], direction: "inbound" | "outbound") =>
    rules.map((r) => ({
      cells: {
        rule: describeFirewallRule(r, direction),
        remove: action(
          "Remove",
          {
            type: "prompt-nosql-command",
            command: "fw-remove-rule",
            title: "Remove rule",
            description: `Remove "${describeFirewallRule(r, direction)}"?`,
            danger: true,
            submitLabel: "Remove",
            fields: [
              {
                key: "rule",
                label: "Rule",
                kind: "text",
                required: true,
                hidden: true,
                defaultValue: `${direction}:${JSON.stringify(r)}`,
              },
            ],
          },
          "ghost",
        ),
      },
    }));
  const ruleTable = (rules: Json[], direction: "inbound" | "outbound"): SchemaNode =>
    rules.length > 0
      ? {
          kind: "table",
          columns: [
            { key: "rule", label: "Rule" },
            { key: "remove", label: "", width: "narrow" },
          ],
          rows: ruleRows(rules, direction),
        }
      : muted(
          direction === "inbound"
            ? "No inbound rules: all inbound traffic is dropped."
            : "No outbound rules: all outbound traffic is dropped.",
        );

  detail.sections.push(
    section("Inbound Rules", [ruleTable(inbound, "inbound")]),
    section("Outbound Rules", [ruleTable(outbound, "outbound")]),
    section("Applies To", [
      {
        kind: "key-value-list",
        items: [
          {
            key: "Droplets",
            value:
              current
                .map((id) => droplets.find((d) => d.id === id)?.label ?? `Droplet ${id}`)
                .join(", ") || "None",
          },
          { key: "Tags", value: currentTags.join(", ") || "None" },
        ],
      },
      ...(pending.length > 0
        ? [muted(`Applying changes to ${pending.length} Droplet(s); refresh in a moment.`)]
        : []),
    ]),
  );

  const headerActions = detail.headerActions ?? [];
  headerActions.push(
    action(
      "+ Add rule",
      {
        type: "prompt-nosql-command",
        command: "fw-add-rule",
        title: "Add firewall rule",
        submitLabel: "Add",
        fields: [
          {
            key: "direction",
            label: "Direction",
            kind: "select",
            required: true,
            defaultValue: "inbound",
            options: [
              { id: "inbound", label: "Inbound" },
              { id: "outbound", label: "Outbound" },
            ],
          },
          {
            key: "action",
            label: "Action",
            kind: "select",
            required: true,
            defaultValue: "allow",
            options: [
              { id: "allow", label: "Allow" },
              { id: "deny", label: "Deny" },
            ],
          },
          {
            key: "protocol",
            label: "Protocol",
            kind: "select",
            required: true,
            defaultValue: "tcp",
            options: [
              { id: "tcp", label: "TCP" },
              { id: "udp", label: "UDP" },
              { id: "icmp", label: "ICMP" },
            ],
          },
          {
            key: "ports",
            label: "Ports",
            kind: "text",
            required: false,
            placeholder: "443, 8000-9000, or blank for all",
            showWhen: { fieldKey: "protocol", fieldValuesNot: ["icmp"] },
          },
          {
            key: "addresses",
            label: "Addresses",
            kind: "string-list",
            required: false,
            defaultValue: "0.0.0.0/0,::/0",
            description: "IPv4/IPv6 addresses or CIDRs the rule matches.",
          },
        ],
      },
      "ghost",
    ),
    action(
      "+ Apply to Droplets",
      pickerPrompt(
        "fw-add-droplets",
        "Apply to Droplets",
        { key: "dropletIds", label: "Droplets", kind: "policy-picker", required: true },
        droplets.filter((d) => !current.includes(d.id)),
        { empty: "Every Droplet is already protected by this firewall.", submitLabel: "Apply" },
      ),
      "ghost",
    ),
    action(
      "+ Apply to tags",
      pickerPrompt(
        "fw-add-tags",
        "Apply to tags",
        { key: "tags", label: "Tags", kind: "policy-picker", required: true },
        allTags.filter((t) => !currentTags.includes(t)).map((t) => ({ id: t, label: t })),
        {
          description: "Every Droplet with one of these tags is protected, now and later.",
          empty: "No other tags exist on this account.",
          submitLabel: "Apply",
        },
      ),
      "ghost",
    ),
  );
  if (current.length > 0) {
    headerActions.push(
      action(
        "Remove Droplets…",
        pickerPrompt(
          "fw-remove-droplets",
          "Remove Droplets",
          { key: "dropletIds", label: "Droplets", kind: "policy-picker", required: true },
          current.map((id) => droplets.find((d) => d.id === id) ?? { id, label: `Droplet ${id}` }),
          { empty: "", submitLabel: "Remove", danger: true },
        ),
        "ghost",
      ),
    );
  }
  if (currentTags.length > 0) {
    headerActions.push(
      action(
        "Remove tags…",
        pickerPrompt(
          "fw-remove-tags",
          "Remove tags",
          { key: "tags", label: "Tags", kind: "policy-picker", required: true },
          currentTags.map((t) => ({ id: t, label: t })),
          { empty: "", submitLabel: "Remove", danger: true },
        ),
        "ghost",
      ),
    );
  }
  detail.headerActions = headerActions;
}

export function applyCdnEndpointDetail(detail: DetailViewSchema, resource: ResourceInstance) {
  const fields = resource.fields;
  const certs = parseJsonArray<Option>(resource.resolvedOutputs["__certificates__"]);
  const ttl = String(fields["ttl"] ?? "3600");
  detail.sections.push(
    section("Endpoint", [
      {
        kind: "key-value-list",
        items: [
          { key: "CDN Hostname", value: String(fields["endpoint"] ?? ""), copyable: true },
          { key: "Origin", value: String(fields["origin"] ?? ""), copyable: true },
          {
            key: "Cache TTL",
            value: CDN_TTL_OPTIONS.find((o) => o.id === ttl)?.label ?? `${ttl} s`,
          },
          { key: "Custom Domain", value: String(fields["customDomain"] ?? "") || "None" },
        ],
      },
      ...(fields["customDomain"]
        ? [
            muted(
              `Point a CNAME for ${String(fields["customDomain"])} at ${String(fields["endpoint"] ?? "the CDN hostname")}.`,
            ),
          ]
        : []),
    ]),
  );
  const headerActions = detail.headerActions ?? [];
  headerActions.push(
    action(
      "Purge cache…",
      {
        type: "prompt-nosql-command",
        command: "cdn-purge",
        title: "Purge CDN cache",
        description:
          "Edge servers fetch these paths from the origin again on the next request. Use * for everything, or a folder like images/*.",
        submitLabel: "Purge",
        fields: [
          {
            key: "files",
            label: "Paths",
            kind: "string-list",
            required: true,
            defaultValue: "*",
          },
        ],
      },
      "ghost",
    ),
    action(
      "Custom domain…",
      {
        type: "prompt-nosql-command",
        command: "cdn-custom-domain",
        title: "Custom domain",
        description: "Leave the domain empty to remove it.",
        submitLabel: "Save",
        fields: [
          {
            key: "customDomain",
            label: "Domain",
            kind: "text",
            required: false,
            defaultValue: String(fields["customDomain"] ?? ""),
            placeholder: "assets.example.com",
          },
          {
            key: "certificateId",
            label: "Certificate",
            kind: "select",
            required: false,
            options: certs,
            ...(fields["certificateId"] || certs[0]
              ? { defaultValue: String(fields["certificateId"] || certs[0]!.id) }
              : {}),
          },
        ],
      },
      "ghost",
    ),
  );
  detail.headerActions = headerActions;
}

const ALERT_TYPES: Option[] = [
  { id: "down", label: "Down from any region" },
  { id: "down_global", label: "Down from every region" },
  { id: "latency", label: "Latency above a threshold" },
  { id: "ssl_expiry", label: "Certificate expiring soon" },
];

export function applyUptimeCheckDetail(detail: DetailViewSchema, resource: ResourceInstance) {
  const fields = resource.fields;
  const state = (safeParseJson(resource.resolvedOutputs["__state__"] ?? "{}") ?? {}) as Json;
  const alerts = parseJsonArray<Json>(resource.resolvedOutputs["__alerts__"]);
  const regions = (state["regions"] ?? {}) as Record<string, Json>;
  const outage = (state["previous_outage"] ?? {}) as Json;
  const regionLabel = (id: string) => UPTIME_REGIONS.find((r) => r.id === id)?.label ?? id;

  const regionRows = Object.entries(regions).map(([region, s]) => ({
    cells: {
      region: regionLabel(region),
      status: String(s["status"] ?? ""),
      since: String(s["status_changed_at"] ?? ""),
      uptime:
        s["thirty_day_uptime_percentage"] != null
          ? `${Number(s["thirty_day_uptime_percentage"]).toFixed(3)}%`
          : "",
    },
  }));
  detail.sections.push(
    section("Status", [
      regionRows.length > 0
        ? {
            kind: "table",
            columns: [
              { key: "region", label: "Region" },
              { key: "status", label: "Status" },
              { key: "since", label: "Since" },
              { key: "uptime", label: "30-day uptime" },
            ],
            rows: regionRows,
          }
        : muted("No results yet. The first probes run within a few minutes of creation."),
      ...(outage["started_at"]
        ? [
            muted(
              `Last outage: ${regionLabel(String(outage["region"] ?? ""))}, ${String(outage["started_at"])} to ${String(outage["ended_at"] ?? "ongoing")} (${String(outage["duration_seconds"] ?? "?")} s).`,
            ),
          ]
        : []),
    ]),
    section("Alerts", [
      alerts.length > 0
        ? {
            kind: "table",
            columns: [
              { key: "name", label: "Name" },
              { key: "type", label: "Type" },
              { key: "notify", label: "Notifies" },
              { key: "remove", label: "", width: "narrow" },
            ],
            rows: alerts.map((a) => {
              const n = (a["notifications"] ?? {}) as Json;
              const emails = Array.isArray(n["email"]) ? (n["email"] as string[]) : [];
              const slack = Array.isArray(n["slack"]) ? (n["slack"] as Json[]) : [];
              return {
                cells: {
                  name: String(a["name"] ?? ""),
                  type:
                    ALERT_TYPES.find((t) => t.id === a["type"])?.label ?? String(a["type"] ?? ""),
                  notify: [
                    ...emails,
                    ...slack.map((s) => `Slack ${String(s["channel"] ?? "")}`),
                  ].join(", "),
                  remove: action(
                    "Delete",
                    {
                      type: "prompt-nosql-command",
                      command: "uptime-delete-alert",
                      title: "Delete alert",
                      description: `Delete the "${String(a["name"] ?? "")}" alert?`,
                      danger: true,
                      submitLabel: "Delete",
                      fields: [
                        {
                          key: "alertId",
                          label: "Alert",
                          kind: "text",
                          required: true,
                          hidden: true,
                          defaultValue: String(a["id"] ?? ""),
                        },
                      ],
                    },
                    "ghost",
                  ),
                },
              };
            }),
          }
        : muted("No alerts. Add one to get emailed or pinged on Slack when the check fails."),
    ]),
  );

  const enabled = fields["enabled"] !== false && String(fields["enabled"]) !== "false";
  const headerActions = detail.headerActions ?? [];
  headerActions.push(
    action(
      "+ Add alert",
      {
        type: "prompt-nosql-command",
        command: "uptime-add-alert",
        title: "Add alert",
        submitLabel: "Add",
        fields: [
          { key: "name", label: "Name", kind: "text", required: true },
          {
            key: "type",
            label: "Trigger",
            kind: "select",
            required: true,
            defaultValue: "down",
            options: ALERT_TYPES,
          },
          {
            key: "threshold",
            label: "Threshold",
            kind: "number",
            required: false,
            showWhen: { fieldKey: "type", fieldValues: ["latency", "ssl_expiry"] },
            description:
              "Milliseconds for latency (default 1000), days before expiry for certificates (default 30).",
          },
          {
            key: "period",
            label: "For At Least",
            kind: "select",
            required: true,
            defaultValue: "2m",
            options: ["2m", "3m", "5m", "10m", "15m", "30m", "1h"].map((p) => ({
              id: p,
              label: p,
            })),
          },
          {
            key: "emails",
            label: "Email",
            kind: "string-list",
            required: false,
            description: "Must be verified on the DigitalOcean account.",
          },
          {
            key: "slackUrl",
            label: "Slack Webhook URL",
            kind: "text",
            required: false,
            placeholder: "https://hooks.slack.com/services/…",
          },
          {
            key: "slackChannel",
            label: "Slack Channel",
            kind: "text",
            required: false,
            placeholder: "#alerts",
          },
        ],
      },
      "ghost",
    ),
    action(enabled ? "Pause" : "Resume", {
      type: "plugin-action",
      actionId: enabled ? "uptime-disable" : "uptime-enable",
      successMessage: enabled ? "Check paused." : "Check resumed.",
    }),
  );
  detail.headerActions = headerActions;
}

export function applyVpcNatGatewayDetail(detail: DetailViewSchema, resource: ResourceInstance) {
  const vpcs = parseJsonArray<Json>(resource.resolvedOutputs["__vpcs__"]);
  detail.sections.push(
    section("Attached VPCs", [
      vpcs.length > 0
        ? {
            kind: "table",
            columns: [
              { key: "vpc", label: "VPC" },
              { key: "gateway", label: "Gateway IP" },
            ],
            rows: vpcs.map((v) => ({
              cells: { vpc: String(v["vpc_uuid"] ?? ""), gateway: String(v["gateway_ip"] ?? "") },
            })),
          }
        : muted("No VPC attached."),
      muted(
        "Droplets route through the gateway IP above. Droplets without a public interface reach the internet only this way.",
      ),
    ]),
  );
}

function deploymentLabel(d: Json): string {
  const when = String(d["createdAt"] ?? "")
    .replace("T", " ")
    .slice(0, 16);
  return `${when} · ${String(d["phase"] ?? "")}${d["cause"] ? ` · ${String(d["cause"])}` : ""}`;
}

export function applyAppDetail(detail: DetailViewSchema, resource: ResourceInstance) {
  const fields = resource.fields;
  const out = resource.resolvedOutputs;
  const deployments = parseJsonArray<Json>(out["__deployments__"]);
  const domains = parseJsonArray<Json>(out["__domains__"]);
  const pinned = String(out["__pinned__"] ?? "");
  const inProgress = String(out["__inProgressDeploymentId__"] ?? "");
  const components = String(fields["components"] ?? "")
    .split(",")
    .filter(Boolean);

  detail.logs = { defaultTailLines: 200 };
  detail.manifestEditor = { language: "json", resourceKind: "App Spec" };

  detail.sections.push(
    section("App", [
      {
        kind: "key-value-list",
        items: [
          ...(fields["liveUrl"]
            ? [{ key: "Live URL", value: String(fields["liveUrl"]), copyable: true }]
            : []),
          ...(out["defaultIngress"]
            ? [{ key: "Default Ingress", value: String(out["defaultIngress"]), copyable: true }]
            : []),
          ...domains.map((d) => ({
            key: "Domain",
            value: `${String(d["domain"] ?? "")} (${String(d["phase"] ?? "")})`,
          })),
        ],
      },
      ...(pinned
        ? [
            muted(
              "The app is pinned to a rollback: new deployments, including Auto Deploy on push, are paused until you commit or revert it.",
            ),
          ]
        : []),
    ]),
    section("Deployments", [
      deployments.length > 0
        ? {
            kind: "table",
            columns: [
              { key: "created", label: "Created" },
              { key: "phase", label: "Phase" },
              { key: "cause", label: "Cause" },
            ],
            rows: deployments.map((d) => ({
              cells: {
                created: String(d["createdAt"] ?? ""),
                phase: String(d["phase"] ?? ""),
                cause: String(d["cause"] ?? ""),
              },
            })),
          }
        : muted("No deployments yet."),
    ]),
  );

  const rollbackTargets = deployments
    .filter((d) => d["phase"] === "SUPERSEDED" || d["phase"] === "ACTIVE")
    .filter((d) => String(d["id"]) !== String(fields["activeDeploymentId"] ?? ""))
    .map((d) => ({ id: String(d["id"] ?? ""), label: deploymentLabel(d) }));

  const headerActions = detail.headerActions ?? [];
  headerActions.push(
    action("Deploy", {
      type: "plugin-action",
      actionId: "app-deploy",
      successMessage: "Deployment started.",
    }),
    action(
      "Force rebuild",
      {
        type: "plugin-action",
        actionId: "app-force-rebuild",
        confirmMessage: "Rebuild every component from source, ignoring cached builds?",
        successMessage: "Rebuild started.",
      },
      "ghost",
    ),
    action(
      "Restart…",
      components.length > 0
        ? {
            type: "prompt-nosql-command",
            command: "app-restart-components",
            title: "Restart app",
            description:
              "Restarts running instances without a new build. Leave empty to restart every component.",
            submitLabel: "Restart",
            fields: [
              {
                key: "components",
                label: "Components",
                kind: "policy-picker",
                required: false,
                policies: components.map((c) => ({ id: c, label: c, category: "Components" })),
              },
            ],
          }
        : {
            type: "plugin-action",
            actionId: "app-restart",
            confirmMessage: "Restart every component of this app?",
            successMessage: "Restart started.",
          },
      "ghost",
    ),
    action(
      "Roll back…",
      pickerPrompt(
        "app-rollback",
        "Roll back",
        { key: "deploymentId", label: "Deployment", kind: "select", required: true },
        rollbackTargets,
        {
          description:
            "Redeploys a previous build. DigitalOcean doesn't roll back databases or anything outside the app.",
          empty: "There is no earlier successful deployment to roll back to.",
          submitLabel: "Roll back",
        },
      ),
      "ghost",
    ),
  );
  if (inProgress) {
    headerActions.push(
      action(
        "Cancel deployment",
        {
          type: "plugin-action",
          actionId: "app-cancel-deployment",
          confirmMessage: "Cancel the deployment in progress?",
          successMessage: "Deployment cancelled.",
        },
        "danger",
      ),
    );
  }
  if (pinned) {
    headerActions.push(
      action("Commit rollback", {
        type: "plugin-action",
        actionId: "app-commit-rollback",
        successMessage: "Rollback committed; deployments resume.",
      }),
      action(
        "Revert rollback",
        {
          type: "plugin-action",
          actionId: "app-revert-rollback",
          confirmMessage: "Return to the deployment that was live before the rollback?",
          successMessage: "Rollback reverted.",
        },
        "ghost",
      ),
    );
  }
  detail.headerActions = headerActions;
}

export function applyAutoscalePoolDetail(detail: DetailViewSchema, resource: ResourceInstance) {
  const out = resource.resolvedOutputs;
  const members = parseJsonArray<Json>(out["__members__"]);
  const history = parseJsonArray<Json>(out["__history__"]);
  const util = (safeParseJson(out["__utilization__"] ?? "{}") ?? {}) as Json;
  const pct = (v: unknown) => (v == null ? "" : `${(Number(v) * 100).toFixed(1)}%`);

  detail.sections.push(
    section("Current Utilization", [
      {
        kind: "key-value-list",
        items: [
          { key: "CPU", value: pct(util["cpu"]) || "n/a" },
          { key: "Memory", value: pct(util["memory"]) || "n/a" },
        ],
      },
    ]),
    section("Members", [
      members.length > 0
        ? {
            kind: "table",
            columns: [
              { key: "droplet", label: "Droplet" },
              { key: "status", label: "Status" },
              { key: "health", label: "Health" },
              { key: "cpu", label: "CPU" },
              { key: "memory", label: "Memory" },
            ],
            rows: members.map((m) => {
              const u = (m["current_utilization"] ?? {}) as Json;
              return {
                cells: {
                  droplet: String(m["droplet_id"] ?? ""),
                  status: String(m["status"] ?? ""),
                  health: m["unhealthy_reason"]
                    ? `${String(m["health_status"] ?? "")}: ${String(m["unhealthy_reason"])}`
                    : String(m["health_status"] ?? ""),
                  cpu: pct(u["cpu"]),
                  memory: pct(u["memory"]),
                },
              };
            }),
          }
        : muted("No Droplets in the pool right now."),
    ]),
    section("Scaling History", [
      history.length > 0
        ? {
            kind: "table",
            columns: [
              { key: "when", label: "When" },
              { key: "reason", label: "Reason" },
              { key: "change", label: "Droplets" },
              { key: "status", label: "Status" },
            ],
            rows: history.map((h) => ({
              cells: {
                when: String(h["created_at"] ?? ""),
                reason: String(h["reason"] ?? ""),
                change: `${String(h["current_instance_count"] ?? "?")} → ${String(h["desired_instance_count"] ?? "?")}`,
                status: String(h["status"] ?? ""),
              },
            })),
          }
        : muted("No scaling events yet."),
    ]),
  );
  const headerActions = detail.headerActions ?? [];
  headerActions.push(
    action(
      "Delete pool and Droplets",
      {
        type: "plugin-action",
        actionId: "autoscale-delete-with-droplets",
        confirmMessage:
          "Delete this autoscale pool AND destroy every Droplet in it? This cannot be undone. Regular Delete keeps the Droplets.",
        successMessage: "Pool and Droplets are being deleted.",
        destructive: true,
      },
      "danger",
    ),
  );
  detail.headerActions = headerActions;
}
