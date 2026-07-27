/** Detail views for DigitalOcean domains and their DNS records. */
import type { DetailViewSchema, ResourceInstance, SectionNode } from "@infrawrench/plugin-base";
import {
  formatDnsTtl,
  renderDnsRecordDetail as sharedRenderDnsRecordDetail,
} from "@infrawrench/plugin-base";

export function renderDomainDetail(resource: ResourceInstance): DetailViewSchema {
  const fields = resource.fields;
  const sections: SectionNode[] = [
    {
      kind: "section",
      title: "Domain Info",
      children: [
        {
          kind: "key-value-list",
          items: [
            { key: "Domain", value: String(fields["name"] ?? ""), copyable: true },
            { key: "Default TTL", value: formatDnsTtl(Number(fields["ttl"] ?? 0)) },
          ],
        },
      ],
    },
    {
      kind: "section",
      title: "Nameservers",
      children: [
        {
          kind: "key-value-list",
          items: [
            { key: "NS 1", value: "ns1.digitalocean.com", copyable: true },
            { key: "NS 2", value: "ns2.digitalocean.com", copyable: true },
            { key: "NS 3", value: "ns3.digitalocean.com", copyable: true },
          ],
        },
        {
          kind: "text",
          content: "Point your domain registrar to these nameservers to use DigitalOcean DNS.",
          variant: "muted",
        },
      ],
    },
  ];
  return {
    title: resource.displayName,
    subtitle: "DNS Domain",
    status: { kind: "status-dot", status: "healthy", label: "Active" },
    sections,
    headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
  };
}

export function renderDnsRecordDetail(resource: ResourceInstance): DetailViewSchema {
  const fields = resource.fields;
  const extraInfoItems: Array<{ key: string; value: string; copyable?: boolean }> = [];
  if (fields["port"] !== undefined) {
    extraInfoItems.push({ key: "Port", value: String(fields["port"]) });
  }
  if (fields["weight"] !== undefined) {
    extraInfoItems.push({ key: "Weight", value: String(fields["weight"]) });
  }
  if (fields["tag"]) {
    extraInfoItems.push({ key: "Tag", value: String(fields["tag"]) });
  }
  const opts = extraInfoItems.length > 0 ? { extraInfoItems } : {};
  return sharedRenderDnsRecordDetail(resource, opts);
}
