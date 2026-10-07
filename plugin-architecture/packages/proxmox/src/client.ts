import type {
  DetailViewSchema,
  HostServices,
  LogsFetchParams,
  LogsFetchResult,
  MetricSeries,
  PluginClient,
  PreflightResult,
  ResourceCreateReturn,
  ResourceInstance,
  SidebarItemSchema,
  CreateResourceConfig,
  DashboardStat,
} from "@infrawrench/plugin-base";
import { externalIdOf } from "@infrawrench/plugin-base";
import { ProxmoxApi, ProxmoxApiError, type FormValue } from "./api.js";
import {
  backupExternalId,
  backupGuest,
  bytesToGib,
  cpuType,
  epochIso,
  mapLimit,
  memoryMb,
  parseBackupExternalId,
  parsePropertyString,
  parseStorageExternalId,
  pickAgentAddresses,
  pickCtAddresses,
  resizableVmDisks,
  rrdTimeframe,
  sizeToGib,
  summarizeNetworks,
  summarizeVmDisks,
  truthy,
  vmStatus,
  type PveClusterResource,
  type PveConfig,
} from "./mappers.js";
import {
  BACKUP,
  BACKUP_JOB,
  CLUSTER,
  CT,
  FW_ALIAS,
  FW_RULE,
  HA_RESOURCE,
  HA_RULE,
  IPSET,
  NODE,
  POOL,
  SECURITY_GROUP,
  STORAGE,
  VM,
  resourceTypes,
} from "./resources.js";
import {
  renderProxmoxDetail,
  renderProxmoxSidebar,
  ENRICH_KEY,
  type ProxmoxEnrichment,
} from "./render.js";
import { proxmoxCreateConfig, proxmoxCreateResource } from "./create.js";
import { proxmoxInvokeAction, proxmoxPromptCommand } from "./actions.js";
import { proxmoxVerifyCredentials } from "./preflight.js";

export type GuestKind = "qemu" | "lxc";

export interface GuestLocation {
  node: string;
  kind: GuestKind;
  vmid: number;
  resource: PveClusterResource;
}

const CACHE_MS = 10_000;

/** Encode one path segment. */
export const seg = (s: string | number): string => encodeURIComponent(String(s));

export class ProxmoxClient implements PluginClient {
  readonly api: ProxmoxApi;
  private resourcesCache: { at: number; promise: Promise<PveClusterResource[]> } | undefined;

  constructor(credentials: Record<string, string>, services?: HostServices) {
    const url = credentials["url"] ?? "";
    const tokenId = credentials["tokenId"] ?? "";
    const tokenSecret = credentials["tokenSecret"] ?? "";
    if (!url) throw new Error("Proxmox plugin: missing url credential");
    if (!tokenId) throw new Error("Proxmox plugin: missing tokenId credential");
    this.api = new ProxmoxApi(
      {
        url,
        tokenId,
        tokenSecret,
        ...(credentials["caCert"] ? { caCert: credentials["caCert"] } : {}),
      },
      services?.http,
    );
  }

  // ---------------------------------------------------------------------------
  // Shared lookups
  // ---------------------------------------------------------------------------

  /** `GET /cluster/resources`, memoised briefly so one sync pass makes one call. */
  clusterResources(): Promise<PveClusterResource[]> {
    const now = Date.now();
    if (this.resourcesCache && now - this.resourcesCache.at < CACHE_MS) {
      return this.resourcesCache.promise;
    }
    const promise = this.api.get<PveClusterResource[]>("/cluster/resources").then((r) => r ?? []);
    promise.catch(() => {
      this.resourcesCache = undefined;
    });
    this.resourcesCache = { at: now, promise };
    return promise;
  }

  invalidate(): void {
    this.resourcesCache = undefined;
  }

  /** Where a guest lives right now (guests migrate, so this is never cached in ids). */
  async locateGuest(vmid: string | number): Promise<GuestLocation> {
    const id = Number(vmid);
    const all = await this.clusterResources();
    const r = all.find((x) => (x.type === "qemu" || x.type === "lxc") && x.vmid === id);
    if (!r || !r.node) {
      throw new ProxmoxApiError(`Proxmox VE guest ${vmid} was not found in the cluster`, 404);
    }
    return { node: r.node, kind: r.type as GuestKind, vmid: id, resource: r };
  }

  guestPath(loc: { node: string; kind: GuestKind; vmid: number }): string {
    return `/nodes/${seg(loc.node)}/${loc.kind}/${loc.vmid}`;
  }

  async onlineNodes(): Promise<string[]> {
    const all = await this.clusterResources();
    return all
      .filter((r) => r.type === "node" && r.status === "online" && r.node)
      .map((r) => r.node as string)
      .sort();
  }

  instance(
    accountId: string,
    typeId: string,
    externalId: string,
    displayName: string,
    fields: Record<string, string | number | boolean>,
    extra: { parentResourceId?: string; resolvedOutputs?: Record<string, string> } = {},
  ): ResourceInstance {
    const now = new Date().toISOString();
    return {
      id: `${accountId}:${typeId}:${externalId}`,
      pluginId: "proxmox",
      resourceTypeId: typeId,
      accountId,
      displayName,
      fields,
      resolvedOutputs: extra.resolvedOutputs ?? {},
      secretStates: [],
      externalId,
      ...(extra.parentResourceId ? { parentResourceId: extra.parentResourceId } : {}),
      createdAt: now,
      updatedAt: now,
    };
  }

  // ---------------------------------------------------------------------------
  // Listing
  // ---------------------------------------------------------------------------

  async listResources(typeId: string, accountId: string): Promise<ResourceInstance[]> {
    switch (typeId) {
      case CLUSTER:
        return this.listCluster(accountId);
      case NODE:
        return this.listNodes(accountId);
      case VM:
        return this.listGuests(accountId, "qemu");
      case CT:
        return this.listGuests(accountId, "lxc");
      case STORAGE:
        return this.listStorage(accountId);
      case BACKUP:
        return this.listBackups(accountId);
      case BACKUP_JOB:
        return this.listBackupJobs(accountId);
      case POOL:
        return this.listPools(accountId);
      case HA_RESOURCE:
        return this.listHaResources(accountId);
      case HA_RULE:
        return this.listHaRules(accountId);
      case FW_RULE:
        return this.listFirewallRules(accountId);
      case SECURITY_GROUP:
        return this.listSecurityGroups(accountId);
      case FW_ALIAS:
        return this.listAliases(accountId);
      case IPSET:
        return this.listIpsets(accountId);
      default:
        throw new Error(`Proxmox plugin: unknown resource type "${typeId}"`);
    }
  }

  async getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<ResourceInstance> {
    const all = await this.listResources(typeId, accountId);
    const ext = externalIdOf(resourceId);
    const found = all.find((r) => r.id === resourceId || r.externalId === ext);
    if (!found) throw new ProxmoxApiError(`Proxmox plugin: ${typeId} ${ext} not found`, 404);
    return found;
  }

  private async listCluster(accountId: string): Promise<ResourceInstance[]> {
    const [status, version, fw] = await Promise.all([
      this.api.get<Array<Record<string, unknown>>>("/cluster/status"),
      this.api.get<{ version?: string; release?: string }>("/version").catch(() => undefined),
      this.api
        .get<{ enable?: number; policy_in?: string; policy_out?: string }>(
          "/cluster/firewall/options",
        )
        .catch(() => undefined),
    ]);
    const cluster = (status ?? []).find((s) => s["type"] === "cluster");
    const nodes = (status ?? []).filter((s) => s["type"] === "node");
    const name = String(cluster?.["name"] ?? nodes[0]?.["name"] ?? "Proxmox VE");
    const fields: Record<string, string | number | boolean> = {
      name,
      quorate: cluster ? truthy(cluster["quorate"]) : true,
      nodeCount: Number(cluster?.["nodes"] ?? nodes.length),
      onlineNodes: nodes.filter((n) => truthy(n["online"])).length,
      pveVersion: version?.version ?? "",
    };
    if (fw) {
      fields["firewallEnabled"] = truthy(fw.enable);
      fields["firewallPolicyIn"] = fw.policy_in ?? "DROP";
      fields["firewallPolicyOut"] = fw.policy_out ?? "ACCEPT";
    }
    return [
      this.instance(accountId, CLUSTER, "cluster", name, fields, {
        resolvedOutputs: { apiUrl: this.api.uiUrl },
      }),
    ];
  }

  private async listNodes(accountId: string): Promise<ResourceInstance[]> {
    const [resources, status] = await Promise.all([
      this.clusterResources(),
      this.api.get<Array<Record<string, unknown>>>("/cluster/status").catch(() => []),
    ]);
    const ips = new Map<string, string>();
    for (const s of status ?? []) {
      if (s["type"] === "node" && typeof s["name"] === "string")
        ips.set(s["name"], String(s["ip"] ?? ""));
    }
    const nodes = resources.filter((r) => r.type === "node" && r.node);
    return mapLimit(nodes, 6, async (n) => {
      const name = n.node as string;
      const online = n.status === "online";
      const fields: Record<string, string | number | boolean> = {
        name,
        status: online ? "online" : n.status === "offline" ? "offline" : "unknown",
        ip: ips.get(name) ?? "",
        cpuCount: n.maxcpu ?? 0,
        memoryGb: bytesToGib(n.maxmem),
      };
      if (online) {
        const [st, sub] = await Promise.all([
          this.api
            .get<{
              pveversion?: string;
              cpuinfo?: { model?: string; cpus?: number };
              "current-kernel"?: { release?: string };
              kversion?: string;
            }>(`/nodes/${seg(name)}/status`)
            .catch(() => undefined),
          this.api
            .get<{ level?: string; status?: string; nextduedate?: string; productname?: string }>(
              `/nodes/${seg(name)}/subscription`,
            )
            .catch(() => undefined),
        ]);
        if (st) {
          fields["cpuModel"] = st.cpuinfo?.model ?? "";
          fields["pveVersion"] = st.pveversion ?? "";
          fields["kernel"] = st["current-kernel"]?.release ?? st.kversion ?? "";
        }
        if (sub) {
          fields["subscriptionLevel"] = sub.productname ?? sub.level ?? "";
          fields["subscriptionStatus"] = sub.status ?? "";
          if (sub.nextduedate) fields["subscriptionDue"] = sub.nextduedate;
        }
      }
      return this.instance(accountId, NODE, name, name, fields, {
        resolvedOutputs: {
          nodeName: name,
          ...(ips.get(name) ? { ip: ips.get(name) as string } : {}),
        },
      });
    });
  }

  private async listGuests(accountId: string, kind: GuestKind): Promise<ResourceInstance[]> {
    const all = await this.clusterResources();
    const guests = all.filter((r) => r.type === kind && r.vmid !== undefined && r.node);
    return mapLimit(guests, 8, async (g) => {
      const config = await this.api
        .get<PveConfig>(`/nodes/${seg(g.node as string)}/${kind}/${g.vmid}/config`)
        .catch(() => undefined);
      return kind === "qemu" ? this.mapVm(accountId, g, config) : this.mapCt(accountId, g, config);
    });
  }

  mapVm(accountId: string, g: PveClusterResource, config: PveConfig | undefined): ResourceInstance {
    const c = config ?? {};
    const vmid = g.vmid as number;
    const name = String(c["name"] ?? g.name ?? `VM ${vmid}`);
    const fields: Record<string, string | number | boolean> = {
      name,
      vmid,
      node: g.node ?? "",
      status: vmStatus({ ...(g.status ? { status: g.status } : {}) }),
      template: truthy(g.template ?? c["template"]),
      diskGb: bytesToGib(g.maxdisk),
      tags: String(c["tags"] ?? g.tags ?? ""),
      pool: g.pool ?? "",
      haState: g.hastate ?? "",
      lock: g.lock ?? String(c["lock"] ?? ""),
    };
    if (config) {
      fields["cores"] = Number(c["cores"] ?? 1);
      fields["sockets"] = Number(c["sockets"] ?? 1);
      const mem = memoryMb(c["memory"]);
      fields["memoryMb"] = mem ?? Math.round((g.maxmem ?? 0) / 1024 / 1024);
      if (c["balloon"] !== undefined) fields["balloonMb"] = Number(c["balloon"]);
      fields["cpuType"] = cpuType(c["cpu"]) || "kvm64";
      fields["ostype"] = String(c["ostype"] ?? "other");
      fields["disks"] = summarizeVmDisks(c);
      fields["networks"] = summarizeNetworks(c);
      fields["agent"] = truthy(
        parsePropertyString(String(c["agent"] ?? "0"))["enabled"] ??
          parsePropertyString(String(c["agent"] ?? "0"))[""],
      );
      fields["onboot"] = truthy(c["onboot"]);
      fields["protection"] = truthy(c["protection"]);
      fields["description"] = String(c["description"] ?? "").trim();
    } else {
      fields["cores"] = g.maxcpu ?? 0;
      fields["memoryMb"] = Math.round((g.maxmem ?? 0) / 1024 / 1024);
    }
    return this.instance(accountId, VM, String(vmid), `${name} (${vmid})`, fields, {
      resolvedOutputs: { vmid: String(vmid), node: g.node ?? "" },
    });
  }

  mapCt(accountId: string, g: PveClusterResource, config: PveConfig | undefined): ResourceInstance {
    const c = config ?? {};
    const vmid = g.vmid as number;
    const name = String(c["hostname"] ?? g.name ?? `CT ${vmid}`);
    const rootfs = parsePropertyString(String(c["rootfs"] ?? ""));
    const fields: Record<string, string | number | boolean> = {
      name,
      vmid,
      node: g.node ?? "",
      status: g.status === "running" || g.status === "stopped" ? g.status : "unknown",
      template: truthy(g.template ?? c["template"]),
      diskGb: rootfs["size"] ? sizeToGib(rootfs["size"]) : bytesToGib(g.maxdisk),
      tags: String(c["tags"] ?? g.tags ?? ""),
      pool: g.pool ?? "",
      haState: g.hastate ?? "",
      lock: g.lock ?? String(c["lock"] ?? ""),
    };
    if (config) {
      if (c["cores"] !== undefined) fields["cores"] = Number(c["cores"]);
      fields["memoryMb"] = Number(c["memory"] ?? 512);
      fields["swapMb"] = Number(c["swap"] ?? 512);
      fields["rootfs"] =
        `${(rootfs[""] ?? "").split(":")[0] ?? ""}${rootfs["size"] ? ` ${rootfs["size"]}` : ""}`;
      fields["ostype"] = String(c["ostype"] ?? "");
      fields["unprivileged"] = truthy(c["unprivileged"]);
      fields["features"] = String(c["features"] ?? "");
      fields["networks"] = summarizeNetworks(c);
      fields["onboot"] = truthy(c["onboot"]);
      fields["protection"] = truthy(c["protection"]);
      fields["description"] = String(c["description"] ?? "").trim();
    } else {
      fields["memoryMb"] = Math.round((g.maxmem ?? 0) / 1024 / 1024);
    }
    return this.instance(accountId, CT, String(vmid), `${name} (${vmid})`, fields, {
      resolvedOutputs: { vmid: String(vmid), node: g.node ?? "" },
    });
  }

  private async listStorage(accountId: string): Promise<ResourceInstance[]> {
    const [all, config] = await Promise.all([
      this.clusterResources(),
      this.api
        .get<
          Array<{
            storage: string;
            type?: string;
            disable?: number;
            content?: string;
            shared?: number;
          }>
        >("/storage")
        .catch(() => []),
    ]);
    const cfg = new Map((config ?? []).map((s) => [s.storage, s]));
    return all
      .filter((r) => r.type === "storage" && r.storage && r.node)
      .map((r) => {
        const sc = cfg.get(r.storage as string);
        const ext = `${r.node}/${r.storage}`;
        return this.instance(
          accountId,
          STORAGE,
          ext,
          `${r.storage} (${r.node})`,
          {
            storage: r.storage as string,
            node: r.node as string,
            type: sc?.type ?? r.plugintype ?? "",
            content: sc?.content ?? r.content ?? "",
            shared: truthy(sc?.shared ?? r.shared),
            enabled: !truthy(sc?.disable),
            totalGb: bytesToGib(r.maxdisk),
          },
          { resolvedOutputs: { storage: r.storage as string } },
        );
      });
  }

  /** Storages holding a content type, one entry per shared storage. */
  async storagesWithContent(
    content: string,
  ): Promise<Array<{ node: string; storage: string; shared: boolean }>> {
    const all = await this.clusterResources();
    const seen = new Set<string>();
    const out: Array<{ node: string; storage: string; shared: boolean }> = [];
    for (const r of all) {
      if (r.type !== "storage" || !r.storage || !r.node) continue;
      if (r.status && r.status !== "available") continue;
      const contents = String(r.content ?? "").split(",");
      if (!contents.includes(content)) continue;
      const shared = truthy(r.shared);
      const key = shared ? r.storage : `${r.node}/${r.storage}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ node: r.node, storage: r.storage, shared });
    }
    return out.sort((a, b) => `${a.storage}${a.node}`.localeCompare(`${b.storage}${b.node}`));
  }

  async storageContent(
    node: string,
    storage: string,
    content?: string,
  ): Promise<
    Array<{
      volid: string;
      content?: string;
      format?: string;
      size?: number;
      ctime?: number;
      vmid?: number;
      notes?: string;
      protected?: number | boolean;
      encrypted?: string;
      verification?: { state?: string };
    }>
  > {
    return (
      (await this.api.get(
        `/nodes/${seg(node)}/storage/${seg(storage)}/content`,
        content ? { content } : undefined,
      )) ?? []
    );
  }

  private async listBackups(accountId: string): Promise<ResourceInstance[]> {
    const stores = await this.storagesWithContent("backup");
    const lists = await mapLimit(stores, 4, async (s) => {
      const items = await this.storageContent(s.node, s.storage, "backup").catch(() => []);
      return items.map((b) => {
        const guest = backupGuest(b.volid, b.vmid);
        const vmid = guest.vmid;
        const fields: Record<string, string | number | boolean> = {
          volid: b.volid,
          storage: s.storage,
          node: s.node,
          vmid,
          guestType: guest.guestType || "qemu",
          vmId: guest.guestType === "qemu" ? vmid : "",
          ctId: guest.guestType === "lxc" ? vmid : "",
          createdAt: epochIso(b.ctime),
          sizeGb: bytesToGib(b.size),
          format: b.format ?? "",
          encrypted: !!b.encrypted && b.encrypted !== "0",
          verifyState: b.verification?.state ?? "",
          notes: (b.notes ?? "").trim(),
          protected: truthy(b.protected),
        };
        const when = epochIso(b.ctime).slice(0, 16).replace("T", " ");
        const label = `${vmid ? `${vmid} ` : ""}${when || b.volid}`;
        return this.instance(accountId, BACKUP, backupExternalId(s.node, b.volid), label, fields, {
          parentResourceId: `${accountId}:${STORAGE}:${s.node}/${s.storage}`,
          resolvedOutputs: { volid: b.volid },
        });
      });
    });
    return lists.flat();
  }

  private async listBackupJobs(accountId: string): Promise<ResourceInstance[]> {
    const jobs = (await this.api.get<Array<Record<string, unknown>>>("/cluster/backup")) ?? [];
    return jobs.map((j) => {
      const id = String(j["id"]);
      const prune = j["prune-backups"];
      const fields: Record<string, string | number | boolean> = {
        jobId: id,
        schedule: String(j["schedule"] ?? ""),
        storage: String(j["storage"] ?? ""),
        selection: String(j["vmid"] ?? ""),
        all: truthy(j["all"]),
        exclude: String(j["exclude"] ?? ""),
        pool: String(j["pool"] ?? ""),
        node: String(j["node"] ?? ""),
        mode: String(j["mode"] ?? "snapshot"),
        compress: String(j["compress"] ?? "0"),
        enabled: j["enabled"] === undefined ? true : truthy(j["enabled"]),
        comment: String(j["comment"] ?? ""),
        notesTemplate: String(j["notes-template"] ?? ""),
        pruneBackups:
          prune && typeof prune === "object"
            ? Object.entries(prune as Record<string, unknown>)
                .map(([k, v]) => `${k}=${String(v)}`)
                .join(",")
            : String(prune ?? ""),
        repeatMissed: truthy(j["repeat-missed"]),
        nextRun: epochIso(
          typeof j["next-run"] === "number" ? (j["next-run"] as number) : undefined,
        ),
      };
      const label = String(j["comment"] ?? "") || `${fields["schedule"]} → ${fields["storage"]}`;
      return this.instance(accountId, BACKUP_JOB, id, label, fields);
    });
  }

  private async listPools(accountId: string): Promise<ResourceInstance[]> {
    const pools =
      (await this.api.get<
        Array<{
          poolid: string;
          comment?: string;
          members?: Array<{ id?: string; vmid?: number; storage?: string; type?: string }>;
        }>
      >("/pools")) ?? [];
    return mapLimit(pools, 6, async (p) => {
      let members = p.members;
      if (!members) {
        const detail = await this.api
          .get<Array<{ members?: typeof members }> | { members?: typeof members }>("/pools", {
            poolid: p.poolid,
          })
          .catch(() => undefined);
        members = Array.isArray(detail) ? detail[0]?.members : detail?.members;
      }
      const list = (members ?? []).map((m) =>
        m.vmid !== undefined
          ? String(m.vmid)
          : m.storage
            ? `storage:${m.storage}`
            : String(m.id ?? ""),
      );
      return this.instance(accountId, POOL, p.poolid, p.poolid, {
        poolid: p.poolid,
        comment: p.comment ?? "",
        members: list.join(", "),
        memberCount: list.length,
      });
    });
  }

  private async listHaResources(accountId: string): Promise<ResourceInstance[]> {
    const [resources, status] = await Promise.all([
      this.api.get<Array<Record<string, unknown>>>("/cluster/ha/resources"),
      this.api.get<Array<Record<string, unknown>>>("/cluster/ha/status/current").catch(() => []),
    ]);
    const svc = new Map<string, Record<string, unknown>>();
    for (const s of status ?? []) if (typeof s["sid"] === "string") svc.set(s["sid"], s);
    return (resources ?? []).map((r) => {
      const sid = String(r["sid"]);
      const [type, id] = sid.split(":");
      const st = svc.get(sid);
      const fields: Record<string, string | number | boolean> = {
        sid,
        guestType: type === "ct" ? "ct" : "vm",
        vmid: id ?? "",
        vmId: type === "vm" ? (id ?? "") : "",
        ctId: type === "ct" ? (id ?? "") : "",
        state: String(r["state"] ?? "started"),
        maxRestart: Number(r["max_restart"] ?? 1),
        maxRelocate: Number(r["max_relocate"] ?? 1),
        failback: r["failback"] === undefined ? true : truthy(r["failback"]),
        group: String(r["group"] ?? ""),
        comment: String(r["comment"] ?? ""),
        node: String(st?.["node"] ?? ""),
        currentState: String(st?.["state"] ?? st?.["status"] ?? ""),
      };
      return this.instance(accountId, HA_RESOURCE, sid, sid, fields);
    });
  }

  private async listHaRules(accountId: string): Promise<ResourceInstance[]> {
    let rules: Array<Record<string, unknown>>;
    try {
      rules = (await this.api.get<Array<Record<string, unknown>>>("/cluster/ha/rules")) ?? [];
    } catch (e) {
      // HA rules arrived in Proxmox VE 9; older clusters answer 501/404.
      if (e instanceof ProxmoxApiError && (e.status === 501 || e.status === 404)) return [];
      throw e;
    }
    return rules.map((r) => {
      const id = String(r["rule"]);
      return this.instance(accountId, HA_RULE, id, id, {
        rule: id,
        type: String(r["type"] ?? ""),
        resources: String(r["resources"] ?? ""),
        nodes: String(r["nodes"] ?? ""),
        affinity: String(r["affinity"] ?? (r["type"] === "node-affinity" ? "positive" : "")),
        strict: truthy(r["strict"]),
        disable: truthy(r["disable"]),
        comment: String(r["comment"] ?? ""),
      });
    });
  }

  mapFirewallRule(r: Record<string, unknown>): Record<string, string | number | boolean> {
    return {
      pos: Number(r["pos"] ?? 0),
      type: String(r["type"] ?? "in"),
      action: String(r["action"] ?? ""),
      enable: truthy(r["enable"]),
      macro: String(r["macro"] ?? ""),
      proto: String(r["proto"] ?? ""),
      source: String(r["source"] ?? ""),
      dest: String(r["dest"] ?? ""),
      sport: String(r["sport"] ?? ""),
      dport: String(r["dport"] ?? ""),
      iface: String(r["iface"] ?? ""),
      log: String(r["log"] ?? "nolog"),
      comment: String(r["comment"] ?? ""),
    };
  }

  static describeRule(f: Record<string, string | number | boolean>): string {
    const what = f["macro"]
      ? String(f["macro"])
      : [f["proto"], f["dport"]].filter(Boolean).join("/") || "any";
    const from = f["source"] ? ` from ${String(f["source"])}` : "";
    return `${String(f["type"]).toUpperCase()} ${String(f["action"])} ${what}${from}`;
  }

  private async listFirewallRules(accountId: string): Promise<ResourceInstance[]> {
    const rules =
      (await this.api.get<Array<Record<string, unknown>>>("/cluster/firewall/rules")) ?? [];
    return rules.map((r) => {
      const fields = this.mapFirewallRule(r);
      return this.instance(
        accountId,
        FW_RULE,
        String(fields["pos"]),
        `#${String(fields["pos"])} ${ProxmoxClient.describeRule(fields)}`,
        fields,
      );
    });
  }

  private async listSecurityGroups(accountId: string): Promise<ResourceInstance[]> {
    const groups =
      (await this.api.get<Array<{ group: string; comment?: string }>>(
        "/cluster/firewall/groups",
      )) ?? [];
    return mapLimit(groups, 6, async (g) => {
      const rules = await this.api
        .get<unknown[]>(`/cluster/firewall/groups/${seg(g.group)}`)
        .catch(() => [] as unknown[]);
      return this.instance(accountId, SECURITY_GROUP, g.group, g.group, {
        group: g.group,
        comment: g.comment ?? "",
        ruleCount: (rules ?? []).length,
      });
    });
  }

  private async listAliases(accountId: string): Promise<ResourceInstance[]> {
    const aliases =
      (await this.api.get<Array<{ name: string; cidr: string; comment?: string }>>(
        "/cluster/firewall/aliases",
      )) ?? [];
    return aliases.map((a) =>
      this.instance(
        accountId,
        FW_ALIAS,
        a.name,
        a.name,
        { name: a.name, cidr: a.cidr, comment: a.comment ?? "" },
        { resolvedOutputs: { cidr: a.cidr } },
      ),
    );
  }

  private async listIpsets(accountId: string): Promise<ResourceInstance[]> {
    const sets =
      (await this.api.get<Array<{ name: string; comment?: string }>>("/cluster/firewall/ipset")) ??
      [];
    return mapLimit(sets, 6, async (s) => {
      const entries =
        (await this.api
          .get<Array<{ cidr: string; nomatch?: number | boolean }>>(
            `/cluster/firewall/ipset/${seg(s.name)}`,
          )
          .catch(() => [])) ?? [];
      const list = entries.map((e) => `${truthy(e.nomatch) ? "!" : ""}${e.cidr}`);
      return this.instance(accountId, IPSET, s.name, s.name, {
        name: s.name,
        comment: s.comment ?? "",
        entries: list.join(", "),
        entryCount: list.length,
      });
    });
  }

  // ---------------------------------------------------------------------------
  // Outputs
  // ---------------------------------------------------------------------------

  async resolveOutput(
    typeId: string,
    resourceId: string,
    outputKey: string,
    _accountId: string,
  ): Promise<string> {
    const ext = externalIdOf(resourceId);
    if (typeId === VM || typeId === CT) {
      const loc = await this.locateGuest(ext);
      if (outputKey === "vmid") return String(loc.vmid);
      if (outputKey === "node") return loc.node;
      if (outputKey === "ipv4" || outputKey === "ipv6") {
        const addrs = await this.guestAddresses(loc);
        return addrs[outputKey];
      }
    }
    if (typeId === NODE) {
      if (outputKey === "nodeName") return ext;
      if (outputKey === "ip") {
        const status = await this.api.get<Array<Record<string, unknown>>>("/cluster/status");
        const n = (status ?? []).find((s) => s["type"] === "node" && s["name"] === ext);
        return String(n?.["ip"] ?? "");
      }
    }
    if (typeId === CLUSTER && outputKey === "apiUrl") return this.api.uiUrl;
    if (typeId === STORAGE && outputKey === "storage") return parseStorageExternalId(ext).storage;
    if (typeId === BACKUP && outputKey === "volid") return parseBackupExternalId(ext).volid;
    if (typeId === BACKUP_JOB && outputKey === "jobId") return ext;
    if (typeId === POOL && outputKey === "poolid") return ext;
    if (typeId === HA_RESOURCE && outputKey === "sid") return ext;
    if (typeId === SECURITY_GROUP && outputKey === "group") return ext;
    if (typeId === FW_ALIAS && outputKey === "cidr") {
      const a = await this.api.get<{ cidr?: string }>(`/cluster/firewall/aliases/${seg(ext)}`);
      return a?.cidr ?? "";
    }
    throw new Error(`Proxmox plugin: cannot resolve output "${outputKey}" for type "${typeId}"`);
  }

  /** IP addresses from the guest agent (VMs) or the container's interfaces. */
  async guestAddresses(loc: GuestLocation): Promise<{ ipv4: string; ipv6: string }> {
    if (loc.resource.status !== "running") return { ipv4: "", ipv6: "" };
    try {
      if (loc.kind === "qemu") {
        const r = await this.api.get<{ result?: Parameters<typeof pickAgentAddresses>[0] }>(
          `${this.guestPath(loc)}/agent/network-get-interfaces`,
        );
        return pickAgentAddresses(r?.result ?? []);
      }
      const r = await this.api.get<Parameters<typeof pickCtAddresses>[0]>(
        `${this.guestPath(loc)}/interfaces`,
      );
      return pickCtAddresses(r ?? []);
    } catch {
      // No guest agent / agent not running: no address, not an error.
      return { ipv4: "", ipv6: "" };
    }
  }

  // ---------------------------------------------------------------------------
  // Detail
  // ---------------------------------------------------------------------------

  async enrichDetail(resource: ResourceInstance): Promise<ResourceInstance> {
    const t = resource.resourceTypeId;
    const ext = resource.externalId ?? externalIdOf(resource.id);
    const data: ProxmoxEnrichment = {};
    const all = await this.clusterResources().catch(() => [] as PveClusterResource[]);
    data.nodes = all
      .filter((r) => r.type === "node" && r.status === "online")
      .map((r) => r.node as string)
      .sort();
    data.pools = [];
    if (t === VM || t === CT) {
      const loc = await this.locateGuest(ext);
      const path = this.guestPath(loc);
      const [snaps, rules, pools, cfg, backupStores, addrs] = await Promise.all([
        this.api.get<Array<Record<string, unknown>>>(`${path}/snapshot`).catch(() => []),
        this.api.get<Array<Record<string, unknown>>>(`${path}/firewall/rules`).catch(() => []),
        this.api.get<Array<{ poolid: string }>>("/pools").catch(() => []),
        this.api.get<PveConfig>(`${path}/config`).catch(() => undefined),
        this.storagesWithContent("backup").catch(() => []),
        this.guestAddresses(loc),
      ]);
      data.snapshots = (snaps ?? [])
        .filter((s) => s["name"] !== "current")
        .map((s) => ({
          name: String(s["name"]),
          description: String(s["description"] ?? "").trim(),
          time: epochIso(typeof s["snaptime"] === "number" ? (s["snaptime"] as number) : undefined),
          vmstate: truthy(s["vmstate"]),
          parent: String(s["parent"] ?? ""),
        }));
      data.firewallRules = (rules ?? []).map((r) => this.mapFirewallRule(r));
      data.pools = (pools ?? []).map((p) => p.poolid).sort();
      data.disks =
        cfg && loc.kind === "qemu"
          ? resizableVmDisks(cfg)
          : cfg
            ? Object.keys(cfg)
                .filter((k) => k === "rootfs" || /^mp\d+$/.test(k))
                .sort()
            : [];
      data.backupStorages = backupStores
        .map((s) => s.storage)
        .filter((v, i, a) => a.indexOf(v) === i);
      data.storages = (
        await this.storagesWithContent(loc.kind === "qemu" ? "images" : "rootdir").catch(() => [])
      )
        .map((s) => s.storage)
        .filter((v, i, a) => a.indexOf(v) === i);
      const resolvedOutputs = { ...resource.resolvedOutputs };
      if (addrs.ipv4) resolvedOutputs["ipv4"] = addrs.ipv4;
      if (addrs.ipv6) resolvedOutputs["ipv6"] = addrs.ipv6;
      return {
        ...resource,
        resolvedOutputs: { ...resolvedOutputs, [ENRICH_KEY]: JSON.stringify(data) },
      };
    }
    if (t === STORAGE) {
      const { node, storage } = parseStorageExternalId(ext);
      const [status, content] = await Promise.all([
        this.api
          .get<{ total?: number; used?: number; avail?: number }>(
            `/nodes/${seg(node)}/storage/${seg(storage)}/status`,
          )
          .catch(() => undefined),
        this.storageContent(node, storage).catch(() => []),
      ]);
      data.storageStatus = {
        totalGb: bytesToGib(status?.total),
        usedGb: bytesToGib(status?.used),
        availGb: bytesToGib(status?.avail),
      };
      data.content = content
        .filter((c) => c.content !== "backup")
        .slice(0, 200)
        .map((c) => ({
          volid: c.volid,
          content: c.content ?? "",
          format: c.format ?? "",
          sizeGb: bytesToGib(c.size),
          vmid: c.vmid !== undefined ? String(c.vmid) : "",
        }));
    }
    if (t === SECURITY_GROUP) {
      const rules = await this.api
        .get<Array<Record<string, unknown>>>(`/cluster/firewall/groups/${seg(ext)}`)
        .catch(() => []);
      data.firewallRules = (rules ?? []).map((r) => this.mapFirewallRule(r));
    }
    if (t === IPSET) {
      const entries = await this.api
        .get<Array<{ cidr: string; comment?: string; nomatch?: number }>>(
          `/cluster/firewall/ipset/${seg(ext)}`,
        )
        .catch(() => []);
      data.ipsetEntries = (entries ?? []).map((e) => ({
        cidr: e.cidr,
        comment: e.comment ?? "",
        nomatch: truthy(e.nomatch),
      }));
    }
    if (t === CLUSTER) {
      const [ha, notBacked, log] = await Promise.all([
        this.api.get<Array<Record<string, unknown>>>("/cluster/ha/status/current").catch(() => []),
        this.api
          .get<Array<{ vmid: number; name?: string; type: string }>>(
            "/cluster/backup-info/not-backed-up",
          )
          .catch(() => []),
        this.api
          .get<Array<{ time?: number; node?: string; user?: string; msg?: string; pri?: number }>>(
            "/cluster/log",
            { max: 30 },
          )
          .catch(() => []),
      ]);
      data.haStatus = (ha ?? [])
        .filter((h) => h["type"] !== "service")
        .map((h) => ({
          id: String(h["id"] ?? ""),
          node: String(h["node"] ?? ""),
          status: String(h["status"] ?? ""),
        }));
      data.notBackedUp = (notBacked ?? []).map((g) => ({
        vmid: String(g.vmid),
        name: g.name ?? "",
        type: g.type,
      }));
      data.clusterLog = (log ?? []).map((l) => ({
        time: epochIso(l.time),
        node: l.node ?? "",
        user: l.user ?? "",
        msg: l.msg ?? "",
      }));
    }
    if (t === HA_RESOURCE || t === BACKUP) {
      const stores =
        t === BACKUP ? await this.storagesWithContent(BACKUP_RESTORE_CONTENT(resource)) : [];
      data.storages = stores.map((s) => s.storage).filter((v, i, a) => a.indexOf(v) === i);
    }
    return {
      ...resource,
      resolvedOutputs: { ...resource.resolvedOutputs, [ENRICH_KEY]: JSON.stringify(data) },
    };
  }

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    return renderProxmoxDetail(resource, this.api.uiUrl);
  }

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    return renderProxmoxSidebar(resource);
  }

  async fetchDashboardStats(
    typeId: string,
    resourceId: string,
    _accountId: string,
  ): Promise<DashboardStat[]> {
    const ext = externalIdOf(resourceId);
    const all = await this.clusterResources();
    if (typeId === VM || typeId === CT) {
      const r = all.find((x) => x.vmid === Number(ext));
      if (!r) return [];
      const running = r.status === "running";
      return [
        {
          label: "Status",
          value: r.status ?? "unknown",
          variant: running ? "status-healthy" : "status-error",
        },
        { label: "CPU", value: running ? `${((r.cpu ?? 0) * 100).toFixed(1)}%` : "-" },
        {
          label: "Memory",
          value: running
            ? `${bytesToGib(r.mem)} / ${bytesToGib(r.maxmem)} GiB`
            : `${bytesToGib(r.maxmem)} GiB`,
        },
        { label: "Node", value: r.node ?? "" },
      ];
    }
    if (typeId === NODE) {
      const r = all.find((x) => x.type === "node" && x.node === ext);
      if (!r) return [];
      return [
        {
          label: "Status",
          value: r.status ?? "unknown",
          variant: r.status === "online" ? "status-healthy" : "status-error",
        },
        { label: "CPU", value: `${((r.cpu ?? 0) * 100).toFixed(1)}%` },
        { label: "Memory", value: `${bytesToGib(r.mem)} / ${bytesToGib(r.maxmem)} GiB` },
        {
          label: "Guests",
          value: String(
            all.filter((x) => (x.type === "qemu" || x.type === "lxc") && x.node === ext).length,
          ),
        },
      ];
    }
    if (typeId === STORAGE) {
      const { node, storage } = parseStorageExternalId(ext);
      const r = all.find((x) => x.type === "storage" && x.node === node && x.storage === storage);
      if (!r) return [];
      const pct = r.maxdisk ? ((r.disk ?? 0) / r.maxdisk) * 100 : 0;
      return [
        { label: "Used", value: `${bytesToGib(r.disk)} / ${bytesToGib(r.maxdisk)} GiB` },
        {
          label: "Usage",
          value: `${pct.toFixed(0)}%`,
          variant: pct > 90 ? "status-error" : pct > 75 ? "status-degraded" : "status-healthy",
        },
      ];
    }
    return [];
  }

  // ---------------------------------------------------------------------------
  // Metrics (RRD)
  // ---------------------------------------------------------------------------

  async fetchMetricSeries(
    typeId: string,
    resourceId: string,
    _accountId: string,
    timeRange?: { startMs: number; endMs: number },
  ): Promise<MetricSeries[]> {
    const ext = externalIdOf(resourceId);
    const now = Date.now();
    const startMs = timeRange?.startMs ?? now - 3_600_000;
    const endMs = timeRange?.endMs ?? now;
    const timeframe = rrdTimeframe(endMs - startMs);
    let path: string;
    if (typeId === NODE) path = `/nodes/${seg(ext)}/rrddata`;
    else if (typeId === VM || typeId === CT)
      path = `${this.guestPath(await this.locateGuest(ext))}/rrddata`;
    else if (typeId === STORAGE) {
      const { node, storage } = parseStorageExternalId(ext);
      path = `/nodes/${seg(node)}/storage/${seg(storage)}/rrddata`;
    } else return [];
    const rows =
      (await this.api.get<Array<Record<string, number>>>(path, { timeframe, cf: "AVERAGE" })) ?? [];
    const inRange = rows.filter((r) => {
      const t = (r["time"] ?? 0) * 1000;
      return t >= startMs - 60_000 && t <= endMs + 60_000;
    });
    return rrdToSeries(
      typeId === NODE ? "node" : typeId === STORAGE ? "storage" : "guest",
      inRange,
    );
  }

  // ---------------------------------------------------------------------------
  // Logs + describe
  // ---------------------------------------------------------------------------

  async getLogs(
    typeId: string,
    resourceId: string,
    _accountId: string,
    params: LogsFetchParams,
  ): Promise<LogsFetchResult> {
    const ext = externalIdOf(resourceId);
    const tail = Math.min(Math.max(params.tailLines ?? 200, 10), 5000);
    if (typeId === NODE) {
      const containers = ["System journal", "Recent tasks"];
      const active =
        params.container && containers.includes(params.container)
          ? params.container
          : containers[0]!;
      if (active === "System journal") {
        const lines =
          (await this.api.get<string[]>(`/nodes/${seg(ext)}/journal`, { lastentries: tail })) ?? [];
        return { text: lines.map((l) => `${l}\n`).join(""), containers, activeContainer: active };
      }
      const tasks =
        (await this.api.get<Array<Record<string, unknown>>>(`/nodes/${seg(ext)}/tasks`, {
          limit: 50,
        })) ?? [];
      return {
        text: tasks.map((t) => `${taskLine(t)}\n`).join(""),
        containers,
        activeContainer: active,
      };
    }
    if (typeId === VM || typeId === CT) {
      const loc = await this.locateGuest(ext);
      const tasks =
        (await this.api.get<Array<Record<string, unknown>>>(`/nodes/${seg(loc.node)}/tasks`, {
          vmid: loc.vmid,
          limit: 25,
          source: "all",
        })) ?? [];
      const containers = tasks.map((t) => `${taskLine(t)} · ${String(t["upid"])}`);
      if (containers.length === 0) {
        return {
          text: "No tasks recorded for this guest on its current node.\n",
          containers: [],
          activeContainer: "",
        };
      }
      const active =
        params.container && containers.includes(params.container)
          ? params.container
          : containers[0]!;
      const upid = active.slice(active.lastIndexOf("· ") + 2);
      const taskNode = upid.split(":")[1] ?? loc.node;
      const lines =
        (await this.api.get<Array<{ n: number; t: string }>>(
          `/nodes/${seg(taskNode)}/tasks/${seg(upid)}/log`,
          {
            limit: tail,
          },
        )) ?? [];
      return { text: lines.map((l) => `${l.t}\n`).join(""), containers, activeContainer: active };
    }
    return { text: "", containers: [], activeContainer: "" };
  }

  async describeResource(typeId: string, resourceId: string, _accountId: string): Promise<string> {
    const ext = externalIdOf(resourceId);
    if (typeId === VM || typeId === CT) {
      const loc = await this.locateGuest(ext);
      const cfg = (await this.api.get<PveConfig>(`${this.guestPath(loc)}/config`)) ?? {};
      return Object.keys(cfg)
        .filter((k) => k !== "digest")
        .sort()
        .map((k) => `${k}: ${String(cfg[k]).replace(/\n/g, "\n  ")}`)
        .join("\n");
    }
    if (typeId === BACKUP_JOB) {
      const job = await this.api.get<Record<string, unknown>>(`/cluster/backup/${seg(ext)}`);
      return Object.entries(job ?? {})
        .map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`)
        .join("\n");
    }
    if (typeId === STORAGE) {
      const { storage } = parseStorageExternalId(ext);
      const cfg = await this.api.get<Record<string, unknown>>(`/storage/${seg(storage)}`);
      return Object.entries(cfg ?? {})
        .filter(([k]) => k !== "digest")
        .map(([k, v]) => `${k}: ${String(v)}`)
        .join("\n");
    }
    return "";
  }

  // ---------------------------------------------------------------------------
  // Mutations
  // ---------------------------------------------------------------------------

  getCreateConfig(typeId: string): Promise<CreateResourceConfig> {
    return proxmoxCreateConfig(this, typeId);
  }

  createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceCreateReturn> {
    return proxmoxCreateResource(this, typeId, accountId, fields);
  }

  invokeAction(
    typeId: string,
    resourceId: string,
    actionId: string,
    _accountId: string,
  ): Promise<void> {
    return proxmoxInvokeAction(this, typeId, resourceId, actionId);
  }

  executeNoSqlCommand(
    typeId: string,
    resourceId: string,
    _accountId: string,
    command: string,
    args: (string | number)[],
  ): Promise<unknown> {
    return proxmoxPromptCommand(this, typeId, resourceId, command, args);
  }

  verifyCredentials(): Promise<PreflightResult> {
    return proxmoxVerifyCredentials(this.api);
  }

  async deleteResource(typeId: string, resourceId: string, _accountId: string): Promise<void> {
    const ext = externalIdOf(resourceId);
    switch (typeId) {
      case VM:
      case CT: {
        const loc = await this.locateGuest(ext);
        if (loc.resource.status === "running") {
          throw new ProxmoxApiError(
            `Stop ${loc.kind === "qemu" ? "the VM" : "the container"} before deleting it.`,
            409,
          );
        }
        const upid = await this.api.delete<string>(this.guestPath(loc), {
          purge: true,
          "destroy-unreferenced-disks": true,
        });
        if (typeof upid === "string")
          await this.api.waitForTask(loc.node, upid, { timeoutMs: 60_000 });
        break;
      }
      case BACKUP: {
        const { node, storage, volid } = parseBackupExternalId(ext);
        await this.api.delete(`/nodes/${seg(node)}/storage/${seg(storage)}/content/${seg(volid)}`);
        break;
      }
      case BACKUP_JOB:
        await this.api.delete(`/cluster/backup/${seg(ext)}`);
        break;
      case POOL:
        await this.api.delete("/pools", { poolid: ext });
        break;
      case HA_RESOURCE:
        await this.api.delete(`/cluster/ha/resources/${seg(ext)}`);
        break;
      case HA_RULE:
        await this.api.delete(`/cluster/ha/rules/${seg(ext)}`);
        break;
      case FW_RULE:
        await this.api.delete(`/cluster/firewall/rules/${seg(ext)}`);
        break;
      case SECURITY_GROUP:
        await this.api.delete(`/cluster/firewall/groups/${seg(ext)}`);
        break;
      case FW_ALIAS:
        await this.api.delete(`/cluster/firewall/aliases/${seg(ext)}`);
        break;
      case IPSET:
        await this.api.delete(`/cluster/firewall/ipset/${seg(ext)}`, { force: true });
        break;
      default:
        throw new Error(`Proxmox plugin: ${typeId} cannot be deleted`);
    }
    this.invalidate();
  }

  async updateResource(
    typeId: string,
    resourceId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    const ext = externalIdOf(resourceId);
    const has = (k: string) => Object.prototype.hasOwnProperty.call(fields, k);
    const bool = (k: string) => (fields[k] === "true" || fields[k] === "1" ? 1 : 0);
    /** Set changed keys; clear the ones the user emptied via `delete`. */
    const build = (map: Record<string, string>, bools: string[] = []) => {
      const params: Record<string, FormValue> = {};
      const del: string[] = [];
      for (const [formKey, apiKey] of Object.entries(map)) {
        if (!has(formKey)) continue;
        const v = fields[formKey] ?? "";
        if (bools.includes(formKey)) params[apiKey] = bool(formKey);
        else if (v === "") del.push(apiKey);
        else params[apiKey] = v;
      }
      if (del.length) params["delete"] = del.join(",");
      return params;
    };

    switch (typeId) {
      case CLUSTER: {
        const params = build(
          {
            firewallEnabled: "enable",
            firewallPolicyIn: "policy_in",
            firewallPolicyOut: "policy_out",
          },
          ["firewallEnabled"],
        );
        if (Object.keys(params).length) await this.api.put("/cluster/firewall/options", params);
        break;
      }
      case VM: {
        const loc = await this.locateGuest(ext);
        const params = build(
          {
            name: "name",
            cores: "cores",
            sockets: "sockets",
            memoryMb: "memory",
            balloonMb: "balloon",
            cpuType: "cpu",
            ostype: "ostype",
            agent: "agent",
            onboot: "onboot",
            protection: "protection",
            tags: "tags",
            description: "description",
          },
          ["agent", "onboot", "protection"],
        );
        if (Object.keys(params).length) await this.api.put(`${this.guestPath(loc)}/config`, params);
        break;
      }
      case CT: {
        const loc = await this.locateGuest(ext);
        const params = build(
          {
            name: "hostname",
            cores: "cores",
            memoryMb: "memory",
            swapMb: "swap",
            features: "features",
            onboot: "onboot",
            protection: "protection",
            tags: "tags",
            description: "description",
          },
          ["onboot", "protection"],
        );
        if (Object.keys(params).length) await this.api.put(`${this.guestPath(loc)}/config`, params);
        break;
      }
      case STORAGE: {
        const { storage } = parseStorageExternalId(ext);
        const params: Record<string, FormValue> = {};
        if (has("content") && fields["content"]) params["content"] = fields["content"];
        if (has("enabled")) params["disable"] = bool("enabled") ? 0 : 1;
        if (Object.keys(params).length) await this.api.put(`/storage/${seg(storage)}`, params);
        break;
      }
      case BACKUP: {
        const { node, storage, volid } = parseBackupExternalId(ext);
        const params: Record<string, FormValue> = {};
        if (has("notes")) params["notes"] = fields["notes"] ?? "";
        if (has("protected")) params["protected"] = bool("protected");
        if (Object.keys(params).length) {
          await this.api.put(
            `/nodes/${seg(node)}/storage/${seg(storage)}/content/${seg(volid)}`,
            params,
          );
        }
        break;
      }
      case BACKUP_JOB: {
        const params = build(
          {
            schedule: "schedule",
            storage: "storage",
            selection: "vmid",
            all: "all",
            exclude: "exclude",
            pool: "pool",
            node: "node",
            mode: "mode",
            compress: "compress",
            enabled: "enabled",
            comment: "comment",
            notesTemplate: "notes-template",
            pruneBackups: "prune-backups",
            repeatMissed: "repeat-missed",
          },
          ["all", "enabled", "repeatMissed"],
        );
        if (Object.keys(params).length) await this.api.put(`/cluster/backup/${seg(ext)}`, params);
        break;
      }
      case POOL:
        if (has("comment"))
          await this.api.put("/pools", { poolid: ext, comment: fields["comment"] ?? "" });
        break;
      case HA_RESOURCE: {
        const params = build(
          {
            state: "state",
            maxRestart: "max_restart",
            maxRelocate: "max_relocate",
            failback: "failback",
            comment: "comment",
          },
          ["failback"],
        );
        if (Object.keys(params).length)
          await this.api.put(`/cluster/ha/resources/${seg(ext)}`, params);
        break;
      }
      case HA_RULE: {
        const current = await this.api.get<Record<string, unknown>>(
          `/cluster/ha/rules/${seg(ext)}`,
        );
        const params = build(
          {
            resources: "resources",
            nodes: "nodes",
            affinity: "affinity",
            strict: "strict",
            disable: "disable",
            comment: "comment",
          },
          ["strict", "disable"],
        );
        params["type"] = String(current?.["type"] ?? "");
        if (params["type"] !== "node-affinity") {
          delete params["nodes"];
          delete params["strict"];
        }
        await this.api.put(`/cluster/ha/rules/${seg(ext)}`, params);
        break;
      }
      case FW_RULE: {
        const params = build(
          {
            type: "type",
            action: "action",
            enable: "enable",
            macro: "macro",
            proto: "proto",
            source: "source",
            dest: "dest",
            sport: "sport",
            dport: "dport",
            iface: "iface",
            log: "log",
            comment: "comment",
          },
          ["enable"],
        );
        if (Object.keys(params).length)
          await this.api.put(`/cluster/firewall/rules/${seg(ext)}`, params);
        break;
      }
      case SECURITY_GROUP:
        if (has("comment")) {
          await this.api.post("/cluster/firewall/groups", {
            group: ext,
            rename: ext,
            comment: fields["comment"] ?? "",
          });
        }
        break;
      case FW_ALIAS: {
        const current = await this.api.get<{ cidr?: string; comment?: string }>(
          `/cluster/firewall/aliases/${seg(ext)}`,
        );
        await this.api.put(`/cluster/firewall/aliases/${seg(ext)}`, {
          cidr: has("cidr") ? fields["cidr"] : current?.cidr,
          comment: has("comment") ? fields["comment"] : current?.comment,
        });
        break;
      }
      case IPSET:
        if (has("comment")) {
          await this.api.post("/cluster/firewall/ipset", {
            name: ext,
            rename: ext,
            comment: fields["comment"] ?? "",
          });
        }
        break;
      default:
        throw new Error(`Proxmox plugin: ${typeId} cannot be edited`);
    }
    this.invalidate();
    return this.getResource(typeId, resourceId, accountId);
  }
}

/** Restores can target any storage that holds guest disks. */
function BACKUP_RESTORE_CONTENT(resource: ResourceInstance): string {
  return resource.fields["guestType"] === "lxc" ? "rootdir" : "images";
}

function taskLine(t: Record<string, unknown>): string {
  const start = epochIso(
    typeof t["starttime"] === "number" ? (t["starttime"] as number) : undefined,
  )
    .slice(0, 19)
    .replace("T", " ");
  const id = t["id"] ? ` ${String(t["id"])}` : "";
  return `${start} ${String(t["type"] ?? "")}${id} ${String(t["user"] ?? "")} ${String(t["status"] ?? "running")}`;
}

/** RRD rows to chart series. Guest and node CPU are fractions; charts want percent. */
export function rrdToSeries(
  kind: "node" | "guest" | "storage",
  rows: Array<Record<string, number>>,
): MetricSeries[] {
  const series = (
    label: string,
    unit: string,
    pick: (r: Record<string, number>) => number | undefined,
  ): MetricSeries | null => {
    const points = rows
      .map((r) => ({ timestamp: (r["time"] ?? 0) * 1000, value: pick(r) }))
      .filter(
        (p): p is { timestamp: number; value: number } =>
          typeof p.value === "number" && Number.isFinite(p.value),
      );
    return points.length ? { label, unit, points } : null;
  };
  const pct = (a?: number, b?: number) => (a !== undefined && b ? (a / b) * 100 : undefined);
  const out: Array<MetricSeries | null> = [];
  if (kind === "storage") {
    out.push(
      series("Used", "GiB", (r) => (r["used"] !== undefined ? bytesToGib(r["used"]) : undefined)),
    );
    out.push(
      series("Total", "GiB", (r) =>
        r["total"] !== undefined ? bytesToGib(r["total"]) : undefined,
      ),
    );
    out.push(series("Usage", "%", (r) => pct(r["used"], r["total"])));
  } else if (kind === "node") {
    out.push(
      series("CPU Utilization", "%", (r) => (r["cpu"] !== undefined ? r["cpu"] * 100 : undefined)),
    );
    out.push(
      series("IO Wait", "%", (r) => (r["iowait"] !== undefined ? r["iowait"] * 100 : undefined)),
    );
    out.push(series("Load Average", "", (r) => r["loadavg"]));
    out.push(series("Memory Used", "%", (r) => pct(r["memused"], r["memtotal"])));
    out.push(series("Swap Used", "%", (r) => pct(r["swapused"], r["swaptotal"])));
    out.push(series("Root Disk Used", "%", (r) => pct(r["rootused"], r["roottotal"])));
    out.push(series("Network In", "bytes/s", (r) => r["netin"]));
    out.push(series("Network Out", "bytes/s", (r) => r["netout"]));
    out.push(series("CPU Pressure", "%", (r) => r["pressurecpusome"]));
    out.push(series("IO Pressure", "%", (r) => r["pressureiosome"]));
    out.push(series("Memory Pressure", "%", (r) => r["pressurememorysome"]));
  } else {
    out.push(
      series("CPU Utilization", "%", (r) => (r["cpu"] !== undefined ? r["cpu"] * 100 : undefined)),
    );
    out.push(series("Memory Used", "%", (r) => pct(r["mem"], r["maxmem"])));
    out.push(series("Memory Used (bytes)", "bytes", (r) => r["mem"]));
    out.push(series("Network In", "bytes/s", (r) => r["netin"]));
    out.push(series("Network Out", "bytes/s", (r) => r["netout"]));
    out.push(series("Disk Read", "bytes/s", (r) => r["diskread"]));
    out.push(series("Disk Write", "bytes/s", (r) => r["diskwrite"]));
    out.push(series("CPU Pressure", "%", (r) => r["pressurecpusome"]));
    out.push(series("IO Pressure", "%", (r) => r["pressureiosome"]));
  }
  return out.filter((s): s is MetricSeries => s !== null);
}

export { resourceTypes };
