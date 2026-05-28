import type { ResourceInstance, DetailViewSchema, SectionNode } from "@infrawrench/plugin-base";
import { dnsZoneStatus, formatDnsTtl } from "@infrawrench/plugin-base";
import { sslStatus } from "./status.js";

export function renderZoneDetail(resource: ResourceInstance): DetailViewSchema {
  const fields = resource.fields;
  const status = String(fields["status"] ?? "");
  const nameservers = String(fields["nameservers"] ?? "");
  const nsList = nameservers.split(", ").filter(Boolean);

  const sections: SectionNode[] = [
    {
      kind: "section",
      title: "Zone Info",
      children: [
        {
          kind: "key-value-list",
          items: [
            { key: "Domain", value: String(fields["name"] ?? "") },
            { key: "Status", value: status },
            { key: "Plan", value: String(fields["plan"] ?? "Free") },
            { key: "Type", value: String(fields["type"] ?? "full") },
            ...(fields["paused"] ? [{ key: "Paused", value: "Yes" }] : []),
          ],
        },
      ],
    },
  ];

  if (nsList.length > 0) {
    sections.push({
      kind: "section",
      title: "Nameservers",
      children: [
        {
          kind: "key-value-list",
          items: nsList.map((ns, i) => ({
            key: `NS ${i + 1}`,
            value: ns,
            copyable: true,
          })),
        },
        {
          kind: "text",
          content: "Point your domain registrar to these nameservers to activate Cloudflare.",
          variant: "muted",
        },
      ],
    });
  }

  return {
    title: resource.displayName,
    subtitle: `Zone · ${String(fields["plan"] ?? "Free")}`,
    status: { kind: "status-dot", status: dnsZoneStatus(status), label: status },
    sections,
    childTables: [
      {
        title: "DNS Records",
        typeId: "dns-record",
        emptyText: "No DNS records in this zone yet.",
        columns: [
          {
            key: "type",
            label: "Type",
            width: "narrow",
            source: { kind: "field", fieldKey: "type" },
            format: "type-badge",
          },
          {
            key: "name",
            label: "Name",
            width: "auto",
            source: { kind: "field", fieldKey: "name" },
            stripSuffixFromFieldKey: "zoneName",
          },
          {
            key: "content",
            label: "Content",
            width: "wide",
            source: { kind: "field", fieldKey: "content" },
            format: "mono",
          },
          {
            key: "proxied",
            label: "Proxy",
            width: "narrow",
            source: { kind: "field", fieldKey: "proxied" },
            format: "proxy-status",
          },
          {
            key: "ttl",
            label: "TTL",
            width: "narrow",
            source: { kind: "field", fieldKey: "ttl" },
            format: "ttl",
          },
        ],
      },
    ],
    manifestEditor: { language: "json", resourceKind: "Zone Settings" },
    headerActions: [
      { kind: "action", label: "Refresh", action: { type: "refresh-resource" } },
      {
        kind: "action",
        label: "Open in Cloudflare",
        action: {
          type: "open-url",
          url: `https://dash.cloudflare.com/${resource.externalId ?? ""}`,
        },
      },
    ],
  };
}

export function renderSSLCertificateDetail(resource: ResourceInstance): DetailViewSchema {
  const fields = resource.fields;
  const status = String(fields["status"] ?? "");
  return {
    title: resource.displayName,
    subtitle: "SSL/TLS Certificate",
    status: { kind: "status-dot", status: sslStatus(status), label: status },
    sections: [
      {
        kind: "section",
        title: "Certificate Details",
        children: [
          {
            kind: "key-value-list",
            items: [
              { key: "Hosts", value: String(fields["hosts"] ?? ""), copyable: true },
              { key: "Status", value: status },
              ...(fields["issuer"] ? [{ key: "Issuer", value: String(fields["issuer"]) }] : []),
              ...(fields["type"] ? [{ key: "Type", value: String(fields["type"]) }] : []),
              ...(fields["expiresOn"]
                ? [{ key: "Expires", value: String(fields["expiresOn"]) }]
                : []),
              ...(fields["zoneName"] ? [{ key: "Zone", value: String(fields["zoneName"]) }] : []),
            ],
          },
        ],
      },
    ],
    headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
  };
}

export function renderPageRuleDetail(resource: ResourceInstance): DetailViewSchema {
  const fields = resource.fields;
  const status = String(fields["status"] ?? "");
  return {
    title: resource.displayName,
    subtitle: "Page Rule",
    status: {
      kind: "status-dot",
      status: status === "active" ? "healthy" : "info",
      label: status,
    },
    sections: [
      {
        kind: "section",
        title: "Page Rule Details",
        children: [
          {
            kind: "key-value-list",
            items: [
              { key: "URL Pattern", value: String(fields["targets"] ?? ""), copyable: true },
              { key: "Status", value: status },
              ...(fields["actions"] ? [{ key: "Actions", value: String(fields["actions"]) }] : []),
              ...(fields["priority"] !== undefined
                ? [{ key: "Priority", value: String(fields["priority"]) }]
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

export function renderLoadBalancerDetail(resource: ResourceInstance): DetailViewSchema {
  const fields = resource.fields;
  const enabled = Boolean(fields["enabled"]);
  return {
    title: resource.displayName,
    subtitle: "Load Balancer",
    status: {
      kind: "status-dot",
      status: enabled ? "healthy" : "error",
      label: enabled ? "Enabled" : "Disabled",
    },
    sections: [
      {
        kind: "section",
        title: "Load Balancer Details",
        children: [
          {
            kind: "key-value-list",
            items: [
              { key: "Name", value: String(fields["name"] ?? ""), copyable: true },
              { key: "Enabled", value: enabled ? "Yes" : "No" },
              ...(fields["proxied"] !== undefined
                ? [{ key: "Proxied", value: fields["proxied"] ? "Yes" : "No" }]
                : []),
              ...(fields["steeringPolicy"]
                ? [{ key: "Steering Policy", value: String(fields["steeringPolicy"]) }]
                : []),
              ...(fields["fallbackPool"]
                ? [{ key: "Fallback Pool", value: String(fields["fallbackPool"]) }]
                : []),
              ...(fields["defaultPools"]
                ? [{ key: "Default Pools", value: String(fields["defaultPools"]) }]
                : []),
              ...(fields["ttl"] !== undefined
                ? [{ key: "TTL", value: formatDnsTtl(Number(fields["ttl"])) }]
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

export function renderCustomHostnameDetail(resource: ResourceInstance): DetailViewSchema {
  const fields = resource.fields;
  const status = String(fields["status"] ?? "");
  return {
    title: String(fields["hostname"] ?? resource.displayName),
    subtitle: "Custom Hostname (SSL for SaaS)",
    status: {
      kind: "status-dot",
      status: status === "active" ? "healthy" : status === "pending" ? "provisioning" : "info",
      label: status,
    },
    sections: [
      {
        kind: "section",
        title: "Hostname Details",
        children: [
          {
            kind: "key-value-list",
            items: [
              { key: "Hostname", value: String(fields["hostname"] ?? ""), copyable: true },
              { key: "Status", value: status },
              ...(fields["sslStatus"]
                ? [{ key: "SSL Status", value: String(fields["sslStatus"]) }]
                : []),
              ...(fields["sslMethod"]
                ? [{ key: "SSL Method", value: String(fields["sslMethod"]) }]
                : []),
              ...(fields["sslType"] ? [{ key: "SSL Type", value: String(fields["sslType"]) }] : []),
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
