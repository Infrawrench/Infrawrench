import type { ResourceInstance, DetailViewSchema, SectionNode } from "@infrawrench/plugin-base";
import { tunnelStatus } from "./status.js";

export function renderTunnelDetail(resource: ResourceInstance): DetailViewSchema {
  const fields = resource.fields;
  const status = String(fields["status"] ?? "");
  return {
    title: resource.displayName,
    subtitle: "Cloudflare Tunnel",
    status: { kind: "status-dot", status: tunnelStatus(status), label: status || "Unknown" },
    sections: [
      {
        kind: "section",
        title: "Tunnel Details",
        children: [
          {
            kind: "key-value-list",
            items: [
              { key: "Name", value: String(fields["name"] ?? ""), copyable: true },
              { key: "Tunnel ID", value: resource.externalId ?? "", copyable: true },
              { key: "Status", value: status },
              ...(fields["tunnelType"]
                ? [{ key: "Type", value: String(fields["tunnelType"]) }]
                : []),
              ...(fields["remoteConfig"] !== undefined
                ? [{ key: "Remote Config", value: fields["remoteConfig"] ? "Yes" : "No" }]
                : []),
              ...(fields["connectionsCount"] !== undefined
                ? [{ key: "Active Connections", value: String(fields["connectionsCount"]) }]
                : []),
              ...(fields["createdAt"]
                ? [{ key: "Created", value: String(fields["createdAt"]) }]
                : []),
            ],
          },
        ],
      },
    ],
    headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
  };
}

export function renderFirewallRuleDetail(resource: ResourceInstance): DetailViewSchema {
  const fields = resource.fields;
  const enabled = Boolean(fields["enabled"]);
  return {
    title: String(fields["description"] || resource.displayName),
    subtitle: "WAF Custom Rule",
    status: {
      kind: "status-dot",
      status: enabled ? "healthy" : "info",
      label: enabled ? "Active" : "Disabled",
    },
    sections: [
      {
        kind: "section",
        title: "Rule Details",
        children: [
          {
            kind: "badge",
            label: String(fields["action"] ?? ""),
            color:
              fields["action"] === "block"
                ? "red"
                : fields["action"] === "challenge"
                  ? "yellow"
                  : "blue",
          },
          {
            kind: "key-value-list",
            items: [
              { key: "Action", value: String(fields["action"] ?? "") },
              { key: "Expression", value: String(fields["expression"] ?? ""), copyable: true },
              { key: "Enabled", value: enabled ? "Yes" : "No" },
              ...(fields["priority"] !== undefined
                ? [{ key: "Priority", value: String(fields["priority"]) }]
                : []),
              ...(fields["description"]
                ? [{ key: "Description", value: String(fields["description"]) }]
                : []),
            ],
          },
        ],
      },
    ],
    headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
  };
}

export function renderAccessApplicationDetail(resource: ResourceInstance): DetailViewSchema {
  const fields = resource.fields;
  return {
    title: resource.displayName,
    subtitle: "Zero Trust Access Application",
    status: { kind: "status-dot", status: "healthy", label: "Active" },
    sections: [
      {
        kind: "section",
        title: "Application Details",
        children: [
          {
            kind: "key-value-list",
            items: [
              { key: "Name", value: String(fields["name"] ?? ""), copyable: true },
              { key: "Domain", value: String(fields["domain"] ?? ""), copyable: true },
              ...(fields["type"] ? [{ key: "Type", value: String(fields["type"]) }] : []),
              ...(fields["sessionDuration"]
                ? [{ key: "Session Duration", value: String(fields["sessionDuration"]) }]
                : []),
              ...(fields["createdAt"]
                ? [{ key: "Created", value: String(fields["createdAt"]) }]
                : []),
              ...(fields["updatedAt"]
                ? [{ key: "Updated", value: String(fields["updatedAt"]) }]
                : []),
            ],
          },
        ],
      },
    ],
    headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
  };
}

export function renderEmailRoutingRuleDetail(resource: ResourceInstance): DetailViewSchema {
  const fields = resource.fields;
  const enabled = Boolean(fields["enabled"]);
  return {
    title: String(fields["name"] || resource.displayName),
    subtitle: "Email Routing Rule",
    status: {
      kind: "status-dot",
      status: enabled ? "healthy" : "info",
      label: enabled ? "Enabled" : "Disabled",
    },
    sections: [
      {
        kind: "section",
        title: "Rule Details",
        children: [
          {
            kind: "key-value-list",
            items: [
              { key: "Enabled", value: enabled ? "Yes" : "No" },
              ...(fields["matchers"]
                ? [{ key: "Matchers", value: String(fields["matchers"]) }]
                : []),
              ...(fields["actions"] ? [{ key: "Actions", value: String(fields["actions"]) }] : []),
              ...(fields["priority"] !== undefined
                ? [{ key: "Priority", value: String(fields["priority"]) }]
                : []),
            ],
          },
        ],
      },
    ],
    headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
  };
}

export function renderWaitingRoomDetail(resource: ResourceInstance): DetailViewSchema {
  const fields = resource.fields;
  const suspended = Boolean(fields["suspended"]);
  return {
    title: resource.displayName,
    subtitle: "Waiting Room",
    status: {
      kind: "status-dot",
      status: suspended ? "error" : "healthy",
      label: suspended ? "Suspended" : "Active",
    },
    sections: [
      {
        kind: "section",
        title: "Configuration",
        children: [
          {
            kind: "key-value-list",
            items: [
              { key: "Name", value: String(fields["name"] ?? ""), copyable: true },
              { key: "Host", value: String(fields["host"] ?? ""), copyable: true },
              ...(fields["path"] ? [{ key: "Path", value: String(fields["path"]) }] : []),
              ...(fields["totalActiveUsers"] !== undefined
                ? [{ key: "Max Active Users", value: String(fields["totalActiveUsers"]) }]
                : []),
              ...(fields["newUsersPerMinute"] !== undefined
                ? [{ key: "New Users/Minute", value: String(fields["newUsersPerMinute"]) }]
                : []),
              ...(fields["queueingMethod"]
                ? [{ key: "Queueing Method", value: String(fields["queueingMethod"]) }]
                : []),
              ...(fields["sessionDuration"] !== undefined
                ? [{ key: "Session Duration", value: `${String(fields["sessionDuration"])} min` }]
                : []),
              { key: "Suspended", value: suspended ? "Yes" : "No" },
            ],
          },
        ],
      },
    ],
    headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
  };
}

export function renderAccessPolicyDetail(resource: ResourceInstance): DetailViewSchema {
  const fields = resource.fields;
  const decision = String(fields["decision"] ?? "");
  return {
    title: resource.displayName,
    subtitle: "Access Policy",
    status: {
      kind: "status-dot",
      status: decision === "allow" ? "healthy" : decision === "deny" ? "error" : "info",
      label: decision,
    },
    sections: [
      {
        kind: "section",
        title: "Policy Details",
        children: [
          {
            kind: "badge",
            label: decision,
            color:
              decision === "allow"
                ? "green"
                : decision === "deny"
                  ? "red"
                  : decision === "bypass"
                    ? "yellow"
                    : "gray",
          },
          {
            kind: "key-value-list",
            items: [
              { key: "Name", value: String(fields["name"] ?? "") },
              { key: "Decision", value: decision },
              ...(fields["precedence"] !== undefined
                ? [{ key: "Precedence", value: String(fields["precedence"]) }]
                : []),
              ...(fields["includeRules"]
                ? [{ key: "Include", value: String(fields["includeRules"]) }]
                : []),
              ...(fields["excludeRules"]
                ? [{ key: "Exclude", value: String(fields["excludeRules"]) }]
                : []),
              ...(fields["requireRules"]
                ? [{ key: "Require", value: String(fields["requireRules"]) }]
                : []),
            ],
          },
        ],
      },
    ],
    headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
  };
}

export function renderSpectrumApplicationDetail(resource: ResourceInstance): DetailViewSchema {
  const fields = resource.fields;
  return {
    title: String(fields["dns"] ?? resource.displayName),
    subtitle: `Spectrum · ${String(fields["protocol"] ?? "")}`,
    status: { kind: "status-dot", status: "healthy", label: String(fields["protocol"] ?? "") },
    sections: [
      {
        kind: "section",
        title: "Application Details",
        children: [
          { kind: "badge", label: String(fields["protocol"] ?? ""), color: "blue" },
          {
            kind: "key-value-list",
            items: [
              ...(fields["dns"]
                ? [{ key: "DNS Name", value: String(fields["dns"]), copyable: true }]
                : []),
              { key: "Protocol", value: String(fields["protocol"] ?? "") },
              ...(fields["originDirect"]
                ? [{ key: "Origin Direct", value: String(fields["originDirect"]) }]
                : []),
              ...(fields["originDns"]
                ? [{ key: "Origin DNS", value: String(fields["originDns"]) }]
                : []),
              ...(fields["originPort"]
                ? [{ key: "Origin Port", value: String(fields["originPort"]) }]
                : []),
              ...(fields["tls"] ? [{ key: "TLS", value: String(fields["tls"]) }] : []),
              ...(fields["proxyProtocol"]
                ? [{ key: "Proxy Protocol", value: String(fields["proxyProtocol"]) }]
                : []),
              ...(fields["ipFirewall"] !== undefined
                ? [{ key: "IP Firewall", value: fields["ipFirewall"] ? "Enabled" : "Disabled" }]
                : []),
              ...(fields["createdOn"]
                ? [{ key: "Created", value: String(fields["createdOn"]) }]
                : []),
              ...(fields["modifiedOn"]
                ? [{ key: "Modified", value: String(fields["modifiedOn"]) }]
                : []),
            ],
          },
        ],
      },
    ],
    headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
  };
}

export function renderLogpushJobDetail(resource: ResourceInstance): DetailViewSchema {
  const fields = resource.fields;
  const enabled = Boolean(fields["enabled"]);
  const lastError = String(fields["lastError"] ?? "");
  const sections: SectionNode[] = [
    {
      kind: "section",
      title: "Job Details",
      children: [
        { kind: "badge", label: String(fields["dataset"] ?? ""), color: "blue" },
        {
          kind: "key-value-list",
          items: [
            ...(fields["name"] ? [{ key: "Name", value: String(fields["name"]) }] : []),
            { key: "Dataset", value: String(fields["dataset"] ?? "") },
            { key: "Enabled", value: enabled ? "Yes" : "No" },
            ...(fields["destinationType"]
              ? [{ key: "Destination", value: String(fields["destinationType"]) }]
              : []),
            ...(fields["frequency"]
              ? [{ key: "Frequency", value: String(fields["frequency"]) }]
              : []),
            ...(fields["logpullOptions"]
              ? [{ key: "Logpull Options", value: String(fields["logpullOptions"]) }]
              : []),
            ...(fields["lastComplete"]
              ? [{ key: "Last Complete", value: String(fields["lastComplete"]) }]
              : []),
          ],
        },
      ],
    },
  ];
  if (lastError) {
    sections.push({
      kind: "section",
      title: "Last Error",
      children: [{ kind: "text", content: lastError, variant: "mono" }],
    });
  }
  return {
    title: String(fields["name"] || fields["dataset"] || resource.displayName),
    subtitle: "Logpush Job",
    status: {
      kind: "status-dot",
      status: !enabled ? "info" : lastError ? "error" : "healthy",
      label: !enabled ? "Disabled" : lastError ? "Error" : "Active",
    },
    sections,
    headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
  };
}
