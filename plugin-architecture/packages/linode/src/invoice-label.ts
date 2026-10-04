/**
 * Invoice item labels are the only place Linode says *what* a line is for:
 * the item object has no service field and no entity id. The formats below
 * are the ones Cloud Manager's own invoice PDF code parses
 * (linode/manager `features/Billing/PdfGenerator/utils.ts`, 2026-10):
 *
 *   Backup Service - Linode 2GB - MyLinode (1234)
 *   Backup Service - Linode 8GB
 *   Linode 32GB - MyLinode (1234)
 *   Storage Volume - volume (1234) - 20 GB
 *
 * plus the single-chunk forms Cloud Manager's tests use for account-level
 * lines ("Outbound Transfer Overage", "Transfer Overage"). Anything else is
 * filed under its leading chunk, so a format Linode adds later still lands in
 * a sensible bucket rather than vanishing.
 */

export interface ParsedInvoiceLabel {
  /** Normalised service name; the same names the uninvoiced estimate uses. */
  service: string;
  /** The plan, when the label carries one ("Linode 2GB"). */
  plan?: string;
  /** The resource's own label, when present. */
  resourceLabel?: string;
  /** The numeric entity id in parentheses, when present. */
  resourceId?: string;
}

export const SERVICE = {
  linodes: "Linodes",
  backups: "Backups",
  blockStorage: "Block Storage",
  nodeBalancers: "NodeBalancers",
  kubernetes: "Kubernetes (LKE)",
  databases: "Managed Databases",
  objectStorage: "Object Storage",
  transfer: "Network Transfer",
  ips: "IP Addresses",
  reservedIps: "Reserved IPs",
  images: "Images",
  longview: "Longview",
  managed: "Linode Managed",
} as const;

const PLAN_PREFIX =
  /^(nanode|linode|dedicated|premium|high memory|gpu|rtx|accelerated|netint|standard)\b/i;

function resourceOf(chunk: string | undefined): { label?: string; id?: string } {
  if (!chunk) return {};
  const m = /^(.*?)\s*\((\d+)\)\s*$/.exec(chunk.trim());
  if (m) return { label: m[1]!.trim(), id: m[2]! };
  return { label: chunk.trim() };
}

function serviceForLeading(lead: string): string {
  const l = lead.toLowerCase();
  if (/backup/.test(l)) return SERVICE.backups;
  if (/storage volume|block storage|volume/.test(l)) return SERVICE.blockStorage;
  if (/nodebalancer/.test(l)) return SERVICE.nodeBalancers;
  if (/kubernetes|lke|high availability control plane|control plane/.test(l))
    return SERVICE.kubernetes;
  if (/dbaas|database/.test(l)) return SERVICE.databases;
  if (/object storage/.test(l)) return SERVICE.objectStorage;
  if (/transfer|bandwidth/.test(l)) return SERVICE.transfer;
  if (/reserved ip/.test(l)) return SERVICE.reservedIps;
  if (/\bip\b|ipv4|ipv6|address/.test(l)) return SERVICE.ips;
  if (/image/.test(l)) return SERVICE.images;
  if (/longview/.test(l)) return SERVICE.longview;
  if (/managed/.test(l)) return SERVICE.managed;
  if (PLAN_PREFIX.test(lead)) return SERVICE.linodes;
  return lead.replace(/\s*\(.*\)\s*$/, "").trim() || "Other";
}

export function parseInvoiceItemLabel(label: string | null | undefined): ParsedInvoiceLabel {
  const text = (label ?? "").trim();
  if (!text) return { service: "Other" };
  const chunks = text.split(" - ").map((c) => c.trim());
  const lead = chunks[0]!;

  if (chunks.length < 2) {
    const r = resourceOf(lead);
    const service = serviceForLeading(r.id ? (r.label ?? lead) : lead);
    return { service, ...(r.id ? { resourceId: r.id } : {}) };
  }

  // Backup Service - <plan> - <label (id)>
  if (/^backup/i.test(lead)) {
    const r = resourceOf(chunks[2]);
    return {
      service: SERVICE.backups,
      plan: chunks[1]!,
      ...(r.label ? { resourceLabel: r.label } : {}),
      ...(r.id ? { resourceId: r.id } : {}),
    };
  }

  // DBaaS - <plan> - <label (id)> (the database plan labels carry this prefix)
  if (/^dbaas$/i.test(lead) || /^managed database/i.test(lead)) {
    const r = resourceOf(chunks[chunks.length - 1]);
    return {
      service: SERVICE.databases,
      ...(chunks.length > 2 ? { plan: chunks[1]! } : {}),
      ...(r.label ? { resourceLabel: r.label } : {}),
      ...(r.id ? { resourceId: r.id } : {}),
    };
  }

  // Storage Volume - <label (id)> - <size>
  if (/^(storage volume|block storage)/i.test(lead)) {
    const r = resourceOf(chunks[1]);
    return {
      service: SERVICE.blockStorage,
      ...(r.label ? { resourceLabel: r.label } : {}),
      ...(r.id ? { resourceId: r.id } : {}),
    };
  }

  // <plan> - <label (id)>: a Linode, unless the lead names another product.
  const r = resourceOf(chunks[1]);
  const service = serviceForLeading(lead);
  return {
    service,
    ...(service === SERVICE.linodes ? { plan: lead } : {}),
    ...(r.label ? { resourceLabel: r.label } : {}),
    ...(r.id ? { resourceId: r.id } : {}),
  };
}
