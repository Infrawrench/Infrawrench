/**
 * Pure mapping helpers: Proxmox VE API payloads to Infrawrench fields.
 * Kept free of I/O so the tricky parsing (property strings, sizes, volids)
 * is unit-testable.
 */

/** One entry of `GET /cluster/resources`. */
export interface PveClusterResource {
  id: string;
  type: string;
  node?: string;
  name?: string;
  status?: string;
  vmid?: number;
  template?: number | boolean;
  maxcpu?: number;
  maxmem?: number;
  maxdisk?: number;
  disk?: number;
  mem?: number;
  cpu?: number;
  uptime?: number;
  tags?: string;
  pool?: string;
  hastate?: string;
  lock?: string;
  storage?: string;
  plugintype?: string;
  content?: string;
  shared?: number | boolean;
}

export type PveConfig = Record<string, string | number | undefined>;

const GIB = 1024 ** 3;

export function bytesToGib(bytes: number | undefined): number {
  if (!bytes || !Number.isFinite(bytes)) return 0;
  return Math.round((bytes / GIB) * 10) / 10;
}

export function truthy(v: unknown): boolean {
  return v === true || v === 1 || v === "1" || v === "true";
}

/**
 * Parse a Proxmox property string (`virtio=AA:BB,bridge=vmbr0,firewall=1`)
 * into a map. A leading bare token (`local-lvm:vm-100-disk-0`) is stored
 * under `""`; for `net[n]` the model token `virtio=MAC` is kept as a key.
 */
export function parsePropertyString(value: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of value.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) {
      if (out[""] === undefined) out[""] = trimmed;
      continue;
    }
    out[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
  }
  return out;
}

/** `32G` → 32, `512M` → 0.5, `1T` → 1024, `8` (GiB by default) → 8. */
export function sizeToGib(size: string | undefined): number {
  if (!size) return 0;
  const m = /^(\d+(?:\.\d+)?)([KMGT]?)$/i.exec(size.trim());
  if (!m) return 0;
  const n = Number(m[1]);
  switch ((m[2] ?? "").toUpperCase()) {
    case "K":
      return Math.round((n / 1024 / 1024) * 100) / 100;
    case "M":
      return Math.round((n / 1024) * 100) / 100;
    case "T":
      return n * 1024;
    default:
      return n;
  }
}

const VM_DISK_KEY = /^(scsi|virtio|sata|ide|efidisk|tpmstate)\d+$/;
const NET_KEY = /^net\d+$/;

/** Disk slots of a VM config that can be resized (not CD-ROMs, EFI or TPM). */
export function resizableVmDisks(config: PveConfig): string[] {
  return Object.keys(config)
    .filter((k) => /^(scsi|virtio|sata|ide)\d+$/.test(k))
    .filter((k) => {
      const v = String(config[k] ?? "");
      return !/media=cdrom/.test(v) && v !== "none";
    })
    .sort();
}

/** Human summary of a VM's disks: `scsi0=local-lvm 32G, ide2=cdrom`. */
export function summarizeVmDisks(config: PveConfig): string {
  return Object.keys(config)
    .filter((k) => VM_DISK_KEY.test(k))
    .sort()
    .map((k) => {
      const props = parsePropertyString(String(config[k] ?? ""));
      if (props["media"] === "cdrom") {
        const iso = props[""] ?? "none";
        return `${k}=cdrom ${iso === "none" ? "(empty)" : iso}`;
      }
      const vol = props[""] ?? "";
      const storage = vol.split(":")[0] ?? "";
      return `${k}=${storage}${props["size"] ? ` ${props["size"]}` : ""}`;
    })
    .join(", ");
}

/** `net0=virtio vmbr0 (BC:24:11:..), net1=...` for VMs and containers. */
export function summarizeNetworks(config: PveConfig): string {
  return Object.keys(config)
    .filter((k) => NET_KEY.test(k))
    .sort()
    .map((k) => {
      const props = parsePropertyString(String(config[k] ?? ""));
      const model = Object.keys(props).find((p) =>
        ["virtio", "e1000", "e1000e", "rtl8139", "vmxnet3", "veth"].includes(p),
      );
      const mac = (model ? props[model] : undefined) ?? props["hwaddr"] ?? props["macaddr"] ?? "";
      const bridge = props["bridge"] ?? "";
      const ip = props["ip"] ? ` ip=${props["ip"]}` : "";
      const tag = props["tag"] ? ` vlan ${props["tag"]}` : "";
      const label = props["name"] ?? model ?? props["type"] ?? "";
      return `${k}=${[label, bridge].filter(Boolean).join(" ")}${tag}${ip}${mac ? ` (${mac})` : ""}`;
    })
    .join(", ");
}

/** Memory in MiB from a `memory` config value (`2048` or `current=2048`). */
export function memoryMb(value: string | number | undefined): number | undefined {
  if (value === undefined || value === "") return undefined;
  if (typeof value === "number") return value;
  const props = parsePropertyString(value);
  const v = props["current"] ?? props[""];
  return v !== undefined && v !== "" ? Number(v) : undefined;
}

/** CPU type from a `cpu` config value (`host` or `cputype=host,flags=+aes`). */
export function cpuType(value: string | number | undefined): string {
  if (value === undefined) return "";
  const props = parsePropertyString(String(value));
  return props["cputype"] ?? props[""] ?? "";
}

export function vmStatus(r: { status?: string; qmpstatus?: string }): string {
  if (r.qmpstatus === "paused" || r.qmpstatus === "suspended") return "paused";
  if (r.status === "running" || r.status === "stopped") return r.status;
  return "unknown";
}

/**
 * A backup's guest from its volid. vzdump names files
 * `vzdump-qemu-100-2026_10_01-02_00_00.vma.zst`; Proxmox Backup Server
 * volids look like `pbs:backup/vm/100/2026-10-01T02:00:00Z`.
 */
export function backupGuest(
  volid: string,
  vmid?: number,
): { guestType: "qemu" | "lxc" | ""; vmid: string } {
  const file = /vzdump-(qemu|lxc|openvz)-(\d+)-/.exec(volid);
  if (file) {
    return { guestType: file[1] === "qemu" ? "qemu" : "lxc", vmid: file[2] ?? String(vmid ?? "") };
  }
  const pbs = /backup\/(vm|ct)\/(\d+)\//.exec(volid);
  if (pbs) return { guestType: pbs[1] === "vm" ? "qemu" : "lxc", vmid: pbs[2] ?? "" };
  return { guestType: "", vmid: vmid !== undefined ? String(vmid) : "" };
}

/** Backup external id: `<node>/<volid>` so actions can find the storage's node. */
export function backupExternalId(node: string, volid: string): string {
  return `${node}/${volid}`;
}

export function parseBackupExternalId(externalId: string): {
  node: string;
  volid: string;
  storage: string;
} {
  const slash = externalId.indexOf("/");
  if (slash <= 0) throw new Error(`Proxmox plugin: malformed backup id "${externalId}"`);
  const node = externalId.slice(0, slash);
  const volid = externalId.slice(slash + 1);
  const storage = volid.split(":")[0] ?? "";
  return { node, volid, storage };
}

/** Storage external id: `<node>/<storage>`. */
export function parseStorageExternalId(externalId: string): { node: string; storage: string } {
  const slash = externalId.indexOf("/");
  if (slash <= 0) throw new Error(`Proxmox plugin: malformed storage id "${externalId}"`);
  return { node: externalId.slice(0, slash), storage: externalId.slice(slash + 1) };
}

/** The usable IPv4/IPv6 from a guest-agent `network-get-interfaces` result. */
export function pickAgentAddresses(
  result: Array<{
    name?: string;
    "ip-addresses"?: Array<{ "ip-address"?: string; "ip-address-type"?: string }>;
  }>,
): { ipv4: string; ipv6: string } {
  let ipv4 = "";
  let ipv6 = "";
  for (const iface of result) {
    if (
      !iface.name ||
      iface.name === "lo" ||
      /^(docker|br-|veth|virbr|cni|flannel|cali)/.test(iface.name)
    ) {
      continue;
    }
    for (const a of iface["ip-addresses"] ?? []) {
      const ip = a["ip-address"] ?? "";
      if (
        a["ip-address-type"] === "ipv4" &&
        !ipv4 &&
        !ip.startsWith("127.") &&
        !ip.startsWith("169.254.")
      ) {
        ipv4 = ip;
      }
      if (a["ip-address-type"] === "ipv6" && !ipv6 && ip !== "::1" && !/^fe80:/i.test(ip)) {
        ipv6 = ip;
      }
    }
  }
  return { ipv4, ipv6 };
}

/** Same for a container's `/interfaces` result (`inet: "10.0.0.5/24"`). */
export function pickCtAddresses(result: Array<{ name?: string; inet?: string; inet6?: string }>): {
  ipv4: string;
  ipv6: string;
} {
  let ipv4 = "";
  let ipv6 = "";
  for (const iface of result) {
    if (!iface.name || iface.name === "lo") continue;
    const v4 = (iface.inet ?? "").split("/")[0] ?? "";
    const v6 = (iface.inet6 ?? "").split("/")[0] ?? "";
    if (!ipv4 && v4 && !v4.startsWith("127.")) ipv4 = v4;
    if (!ipv6 && v6 && v6 !== "::1" && !/^fe80:/i.test(v6)) ipv6 = v6;
  }
  return { ipv4, ipv6 };
}

/** RRD timeframe covering a range: the coarsest one that still spans it. */
export function rrdTimeframe(rangeMs: number): "hour" | "day" | "week" | "month" | "year" {
  const h = 3_600_000;
  if (rangeMs <= h * 1.05) return "hour";
  if (rangeMs <= 24 * h * 1.05) return "day";
  if (rangeMs <= 7 * 24 * h * 1.05) return "week";
  if (rangeMs <= 31 * 24 * h * 1.05) return "month";
  return "year";
}

/** Epoch seconds to ISO, or "" when absent. */
export function epochIso(seconds: number | undefined): string {
  if (!seconds || !Number.isFinite(seconds)) return "";
  return new Date(seconds * 1000).toISOString();
}

/** Run async work over items with bounded concurrency, preserving order. */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i] as T);
    }
  });
  await Promise.all(workers);
  return results;
}
