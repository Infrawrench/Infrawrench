import type { ResourceInstance, DetailViewSchema, StatusDotNode } from "@infrawrench/plugin-base";

const refresh = {
  kind: "action" as const,
  label: "Refresh",
  action: { type: "refresh-resource" as const },
};

function enabledStatus(enabled: unknown): StatusDotNode {
  return {
    kind: "status-dot",
    status: enabled ? "healthy" : "info",
    label: enabled ? "Active" : "Disabled",
  };
}

export function renderRateLimitRuleDetail(resource: ResourceInstance): DetailViewSchema {
  const f = resource.fields;
  return {
    title: resource.displayName,
    subtitle: "Rate Limiting Rule",
    status: enabledStatus(f["enabled"]),
    sections: [
      {
        kind: "section",
        title: "Rule Details",
        children: [
          {
            kind: "key-value-list",
            items: [
              { key: "Description", value: String(f["description"] ?? "") },
              { key: "Expression", value: String(f["expression"] ?? ""), copyable: true },
              {
                key: "Rate",
                value: `${String(f["requestsPerPeriod"] ?? "")} req / ${String(f["period"] ?? "")}s`,
              },
              ...(f["characteristics"]
                ? [{ key: "Characteristics", value: String(f["characteristics"]) }]
                : []),
              { key: "Action", value: String(f["action"] ?? "block") },
              { key: "Enabled", value: f["enabled"] ? "Yes" : "No" },
            ],
          },
        ],
      },
    ],
    headerActions: [refresh],
  };
}

export function renderRedirectRuleDetail(resource: ResourceInstance): DetailViewSchema {
  const f = resource.fields;
  return {
    title: resource.displayName,
    subtitle: "Redirect Rule",
    status: enabledStatus(f["enabled"]),
    sections: [
      {
        kind: "section",
        title: "Rule Details",
        children: [
          {
            kind: "key-value-list",
            items: [
              { key: "Description", value: String(f["description"] ?? "") },
              { key: "When (expression)", value: String(f["expression"] ?? ""), copyable: true },
              { key: "Target URL", value: String(f["target"] ?? ""), copyable: true },
              { key: "Status Code", value: String(f["statusCode"] ?? "") },
              { key: "Preserve Query", value: f["preserveQuery"] ? "Yes" : "No" },
              { key: "Enabled", value: f["enabled"] ? "Yes" : "No" },
            ],
          },
        ],
      },
    ],
    headerActions: [refresh],
  };
}

export function renderCacheRuleDetail(resource: ResourceInstance): DetailViewSchema {
  const f = resource.fields;
  return {
    title: resource.displayName,
    subtitle: "Cache Rule",
    status: enabledStatus(f["enabled"]),
    sections: [
      {
        kind: "section",
        title: "Rule Details",
        children: [
          {
            kind: "key-value-list",
            items: [
              { key: "Description", value: String(f["description"] ?? "") },
              { key: "When (expression)", value: String(f["expression"] ?? ""), copyable: true },
              { key: "Cache", value: f["cache"] ? "Eligible for cache" : "Bypass cache" },
              ...(f["edgeTtl"] !== undefined
                ? [{ key: "Edge TTL", value: `${String(f["edgeTtl"])}s` }]
                : []),
              { key: "Enabled", value: f["enabled"] ? "Yes" : "No" },
            ],
          },
        ],
      },
    ],
    headerActions: [refresh],
  };
}

export function renderIpAccessRuleDetail(resource: ResourceInstance): DetailViewSchema {
  const f = resource.fields;
  const mode = String(f["mode"] ?? "");
  return {
    title: resource.displayName,
    subtitle: "IP Access Rule",
    status: {
      kind: "status-dot",
      status: mode === "whitelist" ? "healthy" : mode === "block" ? "error" : "info",
      label: mode || "Unknown",
    },
    sections: [
      {
        kind: "section",
        title: "Rule Details",
        children: [
          {
            kind: "key-value-list",
            items: [
              { key: "Mode", value: mode },
              { key: "Target", value: String(f["target"] ?? "") },
              { key: "Value", value: String(f["value"] ?? ""), copyable: true },
              ...(f["notes"] ? [{ key: "Notes", value: String(f["notes"]) }] : []),
            ],
          },
        ],
      },
    ],
    headerActions: [refresh],
  };
}
