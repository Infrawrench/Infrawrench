import type { AssociationSource, CreateFieldConfig } from "./create.js";

/**
 * Shared builder for the "content / value" field of a DNS record create form.
 *
 * Every DNS-capable provider (Cloudflare `content`, DigitalOcean `data`,
 * Netlify/Route 53 `value`, GCP `rrdatas`) needs the same UX:
 *   - For A / AAAA / CNAME records, default to a resource picker so the user
 *     can point the record at an existing resource (a server's public IP, a
 *     load balancer's hostname, …) instead of copy-pasting a value. The picker
 *     runs in `referenceMode`, so the chosen resource is stored as a live
 *     output reference and the record tracks the source's value over time.
 *   - A "Use custom value" toggle swaps the picker for a plain text input.
 *   - For every other record type (MX, TXT, SRV, NS, …) the field is plain
 *     text with no toggle.
 *
 * The picker and the text input share the same submitted key, so the plugin's
 * `createResource` keeps receiving a single value under `opts.key`. The mode
 * toggle is `transient` and never reaches the plugin.
 */
export interface DnsContentFieldOptions {
  /** Submitted field key — e.g. "content" / "data" / "value" / "rrdatas". */
  key: string;
  /** Label for the value field. Defaults to "Value". */
  label?: string;
  /** Whether the value is required. Defaults to true. */
  required?: boolean;
  /** Sibling field holding the record type. Defaults to "type". */
  recordTypeFieldKey?: string;
  /** Placeholder for the custom text input. */
  placeholder?: string;
  /** Extra help text shown under the custom text input. */
  description?: string;
}

/** Record types whose value should be pickable from another resource. */
export const PICKABLE_DNS_TYPES = ["A", "AAAA", "CNAME"] as const;

/** IPv4-producing outputs across providers — for A records. */
export const DNS_IPV4_SOURCES: AssociationSource[] = [
  { pluginId: "aws", resourceTypeId: "ec2-instance", outputKey: "publicIp" },
  { pluginId: "aws", resourceTypeId: "elastic-ip", outputKey: "publicIp" },
  { pluginId: "digitalocean", resourceTypeId: "droplet", outputKey: "ipv4" },
  { pluginId: "azure", resourceTypeId: "azure-vm", outputKey: "publicIp" },
  { pluginId: "azure", resourceTypeId: "azure-public-ip", outputKey: "ipAddress" },
  { pluginId: "hetzner", resourceTypeId: "server", outputKey: "ipv4" },
  { pluginId: "hetzner", resourceTypeId: "floating-ip", outputKey: "ip" },
  { pluginId: "scaleway", resourceTypeId: "instance", outputKey: "publicIp" },
  { pluginId: "gcp", resourceTypeId: "gce-instance", outputKey: "externalIp" },
  { pluginId: "gcp", resourceTypeId: "forwarding-rule", outputKey: "IPAddress" },
];

/** IPv6-producing outputs across providers — for AAAA records. */
export const DNS_IPV6_SOURCES: AssociationSource[] = [
  { pluginId: "digitalocean", resourceTypeId: "droplet", outputKey: "ipv6" },
  { pluginId: "hetzner", resourceTypeId: "server", outputKey: "ipv6" },
  { pluginId: "fly", resourceTypeId: "machine", outputKey: "privateIp" },
];

/** Hostname-producing outputs across providers — for CNAME records. */
export const DNS_HOSTNAME_SOURCES: AssociationSource[] = [
  { pluginId: "aws", resourceTypeId: "alb", outputKey: "dnsName" },
  { pluginId: "aws", resourceTypeId: "ec2-instance", outputKey: "publicDns" },
  { pluginId: "aws", resourceTypeId: "rds-instance", outputKey: "endpoint" },
  { pluginId: "aws", resourceTypeId: "rds-cluster", outputKey: "endpoint" },
  { pluginId: "aws", resourceTypeId: "documentdb-cluster", outputKey: "endpoint" },
  { pluginId: "digitalocean", resourceTypeId: "spaces-bucket", outputKey: "endpoint" },
  { pluginId: "azure", resourceTypeId: "azure-vm", outputKey: "fqdn" },
  { pluginId: "azure", resourceTypeId: "azure-public-ip", outputKey: "fqdn" },
];

/**
 * Build the mode toggle + per-type resource pickers + custom text input for a
 * DNS record's value field. Spread the result into a create config's `fields`
 * array in place of the old single text field.
 */
export function dnsContentField(opts: DnsContentFieldOptions): CreateFieldConfig[] {
  const { key } = opts;
  const label = opts.label ?? "Value";
  const required = opts.required ?? true;
  const typeKey = opts.recordTypeFieldKey ?? "type";
  const modeKey = `${key}__mode`;
  const pickable = [...PICKABLE_DNS_TYPES];

  const picker = (
    recordType: (typeof PICKABLE_DNS_TYPES)[number],
    sources: AssociationSource[],
    pickerLabel: string,
    description: string,
  ): CreateFieldConfig => ({
    key,
    label: pickerLabel,
    kind: "resource-picker",
    required,
    referenceMode: true,
    associationSources: sources,
    description,
    showWhen: {
      allOf: [
        { fieldKey: typeKey, fieldValue: recordType },
        { fieldKey: modeKey, fieldValue: "picker" },
      ],
    },
  });

  return [
    {
      key: modeKey,
      label: "Value source",
      kind: "select",
      required: false,
      transient: true,
      defaultValue: "picker",
      options: [
        { id: "picker", label: "Pick a resource" },
        { id: "custom", label: "Use custom value" },
      ],
      description: "Point this record at an existing resource, or enter a value manually.",
      showWhen: { fieldKey: typeKey, fieldValues: pickable },
    },
    picker(
      "A",
      DNS_IPV4_SOURCES,
      `${label} — pick an IPv4 resource`,
      "The record will track this resource's public IPv4 address.",
    ),
    picker(
      "AAAA",
      DNS_IPV6_SOURCES,
      `${label} — pick an IPv6 resource`,
      "The record will track this resource's public IPv6 address.",
    ),
    picker(
      "CNAME",
      DNS_HOSTNAME_SOURCES,
      `${label} — pick a hostname resource`,
      "The record will track this resource's hostname.",
    ),
    {
      key,
      label,
      kind: "text",
      required,
      ...(opts.placeholder ? { placeholder: opts.placeholder } : {}),
      ...(opts.description ? { description: opts.description } : {}),
      showWhen: {
        anyOf: [
          { fieldKey: modeKey, fieldValue: "custom" },
          { fieldKey: typeKey, fieldValuesNot: pickable },
        ],
      },
    },
  ];
}
