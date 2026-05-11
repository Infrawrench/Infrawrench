/**
 * Detail renderers for Cloud DNS resources (zones and record sets).
 */
import type { DetailViewSchema, ResourceInstance } from "@infrawrench/plugin-base";
import { dnsRecordBadgeColor, formatDnsTtl } from "@infrawrench/plugin-base";

/** Apply the Cloud DNS zone renderer to `base`. */
export function renderCloudDnsZone(resource: ResourceInstance, base: DetailViewSchema): void {
  const fields = resource.fields;
  const dnsName = String(fields["dnsName"] ?? "");
  const nameservers = String(fields["nameservers"] ?? "");
  const nsList = nameservers.split(", ").filter(Boolean);
  const visibility = String(fields["visibility"] ?? "public");
  const dnssec = String(fields["dnssecState"] ?? "off");
  base.subtitle = `Cloud DNS · ${visibility}`;
  base.status = { kind: "status-dot", status: "healthy", label: "Active" };
  base.sections = [
    {
      kind: "section",
      title: "Zone Info",
      children: [
        {
          kind: "key-value-list",
          items: [
            { key: "DNS Name", value: dnsName, copyable: true },
            { key: "Zone Name", value: String(fields["name"] ?? "") },
            { key: "Visibility", value: visibility },
            { key: "DNSSEC", value: dnssec },
            ...(fields["description"]
              ? [{ key: "Description", value: String(fields["description"]) }]
              : []),
          ],
        },
      ],
    },
    ...(nsList.length > 0
      ? [
          {
            kind: "section" as const,
            title: "Nameservers",
            children: [
              {
                kind: "key-value-list" as const,
                items: nsList.map((ns, i) => ({
                  key: `NS ${i + 1}`,
                  value: ns,
                  copyable: true,
                })),
              },
              {
                kind: "text" as const,
                content:
                  "Point your domain registrar to these nameservers to use Google Cloud DNS.",
                variant: "muted" as const,
              },
            ],
          },
        ]
      : []),
  ];
}

/** Apply the Cloud DNS record set renderer to `base`. */
export function renderCloudDnsRecordSet(resource: ResourceInstance, base: DetailViewSchema): void {
  const fields = resource.fields;
  const type = String(fields["type"] ?? "");
  const name = String(fields["name"] ?? "");
  const rrdatas = String(fields["rrdatas"] ?? "");
  const ttl = Number(fields["ttl"] ?? 300);
  const zoneName = String(fields["zoneName"] ?? "");
  base.subtitle = `${type} → ${rrdatas.length > 50 ? `${rrdatas.slice(0, 47)}...` : rrdatas}`;
  base.status = { kind: "status-dot", status: "healthy" };
  base.sections = [
    {
      kind: "section",
      title: "Record Details",
      children: [
        { kind: "badge", label: type, color: dnsRecordBadgeColor(type) },
        {
          kind: "key-value-list",
          items: [
            { key: "Type", value: type },
            { key: "Name", value: name, copyable: true },
            { key: "Data", value: rrdatas, copyable: true },
            { key: "TTL", value: formatDnsTtl(ttl) },
            ...(zoneName ? [{ key: "Zone", value: zoneName }] : []),
          ],
        },
      ],
    },
  ];
}
