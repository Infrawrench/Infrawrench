import type { AssociationRole, CreateFieldConfig } from "./create.js";

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
  /** Submitted field key, e.g. "content" / "data" / "value" / "rrdatas". */
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
    associationRole: AssociationRole,
    pickerLabel: string,
    description: string,
  ): CreateFieldConfig => ({
    key,
    label: pickerLabel,
    kind: "resource-picker",
    required,
    referenceMode: true,
    associationRole,
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
      "dns-ipv4",
      `${label}: pick an IPv4 resource`,
      "The record will track this resource's public IPv4 address.",
    ),
    picker(
      "AAAA",
      "dns-ipv6",
      `${label}: pick an IPv6 resource`,
      "The record will track this resource's public IPv6 address.",
    ),
    picker(
      "CNAME",
      "dns-hostname",
      `${label}: pick a hostname resource`,
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
