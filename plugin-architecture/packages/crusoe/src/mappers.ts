import type { ResourceInstance } from "@infrawrench/plugin-base";
import type {
  CrusoeCluster,
  CrusoeDisk,
  CrusoeEntity,
  CrusoeFirewallRule,
  CrusoeFirewallTarget,
  CrusoeLoadBalancer,
  CrusoeNodePool,
  CrusoeProject,
  CrusoeReservation,
  CrusoeSnapshot,
  CrusoeSshKey,
  CrusoeVm,
  CrusoeVmType,
  CrusoeVpcNetwork,
  CrusoeVpcSubnet,
} from "./types.js";

/** Pure mapping from Crusoe payloads to host resource instances. */

export const PLUGIN_ID = "crusoe";

type Fields = ResourceInstance["fields"];

export function makeInstance(opts: {
  accountId: string;
  typeId: string;
  externalId: string;
  displayName: string;
  fields: Fields;
  outputs?: Record<string, string>;
  parentResourceId?: string;
  createdAt?: string;
}): ResourceInstance {
  const now = new Date().toISOString();
  return {
    id: `${opts.accountId}:${opts.typeId}:${opts.externalId}`,
    pluginId: PLUGIN_ID,
    resourceTypeId: opts.typeId,
    accountId: opts.accountId,
    displayName: opts.displayName,
    fields: opts.fields,
    resolvedOutputs: opts.outputs ?? {},
    secretStates: [],
    externalId: opts.externalId,
    ...(opts.parentResourceId ? { parentResourceId: opts.parentResourceId } : {}),
    createdAt: opts.createdAt || now,
    updatedAt: now,
    lastSyncedAt: now,
  };
}

/** `<projectId>/<id>` for project-scoped resources. */
export function scopedId(projectId: string, id: string): string {
  return `${projectId}/${id}`;
}

/** Split a project-scoped externalId (or full host resource id) into its parts. */
export function parseScopedId(resourceIdOrExternal: string): { projectId: string; id: string } {
  const external = resourceIdOrExternal.includes(":")
    ? resourceIdOrExternal.split(":").slice(2).join(":")
    : resourceIdOrExternal;
  const slash = external.indexOf("/");
  if (slash <= 0 || slash === external.length - 1) {
    throw new Error(`Crusoe plugin: cannot parse resource id "${resourceIdOrExternal}"`);
  }
  return { projectId: external.slice(0, slash), id: external.slice(slash + 1) };
}

/** Bare externalId of a host resource id. */
export function externalOf(resourceId: string): string {
  return resourceId.includes(":") ? resourceId.split(":").slice(2).join(":") : resourceId;
}

function parentOf(accountId: string, projectId: string): { parentResourceId?: string } {
  return projectId ? { parentResourceId: `${accountId}:project:${projectId}` } : {};
}

/** Crusoe's libvirt-style `STATE_*` values, folded into the states the UI and lifecycle use. */
export function normalizeVmState(raw: string | undefined): string {
  switch (raw) {
    case "STATE_RUNNING":
      return "running";
    case "STATE_RUNNING_DEGRADED":
      return "degraded";
    case "STATE_SHUTOFF":
    case "STATE_SHUTDOWN":
      return "stopped";
    case "STATE_PAUSED":
    case "STATE_PMSUSPENDED":
      return "paused";
    case "STATE_CRASHED":
    case "STATE_BLOCKED":
      return "crashed";
    case "STATE_DEFINING":
    case "STATE_RESOURCING_LOCATION":
    case "STATE_RESOURCING_AGENT":
      return "provisioning";
    default:
      return "unknown";
  }
}

/**
 * Disk sizes arrive as `[Size][Unit]` strings (`100GiB`, `1TiB`); snapshot
 * sizes as a byte count. Both become GiB, or 0 when unparseable.
 */
export function parseSizeGib(size: string | undefined): number {
  if (!size) return 0;
  const m = /^\s*([\d.]+)\s*([KMGTP]i?B)?\s*$/i.exec(size);
  if (!m) return 0;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return 0;
  const unit = (m[2] ?? "B").toUpperCase();
  const factor: Record<string, number> = {
    B: 1 / 1024 ** 3,
    KIB: 1 / 1024 ** 2,
    KB: 1 / 1024 ** 2,
    MIB: 1 / 1024,
    MB: 1 / 1024,
    GIB: 1,
    GB: 1,
    TIB: 1024,
    TB: 1024,
    PIB: 1024 ** 2,
    PB: 1024 ** 2,
  };
  const gib = n * (factor[unit] ?? 0);
  return Math.round(gib * 100) / 100;
}

function joinList(values: Array<string | undefined> | undefined): string {
  return (values ?? []).filter((v): v is string => !!v).join(", ");
}

export function formatFirewallTargets(targets: CrusoeFirewallTarget[] | undefined): string {
  return joinList((targets ?? []).map((t) => t.cidr || t.resource_id));
}

/** Inverse of `formatFirewallTargets`: anything that looks like an address is a CIDR. */
export function parseFirewallTargets(value: string): CrusoeFirewallTarget[] {
  return splitList(value).map((v) =>
    /^[\d.:/a-fA-F]+$/.test(v) && /[.:]/.test(v) ? { cidr: v } : { resource_id: v },
  );
}

export function splitList(value: string | undefined): string[] {
  return (value ?? "")
    .split(/[,\n]/)
    .map((v) => v.trim())
    .filter(Boolean);
}

export function mapProject(
  p: CrusoeProject,
  accountId: string,
  orgs: Map<string, CrusoeEntity>,
): ResourceInstance {
  const org = p.organization_id ? orgs.get(p.organization_id) : undefined;
  return makeInstance({
    accountId,
    typeId: "project",
    externalId: p.id,
    displayName: p.name || p.id,
    fields: {
      name: p.name ?? "",
      organizationName: org?.name ?? "",
      organizationId: p.organization_id ?? "",
      vmCount: p.resources?.["instances"]?.count ?? 0,
      diskCount: p.resources?.["disks"]?.count ?? 0,
      networkCount: p.resources?.["vpc_networks"]?.count ?? 0,
    },
  });
}

export function mapVm(
  vm: CrusoeVm,
  projectId: string,
  accountId: string,
  types: Map<string, CrusoeVmType>,
): ResourceInstance {
  const nic = vm.network_interfaces?.[0];
  const ip = nic?.ips?.[0];
  const type = vm.type ? types.get(vm.type) : undefined;
  return makeInstance({
    accountId,
    typeId: "vm",
    externalId: scopedId(projectId, vm.id),
    displayName: vm.name || vm.id,
    fields: {
      name: vm.name ?? "",
      state: normalizeVmState(vm.state),
      type: vm.type ?? "",
      location: vm.location ?? "",
      projectId,
      billingType: vm.billing_type ?? "",
      reservationId: vm.reservation_id ?? "",
      gpuType: type?.gpu_type ?? "",
      gpuCount: type?.num_gpu ?? 0,
      vcpus: type?.cpu_cores ?? 0,
      memoryGb: type?.memory_gb ?? 0,
      diskIds: joinList((vm.disks ?? []).map((d) => d.id)),
      subnetId: nic?.subnet ?? "",
      networkId: nic?.network ?? "",
      publicIpType: ip?.public_ipv4?.type ?? "",
      rawState: vm.state ?? "",
      createdAt: vm.created_at ?? "",
    },
    outputs: {
      publicIp: ip?.public_ipv4?.address ?? "",
      privateIp: ip?.private_ipv4?.address ?? "",
      dnsName: nic?.external_dns_name ?? "",
    },
    ...parentOf(accountId, projectId),
    ...(vm.created_at ? { createdAt: vm.created_at } : {}),
  });
}

export function mapDisk(d: CrusoeDisk, projectId: string, accountId: string): ResourceInstance {
  const attached = d.attached_to ?? [];
  return makeInstance({
    accountId,
    typeId: "disk",
    externalId: scopedId(projectId, d.id),
    displayName: d.name || d.id,
    fields: {
      name: d.name ?? "",
      sizeGib: parseSizeGib(d.size),
      type: d.type ?? "",
      location: d.location ?? "",
      projectId,
      // Always written, "" when detached: the orphan rule depends on it.
      attachedVmIds: joinList(attached.map((a) => a.vm_id)),
      attachmentType: joinList([...new Set(attached.map((a) => a.attachment_type))]),
      blockSize: d.block_size ?? 0,
      serialNumber: d.serial_number ?? "",
      createdAt: d.created_at ?? "",
    },
    outputs: { dnsName: d.dns_name ?? "" },
    ...parentOf(accountId, projectId),
    ...(d.created_at ? { createdAt: d.created_at } : {}),
  });
}

export function mapSnapshot(
  s: CrusoeSnapshot,
  projectId: string,
  accountId: string,
): ResourceInstance {
  // Snapshot sizes are a bare byte count.
  const bytes = Number(s.size ?? 0);
  return makeInstance({
    accountId,
    typeId: "snapshot",
    externalId: scopedId(projectId, s.id),
    displayName: s.name || s.id,
    fields: {
      name: s.name ?? "",
      sizeGib: Number.isFinite(bytes) ? Math.round((bytes / 1024 ** 3) * 100) / 100 : 0,
      sourceDiskId: s.created_from ?? "",
      projectId,
      createdAt: s.created_at ?? "",
    },
    ...parentOf(accountId, projectId),
    ...(s.created_at ? { createdAt: s.created_at } : {}),
  });
}

export function mapNetwork(
  n: CrusoeVpcNetwork,
  projectId: string,
  accountId: string,
): ResourceInstance {
  return makeInstance({
    accountId,
    typeId: "vpc-network",
    externalId: scopedId(projectId, n.id),
    displayName: n.name || n.id,
    fields: {
      name: n.name ?? "",
      cidr: n.cidr ?? "",
      subnetIds: joinList(n.subnets),
      gatewayId: n.gateway ?? "",
      projectId,
    },
    ...parentOf(accountId, projectId),
  });
}

export function mapSubnet(
  s: CrusoeVpcSubnet,
  projectId: string,
  accountId: string,
): ResourceInstance {
  const nat = s.nat_gateways ?? [];
  return makeInstance({
    accountId,
    typeId: "vpc-subnet",
    externalId: scopedId(projectId, s.id),
    displayName: s.name || s.id,
    fields: {
      name: s.name ?? "",
      cidr: s.cidr ?? "",
      location: s.location ?? "",
      networkId: s.vpc_network_id ?? "",
      natGateway: nat.length > 0,
      natPublicIp: joinList(nat.map((g) => g.public_ipv4_address)),
      projectId,
    },
    ...parentOf(accountId, projectId),
  });
}

export function mapFirewallRule(
  r: CrusoeFirewallRule,
  projectId: string,
  accountId: string,
): ResourceInstance {
  return makeInstance({
    accountId,
    typeId: "firewall-rule",
    externalId: scopedId(projectId, r.id),
    displayName: r.name || r.id,
    fields: {
      name: r.name ?? "",
      networkId: r.vpc_network_id ?? "",
      direction: r.direction ?? "",
      action: r.action ?? "",
      state: r.state ?? "",
      protocols: joinList(r.protocols),
      sources: formatFirewallTargets(r.sources),
      sourcePorts: joinList(r.source_ports),
      destinations: formatFirewallTargets(r.destinations),
      destinationPorts: joinList(r.destination_ports),
      projectId,
    },
    ...parentOf(accountId, projectId),
  });
}

export function mapSshKey(k: CrusoeSshKey, accountId: string): ResourceInstance {
  return makeInstance({
    accountId,
    typeId: "ssh-key",
    externalId: k.id,
    displayName: k.name || k.id,
    fields: {
      name: k.name ?? "",
      fingerprint: k.fingerprints?.sha256 ?? "",
      publicKey: k.public_key ?? "",
      createdAt: k.created_at ?? "",
    },
    ...(k.created_at ? { createdAt: k.created_at } : {}),
  });
}

export function mapCluster(
  c: CrusoeCluster,
  projectId: string,
  accountId: string,
): ResourceInstance {
  return makeInstance({
    accountId,
    typeId: "kubernetes-cluster",
    externalId: scopedId(projectId, c.id),
    displayName: c.name || c.id,
    fields: {
      name: c.name ?? "",
      state: c.state ?? "",
      version: c.version ?? "",
      location: c.location ?? "",
      projectId,
      nodePoolIds: joinList(c.node_pools),
      dnsName: c.dns_name ?? "",
      private: c.private ?? false,
      subnetId: c.subnet_id ?? "",
      clusterCidr: c.cluster_cidr ?? "",
      serviceCidr: c.service_cluster_ip_range ?? "",
      routingMode: c.routing_mode ?? "",
      addOns: joinList(c.add_ons),
      createdAt: c.created_at ?? "",
    },
    outputs: { clusterEndpoint: c.dns_name ? `https://${c.dns_name}` : "" },
    ...parentOf(accountId, projectId),
    ...(c.created_at ? { createdAt: c.created_at } : {}),
  });
}

export function mapNodePool(
  np: CrusoeNodePool,
  projectId: string,
  accountId: string,
): ResourceInstance {
  const issues = np.health?.issues ?? [];
  const auto = np.autoscaling_config;
  return makeInstance({
    accountId,
    typeId: "node-pool",
    externalId: scopedId(projectId, np.id),
    displayName: np.name || np.id,
    fields: {
      name: np.name ?? "",
      clusterId: np.cluster_id ?? "",
      type: np.type ?? "",
      count: np.count ?? 0,
      currentCount: np.current ?? 0,
      autoscaling: auto?.enabled ?? false,
      minNodes: auto?.min_node_size ?? 0,
      maxNodes: auto?.max_node_size ?? 0,
      state: (np.state ?? "").replace(/^STATE_/, "").toLowerCase(),
      health: issues.length ? issues.map((i) => i.message || i.code || "").join("; ") : "healthy",
      subnetId: np.subnet_id ?? "",
      reservationId: np.reservation_id ?? "",
      publicIpType: np.public_ip_type ?? "",
      instanceIds: joinList(np.instance_ids),
      projectId,
    },
    ...(np.cluster_id
      ? {
          parentResourceId: `${accountId}:kubernetes-cluster:${scopedId(projectId, np.cluster_id)}`,
        }
      : {}),
    ...(np.created_at ? { createdAt: np.created_at } : {}),
  });
}

export function mapLoadBalancer(
  lb: CrusoeLoadBalancer,
  projectId: string,
  accountId: string,
): ResourceInstance {
  const listeners = lb.listen_ports_and_backends ?? [];
  return makeInstance({
    accountId,
    typeId: "load-balancer",
    externalId: scopedId(projectId, lb.id),
    displayName: lb.name || lb.id,
    fields: {
      name: lb.name ?? "",
      location: lb.location ?? "",
      protocol: lb.protocol ?? "",
      networkId: lb.vpc_id ?? "",
      listenPorts: joinList(listeners.map((l) => (l.listen_port ? String(l.listen_port) : ""))),
      backends: joinList(
        listeners.flatMap((l) =>
          (l.backends ?? []).map(
            (b) => `${b.ip ?? "?"}:${b.port ?? "?"}${b.status ? ` (${b.status})` : ""}`,
          ),
        ),
      ),
      projectId,
    },
    outputs: { vip: lb.vip ?? "" },
    ...parentOf(accountId, projectId),
  });
}

export function mapReservation(
  r: CrusoeReservation,
  organizationId: string,
  accountId: string,
): ResourceInstance {
  const quantity = r.quantity ?? 0;
  const used = r.used_quantity ?? 0;
  return makeInstance({
    accountId,
    typeId: "reservation",
    externalId: `${organizationId}/${r.id}`,
    displayName: `${r.product_line ?? "Reservation"} × ${quantity}`,
    fields: {
      productLine: r.product_line ?? "",
      reservationType: r.reservation_type ?? "",
      quantity,
      usedQuantity: used,
      utilizationPercent: quantity > 0 ? Math.round((used / quantity) * 1000) / 10 : 0,
      locations: joinList(r.locations),
      projectIds: joinList(r.projects),
      vmIds: joinList(r.vm_ids),
      contractStartDate: r.contract_start_date ?? "",
      contractEndDate: r.contract_end_date ?? "",
      organizationId,
    },
  });
}
