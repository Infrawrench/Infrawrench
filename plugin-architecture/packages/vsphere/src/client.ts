import type {
  CreateResourceConfig,
  DashboardStat,
  DetailViewSchema,
  HostServices,
  PluginClient,
  ResourceCreateReturn,
  ResourceInstance,
  SidebarItemSchema,
} from "@infrawrench/plugin-base";
import { decodePromptArgs, externalIdOf } from "@infrawrench/plugin-base";
import { VsphereApi, VsphereApiError, type Query } from "./api.js";
import {
  CLUSTER,
  CUSTOMIZATION_SPEC,
  DATACENTER,
  DATASTORE,
  FOLDER,
  HOST,
  LIBRARY,
  LIBRARY_ITEM,
  NETWORK,
  RESOURCE_POOL,
  TAG,
  TAG_CATEGORY,
  VCENTER,
  VM,
} from "./resources.js";
import {
  ENRICH_KEY,
  renderVsphereDetail,
  renderVsphereSidebar,
  type VsphereEnrichment,
} from "./render.js";
import { vsphereCreateConfig, vsphereCreateResource } from "./create.js";

const GIB = 1024 ** 3;
const gib = (bytes: number | undefined) =>
  bytes && Number.isFinite(bytes) ? Math.round((bytes / GIB) * 10) / 10 : 0;
const seg = (s: string) => encodeURIComponent(s);
const CACHE_MS = 10_000;

export interface VmSummary {
  vm: string;
  name: string;
  power_state: string;
  cpu_count?: number;
  memory_size_MiB?: number;
  memory_size_mib?: number;
}

export interface VmInfo {
  name?: string;
  guest_OS?: string;
  guest_os?: string;
  power_state?: string;
  identity?: { name?: string; bios_uuid?: string; instance_uuid?: string };
  hardware?: { version?: string };
  cpu?: {
    count?: number;
    cores_per_socket?: number;
    hot_add_enabled?: boolean;
    hot_remove_enabled?: boolean;
  };
  memory?: { size_MiB?: number; size_mib?: number; hot_add_enabled?: boolean };
  disks?: Record<string, { label?: string; capacity?: number; backing?: { vmdk_file?: string } }>;
  nics?: Record<
    string,
    {
      label?: string;
      mac_address?: string;
      state?: string;
      backing?: { network?: string; network_name?: string };
    }
  >;
  cdroms?: Record<string, { label?: string; backing?: { iso_file?: string; type?: string } }>;
}

/** `[datastore1] web01/web01.vmdk` → `datastore1`. */
export function datastoreOfVmdk(path: string | undefined): string {
  const m = /^\[([^\]]+)\]/.exec(path ?? "");
  return m?.[1] ?? "";
}

export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        results[i] = await fn(items[i] as T);
      }
    }),
  );
  return results;
}

export class VsphereClient implements PluginClient {
  readonly api: VsphereApi;
  private readonly cache = new Map<string, { at: number; p: Promise<unknown> }>();

  constructor(credentials: Record<string, string>, services?: HostServices) {
    const url = credentials["url"] ?? "";
    const username = credentials["username"] ?? "";
    if (!url) throw new Error("vSphere plugin: missing url credential");
    if (!username) throw new Error("vSphere plugin: missing username credential");
    this.api = new VsphereApi(
      {
        url,
        username,
        password: credentials["password"] ?? "",
        ...(credentials["caCert"] ? { caCert: credentials["caCert"] } : {}),
      },
      services?.http,
    );
  }

  /** Short-lived memo for list calls shared across one sync pass. */
  cached<T>(path: string, query?: Query): Promise<T> {
    const key = `${path}?${JSON.stringify(query ?? {})}`;
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.p as Promise<T>;
    const p = this.api.get<T>(path, query);
    p.catch(() => this.cache.delete(key));
    this.cache.set(key, { at: Date.now(), p });
    return p;
  }

  invalidate(): void {
    this.cache.clear();
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
      pluginId: "vsphere",
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
  // Shared inventory lookups
  // ---------------------------------------------------------------------------

  vms(): Promise<VmSummary[]> {
    return this.cached<VmSummary[]>("/vcenter/vm").then((r) => r ?? []);
  }
  hosts(
    query?: Query,
  ): Promise<
    Array<{ host: string; name: string; connection_state: string; power_state?: string }>
  > {
    return this.cached<
      Array<{ host: string; name: string; connection_state: string; power_state?: string }>
    >("/vcenter/host", query).then((r) => r ?? []);
  }
  clusters(
    query?: Query,
  ): Promise<
    Array<{ cluster: string; name: string; ha_enabled?: boolean; drs_enabled?: boolean }>
  > {
    return this.cached<
      Array<{ cluster: string; name: string; ha_enabled?: boolean; drs_enabled?: boolean }>
    >("/vcenter/cluster", query).then((r) => r ?? []);
  }
  datacenters(): Promise<Array<{ datacenter: string; name: string }>> {
    return this.cached<Array<{ datacenter: string; name: string }>>("/vcenter/datacenter").then(
      (r) => r ?? [],
    );
  }
  datastores(): Promise<
    Array<{
      datastore: string;
      name: string;
      type?: string;
      free_space?: number;
      capacity?: number;
    }>
  > {
    return this.cached<
      Array<{
        datastore: string;
        name: string;
        type?: string;
        free_space?: number;
        capacity?: number;
      }>
    >("/vcenter/datastore").then((r) => r ?? []);
  }
  networks(): Promise<Array<{ network: string; name: string; type: string }>> {
    return this.cached<Array<{ network: string; name: string; type: string }>>(
      "/vcenter/network",
    ).then((r) => r ?? []);
  }
  resourcePools(query?: Query): Promise<Array<{ resource_pool: string; name: string }>> {
    return this.cached<Array<{ resource_pool: string; name: string }>>(
      "/vcenter/resource-pool",
      query,
    ).then((r) => r ?? []);
  }
  folders(query?: Query): Promise<Array<{ folder: string; name: string; type: string }>> {
    return this.cached<Array<{ folder: string; name: string; type: string }>>(
      "/vcenter/folder",
      query,
    ).then((r) => r ?? []);
  }

  async libraries(): Promise<
    Array<{
      id: string;
      name?: string;
      type?: string;
      description?: string;
      storage_backings?: Array<{ datastore_id?: string }>;
      publish_info?: { published?: boolean };
      subscription_info?: { subscription_url?: string };
    }>
  > {
    const ids = (await this.cached<string[]>("/content/library")) ?? [];
    return mapLimit(ids, 6, async (id) => ({
      ...((await this.cached<Record<string, unknown>>(`/content/library/${seg(id)}`)) ?? {}),
      id,
    }));
  }

  async libraryItems(libraryId: string): Promise<
    Array<{
      id: string;
      name?: string;
      type?: string;
      size?: number;
      description?: string;
      cached?: boolean;
      creation_time?: string;
      last_modified_time?: string;
      library_id?: string;
    }>
  > {
    const ids =
      (await this.cached<string[]>("/content/library/item", { library_id: libraryId })) ?? [];
    return mapLimit(ids, 6, async (id) => ({
      ...((await this.cached<Record<string, unknown>>(`/content/library/item/${seg(id)}`)) ?? {}),
      id,
    }));
  }

  /** VM id → host/cluster/pool, from the inventory filters (the VM info omits placement). */
  async vmPlacement(): Promise<Map<string, { host: string; cluster: string; pool: string }>> {
    const [hosts, clusters, pools] = await Promise.all([
      this.hosts().catch(() => []),
      this.clusters().catch(() => []),
      this.resourcePools().catch(() => []),
    ]);
    const out = new Map<string, { host: string; cluster: string; pool: string }>();
    const get = (vm: string) => {
      let v = out.get(vm);
      if (!v) {
        v = { host: "", cluster: "", pool: "" };
        out.set(vm, v);
      }
      return v;
    };
    await mapLimit(hosts, 4, async (h) => {
      for (const vm of await this.cached<VmSummary[]>("/vcenter/vm", { hosts: h.host }).catch(
        () => [],
      ))
        get(vm.vm).host = h.host;
    });
    await mapLimit(clusters, 4, async (c) => {
      for (const vm of await this.cached<VmSummary[]>("/vcenter/vm", { clusters: c.cluster }).catch(
        () => [],
      ))
        get(vm.vm).cluster = c.cluster;
    });
    // A VM matches its pool and every ancestor; keep the smallest matching pool.
    const sizes = new Map<string, number>();
    await mapLimit(pools, 4, async (p) => {
      const list = await this.cached<VmSummary[]>("/vcenter/vm", {
        resource_pools: p.resource_pool,
      }).catch(() => []);
      sizes.set(p.resource_pool, list.length);
      for (const vm of list) {
        const cur = get(vm.vm);
        if (!cur.pool || (sizes.get(cur.pool) ?? Infinity) > list.length)
          cur.pool = p.resource_pool;
      }
    });
    return out;
  }

  // ---------------------------------------------------------------------------
  // Listing
  // ---------------------------------------------------------------------------

  async listResources(typeId: string, accountId: string): Promise<ResourceInstance[]> {
    switch (typeId) {
      case VCENTER:
        return this.listVcenter(accountId);
      case DATACENTER:
        return (await this.datacenters()).map((d) =>
          this.instance(
            accountId,
            DATACENTER,
            d.datacenter,
            d.name,
            { name: d.name },
            { resolvedOutputs: { datacenterId: d.datacenter } },
          ),
        );
      case CLUSTER:
        return this.listClusters(accountId);
      case HOST:
        return this.listHosts(accountId);
      case VM:
        return this.listVms(accountId);
      case DATASTORE:
        return this.listDatastores(accountId);
      case NETWORK:
        return (await this.networks()).map((n) =>
          this.instance(
            accountId,
            NETWORK,
            n.network,
            n.name,
            { name: n.name, type: n.type },
            { resolvedOutputs: { networkId: n.network } },
          ),
        );
      case RESOURCE_POOL:
        return this.listResourcePools(accountId);
      case FOLDER:
        return (await this.folders()).map((fo) =>
          this.instance(
            accountId,
            FOLDER,
            fo.folder,
            fo.name,
            { name: fo.name, type: fo.type },
            { resolvedOutputs: { folderId: fo.folder } },
          ),
        );
      case LIBRARY:
        return this.listLibraries(accountId);
      case LIBRARY_ITEM:
        return this.listLibraryItems(accountId);
      case TAG_CATEGORY:
        return this.listCategories(accountId);
      case TAG:
        return this.listTags(accountId);
      case CUSTOMIZATION_SPEC: {
        const specs =
          (await this.api.get<
            Array<{ name: string; description?: string; os_type?: string; last_modified?: string }>
          >("/vcenter/guest/customization-specs")) ?? [];
        return specs.map((s) =>
          this.instance(accountId, CUSTOMIZATION_SPEC, s.name, s.name, {
            name: s.name,
            description: s.description ?? "",
            osType: s.os_type ?? "",
            modifiedAt: s.last_modified ?? "",
          }),
        );
      }
      default:
        throw new Error(`vSphere plugin: unknown resource type "${typeId}"`);
    }
  }

  async getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<ResourceInstance> {
    const ext = externalIdOf(resourceId);
    if (typeId === VM) {
      const summary = (await this.vms()).find((v) => v.vm === ext);
      if (!summary) throw new VsphereApiError(`vSphere VM ${ext} not found`, 404);
      const placement = await this.vmPlacement().catch(() => new Map());
      const tags = await this.tagsFor([ext]).catch(() => new Map<string, string[]>());
      return this.mapVm(
        accountId,
        summary,
        await this.api.get<VmInfo>(`/vcenter/vm/${seg(ext)}`).catch(() => undefined),
        placement.get(ext),
        tags.get(ext),
      );
    }
    const all = await this.listResources(typeId, accountId);
    const found = all.find((r) => r.externalId === ext);
    if (!found) throw new VsphereApiError(`vSphere ${typeId} ${ext} not found`, 404);
    return found;
  }

  private async listVcenter(accountId: string): Promise<ResourceInstance[]> {
    const [version, health] = await Promise.all([
      this.api
        .get<{ version?: string; product?: string; build?: string; releasedate?: string }>(
          "/appliance/system/version",
        )
        .catch(() => undefined),
      this.api.get<string>("/appliance/health/system").catch(() => "unknown"),
    ]);
    const name = version?.product ?? "vCenter Server";
    return [
      this.instance(
        accountId,
        VCENTER,
        "vcenter",
        name,
        {
          product: version?.product ?? "",
          version: version?.version ?? "",
          build: version?.build ?? "",
          releaseDate: version?.releasedate ?? "",
          health: typeof health === "string" ? health.toLowerCase() : "unknown",
        },
        { resolvedOutputs: { url: this.api.baseUrl } },
      ),
    ];
  }

  private async listClusters(accountId: string): Promise<ResourceInstance[]> {
    const [clusters, dcs] = await Promise.all([
      this.clusters(),
      this.datacenters().catch(() => []),
    ]);
    const dcOf = new Map<string, string>();
    await mapLimit(dcs, 4, async (d) => {
      for (const c of await this.clusters({ datacenters: d.datacenter }).catch(() => []))
        dcOf.set(c.cluster, d.datacenter);
    });
    return mapLimit(clusters, 6, async (c) => {
      const [detail, hosts] = await Promise.all([
        this.api
          .get<{ resource_pool?: string }>(`/vcenter/cluster/${seg(c.cluster)}`)
          .catch(() => undefined),
        this.hosts({ clusters: c.cluster }).catch(() => []),
      ]);
      return this.instance(
        accountId,
        CLUSTER,
        c.cluster,
        c.name,
        {
          name: c.name,
          haEnabled: !!c.ha_enabled,
          drsEnabled: !!c.drs_enabled,
          hostCount: hosts.length,
          datacenterId: dcOf.get(c.cluster) ?? "",
          resourcePoolId: detail?.resource_pool ?? "",
        },
        { resolvedOutputs: { clusterId: c.cluster } },
      );
    });
  }

  private async listHosts(accountId: string): Promise<ResourceInstance[]> {
    const [hosts, clusters, dcs] = await Promise.all([
      this.hosts(),
      this.clusters().catch(() => []),
      this.datacenters().catch(() => []),
    ]);
    const clusterOf = new Map<string, string>();
    const dcOf = new Map<string, string>();
    await mapLimit(clusters, 4, async (c) => {
      for (const h of await this.hosts({ clusters: c.cluster }).catch(() => []))
        clusterOf.set(h.host, c.cluster);
    });
    await mapLimit(dcs, 4, async (d) => {
      for (const h of await this.hosts({ datacenters: d.datacenter }).catch(() => []))
        dcOf.set(h.host, d.datacenter);
    });
    return mapLimit(hosts, 4, async (h) => {
      const vms = await this.cached<VmSummary[]>("/vcenter/vm", { hosts: h.host }).catch(() => []);
      return this.instance(
        accountId,
        HOST,
        h.host,
        h.name,
        {
          name: h.name,
          connectionState: h.connection_state,
          powerState: h.power_state ?? "",
          clusterId: clusterOf.get(h.host) ?? "",
          datacenterId: dcOf.get(h.host) ?? "",
          vmCount: vms.length,
        },
        { resolvedOutputs: { hostname: h.name, hostId: h.host } },
      );
    });
  }

  async tagsFor(objectIds: string[], type = "VirtualMachine"): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>();
    if (objectIds.length === 0) return out;
    const [assoc, tagIds] = await Promise.all([
      this.api.post<Array<{ object_id: { id: string }; tag_ids: string[] }>>(
        "/cis/tagging/tag-association",
        { object_ids: objectIds.map((id) => ({ type, id })) },
        { action: "list-attached-tags-on-objects" },
      ),
      this.cached<string[]>("/cis/tagging/tag").catch(() => [] as string[]),
    ]);
    const names = new Map<string, string>();
    await mapLimit(tagIds ?? [], 8, async (id) => {
      const t = await this.cached<{ name?: string }>(`/cis/tagging/tag/${seg(id)}`).catch(
        () => undefined,
      );
      if (t?.name) names.set(id, t.name);
    });
    for (const a of assoc ?? [])
      out.set(
        a.object_id.id,
        a.tag_ids.map((t) => names.get(t) ?? t),
      );
    return out;
  }

  mapVm(
    accountId: string,
    s: VmSummary,
    info: VmInfo | undefined,
    placement: { host: string; cluster: string; pool: string } | undefined,
    tags: string[] | undefined,
  ): ResourceInstance {
    const disks = Object.values(info?.disks ?? {});
    const nics = Object.values(info?.nics ?? {});
    const capacity = disks.reduce((sum, d) => sum + (d.capacity ?? 0), 0);
    const datastores = [
      ...new Set(disks.map((d) => datastoreOfVmdk(d.backing?.vmdk_file)).filter(Boolean)),
    ];
    const fields: Record<string, string | number | boolean> = {
      name: s.name,
      powerState: s.power_state,
      cpuCount: info?.cpu?.count ?? s.cpu_count ?? 0,
      memoryMb:
        info?.memory?.size_MiB ??
        info?.memory?.size_mib ??
        s.memory_size_MiB ??
        s.memory_size_mib ??
        0,
      hostId: placement?.host ?? "",
      clusterId: placement?.cluster ?? "",
      resourcePoolId: placement?.pool ?? "",
      tags: (tags ?? []).join(", "),
    };
    if (info) {
      fields["coresPerSocket"] = info.cpu?.cores_per_socket ?? 1;
      fields["cpuHotAdd"] = !!info.cpu?.hot_add_enabled;
      fields["memoryHotAdd"] = !!info.memory?.hot_add_enabled;
      fields["guestOs"] = info.guest_OS ?? info.guest_os ?? "";
      fields["hardwareVersion"] = info.hardware?.version ?? "";
      fields["diskGb"] = gib(capacity);
      fields["disks"] = disks.map((d) => `${d.label ?? "disk"} ${gib(d.capacity)} GiB`).join(", ");
      fields["datastores"] = datastores.join(", ");
      fields["networkIds"] = [
        ...new Set(nics.map((n) => n.backing?.network ?? "").filter(Boolean)),
      ].join(", ");
      fields["instanceUuid"] = info.identity?.instance_uuid ?? "";
    }
    return this.instance(accountId, VM, s.vm, s.name, fields, { resolvedOutputs: { vmId: s.vm } });
  }

  private async listVms(accountId: string): Promise<ResourceInstance[]> {
    const vms = await this.vms();
    const [placement, tags] = await Promise.all([
      this.vmPlacement().catch(
        () => new Map<string, { host: string; cluster: string; pool: string }>(),
      ),
      this.tagsFor(vms.map((v) => v.vm)).catch(() => new Map<string, string[]>()),
    ]);
    return mapLimit(vms, 8, async (s) => {
      const info = await this.api.get<VmInfo>(`/vcenter/vm/${seg(s.vm)}`).catch(() => undefined);
      return this.mapVm(accountId, s, info, placement.get(s.vm), tags.get(s.vm));
    });
  }

  private async listDatastores(accountId: string): Promise<ResourceInstance[]> {
    const list = await this.datastores();
    return mapLimit(list, 6, async (d) => {
      const detail = await this.api
        .get<{
          accessible?: boolean;
          multiple_host_access?: boolean;
          thin_provisioning_supported?: boolean;
        }>(`/vcenter/datastore/${seg(d.datastore)}`)
        .catch(() => undefined);
      return this.instance(
        accountId,
        DATASTORE,
        d.datastore,
        d.name,
        {
          name: d.name,
          type: d.type ?? "",
          capacityGb: gib(d.capacity),
          accessible: detail?.accessible ?? true,
          multipleHostAccess: !!detail?.multiple_host_access,
          thinProvisioning: !!detail?.thin_provisioning_supported,
        },
        { resolvedOutputs: { datastoreId: d.datastore } },
      );
    });
  }

  private async listResourcePools(accountId: string): Promise<ResourceInstance[]> {
    const pools = await this.resourcePools();
    type Alloc = {
      reservation?: number;
      limit?: number;
      expandable_reservation?: boolean;
      shares?: { level?: string };
    };
    const details = await mapLimit(pools, 6, async (p) => ({
      p,
      d: await this.api
        .get<{
          name?: string;
          resource_pools?: string[];
          cpu_allocation?: Alloc;
          memory_allocation?: Alloc;
        }>(`/vcenter/resource-pool/${seg(p.resource_pool)}`)
        .catch(() => undefined),
    }));
    const parentOf = new Map<string, string>();
    for (const { p, d } of details)
      for (const child of d?.resource_pools ?? []) parentOf.set(child, p.resource_pool);
    return details.map(({ p, d }) => {
      const fields: Record<string, string | number | boolean> = {
        name: p.name,
        parentId: parentOf.get(p.resource_pool) ?? "",
        childCount: d?.resource_pools?.length ?? 0,
      };
      const c = d?.cpu_allocation;
      const m = d?.memory_allocation;
      if (c) {
        fields["cpuReservationMhz"] = c.reservation ?? 0;
        fields["cpuLimitMhz"] = c.limit ?? -1;
        fields["cpuExpandable"] = !!c.expandable_reservation;
        fields["cpuShares"] = c.shares?.level ?? "NORMAL";
      }
      if (m) {
        fields["memoryReservationMb"] = m.reservation ?? 0;
        fields["memoryLimitMb"] = m.limit ?? -1;
        fields["memoryExpandable"] = !!m.expandable_reservation;
        fields["memoryShares"] = m.shares?.level ?? "NORMAL";
      }
      return this.instance(accountId, RESOURCE_POOL, p.resource_pool, p.name, fields, {
        resolvedOutputs: { resourcePoolId: p.resource_pool },
      });
    });
  }

  private async listLibraries(accountId: string): Promise<ResourceInstance[]> {
    const libs = await this.libraries();
    return mapLimit(libs, 4, async (l) => {
      const items =
        (await this.cached<string[]>("/content/library/item", { library_id: l.id }).catch(
          () => [],
        )) ?? [];
      const name = l.name ?? l.id;
      return this.instance(
        accountId,
        LIBRARY,
        l.id,
        name,
        {
          name,
          description: l.description ?? "",
          type: l.type ?? "LOCAL",
          datastoreIds: (l.storage_backings ?? [])
            .map((b) => b.datastore_id ?? "")
            .filter(Boolean)
            .join(", "),
          published: !!l.publish_info?.published,
          subscriptionUrl: l.subscription_info?.subscription_url ?? "",
          itemCount: items.length,
        },
        { resolvedOutputs: { libraryId: l.id } },
      );
    });
  }

  private async listLibraryItems(accountId: string): Promise<ResourceInstance[]> {
    const libs = await this.libraries();
    const lists = await mapLimit(libs, 3, async (l) =>
      (await this.libraryItems(l.id).catch(() => [])).map((i) =>
        this.instance(
          accountId,
          LIBRARY_ITEM,
          i.id,
          i.name ?? i.id,
          {
            name: i.name ?? "",
            description: i.description ?? "",
            type: i.type ?? "",
            sizeGb: gib(i.size),
            libraryId: l.id,
            cached: !!i.cached,
            createdAt: i.creation_time ?? "",
            modifiedAt: i.last_modified_time ?? "",
          },
          {
            parentResourceId: `${accountId}:${LIBRARY}:${l.id}`,
            resolvedOutputs: { itemId: i.id },
          },
        ),
      ),
    );
    return lists.flat();
  }

  private async listCategories(accountId: string): Promise<ResourceInstance[]> {
    const ids = (await this.cached<string[]>("/cis/tagging/category")) ?? [];
    return mapLimit(ids, 8, async (id) => {
      const c = await this.cached<{
        name?: string;
        description?: string;
        cardinality?: string;
        associable_types?: string[];
      }>(`/cis/tagging/category/${seg(id)}`);
      return this.instance(
        accountId,
        TAG_CATEGORY,
        id,
        c?.name ?? id,
        {
          name: c?.name ?? "",
          description: c?.description ?? "",
          cardinality: c?.cardinality ?? "",
          associableTypes: (c?.associable_types ?? []).join(", "),
        },
        { resolvedOutputs: { categoryId: id } },
      );
    });
  }

  private async listTags(accountId: string): Promise<ResourceInstance[]> {
    const ids = (await this.cached<string[]>("/cis/tagging/tag")) ?? [];
    const categoryNames = new Map<string, string>();
    return mapLimit(ids, 8, async (id) => {
      const t = await this.cached<{ name?: string; description?: string; category_id?: string }>(
        `/cis/tagging/tag/${seg(id)}`,
      );
      const cid = t?.category_id ?? "";
      if (cid && !categoryNames.has(cid)) {
        const c = await this.cached<{ name?: string }>(`/cis/tagging/category/${seg(cid)}`).catch(
          () => undefined,
        );
        categoryNames.set(cid, c?.name ?? "");
      }
      return this.instance(
        accountId,
        TAG,
        id,
        t?.name ?? id,
        {
          name: t?.name ?? "",
          description: t?.description ?? "",
          categoryId: cid,
          categoryName: categoryNames.get(cid) ?? "",
        },
        { resolvedOutputs: { tagId: id } },
      );
    });
  }

  // ---------------------------------------------------------------------------
  // Outputs, detail
  // ---------------------------------------------------------------------------

  async resolveOutput(
    typeId: string,
    resourceId: string,
    outputKey: string,
    _accountId: string,
  ): Promise<string> {
    const ext = externalIdOf(resourceId);
    if (typeId === VM) {
      if (outputKey === "vmId") return ext;
      const ident = await this.api
        .get<{ ip_address?: string; host_name?: string }>(`/vcenter/vm/${seg(ext)}/guest/identity`)
        .catch(() => undefined);
      if (outputKey === "ipAddress") return ident?.ip_address ?? "";
      if (outputKey === "guestHostname") return ident?.host_name ?? "";
    }
    if (typeId === HOST) {
      if (outputKey === "hostId") return ext;
      if (outputKey === "hostname")
        return (await this.hosts()).find((h) => h.host === ext)?.name ?? "";
    }
    if (typeId === VCENTER && outputKey === "url") return this.api.baseUrl;
    const simple: Record<string, string> = {
      datacenterId: DATACENTER,
      clusterId: CLUSTER,
      datastoreId: DATASTORE,
      networkId: NETWORK,
      resourcePoolId: RESOURCE_POOL,
      folderId: FOLDER,
      libraryId: LIBRARY,
      itemId: LIBRARY_ITEM,
      categoryId: TAG_CATEGORY,
      tagId: TAG,
    };
    if (simple[outputKey] === typeId) return ext;
    throw new Error(`vSphere plugin: cannot resolve output "${outputKey}" for type "${typeId}"`);
  }

  async enrichDetail(resource: ResourceInstance): Promise<ResourceInstance> {
    const ext = resource.externalId ?? externalIdOf(resource.id);
    const data: VsphereEnrichment = {};
    const outputs = { ...resource.resolvedOutputs };
    const named = <T extends { name: string }>(list: T[], id: (t: T) => string) =>
      list.map((x) => ({ id: id(x), label: x.name }));
    if (resource.resourceTypeId === VM || resource.resourceTypeId === LIBRARY_ITEM) {
      const [hosts, pools, datastores, folders, specs, clusters] = await Promise.all([
        this.hosts().catch(() => []),
        this.resourcePools().catch(() => []),
        this.datastores().catch(() => []),
        this.folders({ type: "VIRTUAL_MACHINE" }).catch(() => []),
        this.api.get<Array<{ name: string }>>("/vcenter/guest/customization-specs").catch(() => []),
        this.clusters().catch(() => []),
      ]);
      data.hosts = named(hosts, (h) => h.host);
      data.pools = named(pools, (p) => p.resource_pool);
      data.datastores = named(datastores, (d) => d.datastore);
      data.folders = named(folders, (fo) => fo.folder);
      data.clusters = named(clusters, (c) => c.cluster);
      data.specs = (specs ?? []).map((s) => s.name);
    }
    if (resource.resourceTypeId === VM) {
      const [ident, tools, tagIds, allTags, isos] = await Promise.all([
        this.api
          .get<{
            ip_address?: string;
            host_name?: string;
            full_name?: { default_message?: string };
          }>(`/vcenter/vm/${seg(ext)}/guest/identity`)
          .catch(() => undefined),
        this.api
          .get<{ run_state?: string; version_status?: string; version?: string }>(
            `/vcenter/vm/${seg(ext)}/tools`,
          )
          .catch(() => undefined),
        this.api
          .post<string[]>(
            "/cis/tagging/tag-association",
            { object_id: { type: "VirtualMachine", id: ext } },
            { action: "list-attached-tags" },
          )
          .catch(() => [] as string[]),
        this.cached<string[]>("/cis/tagging/tag").catch(() => [] as string[]),
        this.libraries()
          .then((libs) => mapLimit(libs, 3, (l) => this.libraryItems(l.id).catch(() => [])))
          .then((lists) => lists.flat().filter((i) => (i.type ?? "").toLowerCase() === "iso"))
          .catch(() => []),
      ]);
      if (ident?.ip_address) outputs["ipAddress"] = ident.ip_address;
      if (ident?.host_name) outputs["guestHostname"] = ident.host_name;
      data.guestFullName = ident?.full_name?.default_message ?? "";
      data.toolsRunState = tools?.run_state ?? "";
      data.toolsVersionStatus = tools?.version_status ?? "";
      const tagNames = await mapLimit(allTags ?? [], 8, async (id) => ({
        id,
        label:
          (
            await this.cached<{ name?: string }>(`/cis/tagging/tag/${seg(id)}`).catch(
              () => undefined,
            )
          )?.name ?? id,
      }));
      data.attachedTags = tagNames.filter((t) => (tagIds ?? []).includes(t.id));
      data.availableTags = tagNames.filter((t) => !(tagIds ?? []).includes(t.id));
      data.isos = isos.map((i) => ({ id: i.id, label: i.name ?? i.id }));
      if (resource.fields["powerState"] === "POWERED_ON") {
        const ticket = await this.api
          .post<{ ticket?: string }>(`/vcenter/vm/${seg(ext)}/console/tickets`, { type: "VMRC" })
          .catch(() => undefined);
        if (ticket?.ticket) data.consoleTicket = ticket.ticket;
      }
    }
    if (resource.resourceTypeId === DATASTORE) {
      const d = (await this.datastores()).find((x) => x.datastore === ext);
      if (d) data.datastoreUsage = { capacityGb: gib(d.capacity), freeGb: gib(d.free_space) };
    }
    if (
      resource.resourceTypeId === HOST ||
      resource.resourceTypeId === CLUSTER ||
      resource.resourceTypeId === RESOURCE_POOL
    ) {
      const key =
        resource.resourceTypeId === HOST
          ? "hosts"
          : resource.resourceTypeId === CLUSTER
            ? "clusters"
            : "resource_pools";
      const vms = await this.cached<VmSummary[]>("/vcenter/vm", { [key]: ext }).catch(() => []);
      data.vms = vms.map((v) => ({ id: v.vm, name: v.name, power: v.power_state }));
    }
    return { ...resource, resolvedOutputs: { ...outputs, [ENRICH_KEY]: JSON.stringify(data) } };
  }

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    return renderVsphereDetail(resource, this.api.baseUrl);
  }

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    return renderVsphereSidebar(resource);
  }

  async fetchDashboardStats(
    typeId: string,
    resourceId: string,
    _accountId: string,
  ): Promise<DashboardStat[]> {
    const ext = externalIdOf(resourceId);
    if (typeId === DATASTORE) {
      const d = (await this.datastores()).find((x) => x.datastore === ext);
      if (!d || !d.capacity) return [];
      const used = d.capacity - (d.free_space ?? 0);
      const pct = (used / d.capacity) * 100;
      return [
        { label: "Used", value: `${gib(used)} / ${gib(d.capacity)} GiB` },
        {
          label: "Usage",
          value: `${pct.toFixed(0)}%`,
          variant: pct > 90 ? "status-error" : pct > 80 ? "status-degraded" : "status-healthy",
        },
      ];
    }
    if (typeId === VM) {
      const v = (await this.vms()).find((x) => x.vm === ext);
      if (!v) return [];
      return [
        {
          label: "Power",
          value: v.power_state,
          variant: v.power_state === "POWERED_ON" ? "status-healthy" : "status-error",
        },
        { label: "vCPUs", value: String(v.cpu_count ?? "") },
        { label: "Memory", value: `${v.memory_size_MiB ?? v.memory_size_mib ?? 0} MiB` },
      ];
    }
    if (typeId === HOST) {
      const h = (await this.hosts()).find((x) => x.host === ext);
      if (!h) return [];
      const vms = await this.cached<VmSummary[]>("/vcenter/vm", { hosts: ext }).catch(() => []);
      return [
        {
          label: "Connection",
          value: h.connection_state,
          variant: h.connection_state === "CONNECTED" ? "status-healthy" : "status-error",
        },
        { label: "VMs", value: String(vms.length) },
      ];
    }
    return [];
  }

  // ---------------------------------------------------------------------------
  // Mutations
  // ---------------------------------------------------------------------------

  getCreateConfig(typeId: string): Promise<CreateResourceConfig> {
    return vsphereCreateConfig(this, typeId);
  }

  createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceCreateReturn> {
    return vsphereCreateResource(this, typeId, accountId, fields);
  }

  async invokeAction(
    typeId: string,
    resourceId: string,
    actionId: string,
    _accountId: string,
  ): Promise<void> {
    const ext = externalIdOf(resourceId);
    try {
      if (typeId === VM) {
        const vm = `/vcenter/vm/${seg(ext)}`;
        if (["start", "stop", "suspend", "reset"].includes(actionId)) {
          await this.api.post(`${vm}/power`, undefined, { action: actionId });
          return;
        }
        if (actionId.startsWith("guest-")) {
          await this.api.post(`${vm}/guest/power`, undefined, {
            action: actionId.slice("guest-".length),
          });
          return;
        }
        if (actionId === "tools-upgrade") {
          await this.api.post(`${vm}/tools`, {}, { action: "upgrade" });
          return;
        }
        if (actionId.startsWith("detach-tag:")) {
          await this.api.post(
            `/cis/tagging/tag-association/${seg(actionId.slice(11))}`,
            { object_id: { type: "VirtualMachine", id: ext } },
            { action: "detach" },
          );
          return;
        }
      }
      if (typeId === HOST && (actionId === "connect" || actionId === "disconnect")) {
        await this.api.post(`/vcenter/host/${seg(ext)}`, undefined, { action: actionId });
        return;
      }
    } finally {
      this.invalidate();
    }
    throw new Error(`vSphere plugin: action "${actionId}" is not supported for ${typeId}`);
  }

  async executeNoSqlCommand(
    typeId: string,
    resourceId: string,
    accountId: string,
    command: string,
    args: (string | number)[],
  ): Promise<unknown> {
    const v = decodePromptArgs(args);
    const ext = externalIdOf(resourceId);
    try {
      if (typeId === VM) {
        switch (command) {
          case "clone": {
            if (!v["name"]) throw new VsphereApiError("A name is required.", 400);
            const placement = placementOf(v);
            const id = await this.api.post<string>(
              "/vcenter/vm",
              {
                source: ext,
                name: v["name"],
                ...(Object.keys(placement).length ? { placement } : {}),
                power_on: v["powerOn"] === "true",
                ...(v["spec"] ? { guest_customization_spec: { name: v["spec"] } } : {}),
              },
              { action: "clone" },
            );
            return { ok: true, vm: id };
          }
          case "relocate": {
            const placement = placementOf(v);
            if (Object.keys(placement).length === 0)
              throw new VsphereApiError("Pick a host, resource pool or datastore to move to.", 400);
            await this.api.post(`/vcenter/vm/${seg(ext)}`, { placement }, { action: "relocate" });
            return { ok: true };
          }
          case "add-disk": {
            const gb = Number(v["sizeGb"]);
            if (!Number.isFinite(gb) || gb <= 0)
              throw new VsphereApiError("Enter a disk size in GiB.", 400);
            await this.api.post(`/vcenter/vm/${seg(ext)}/hardware/disk`, {
              new_vmdk: { capacity: Math.round(gb * GIB) },
            });
            return { ok: true };
          }
          case "mount-iso": {
            if (!v["item"]) throw new VsphereApiError("Pick an ISO library item.", 400);
            await this.api.post("/vcenter/iso/image", undefined, {
              action: "mount",
              library_item: v["item"],
              vm: ext,
            });
            return { ok: true };
          }
          case "attach-tag": {
            if (!v["tag"]) throw new VsphereApiError("Pick a tag.", 400);
            await this.api.post(
              `/cis/tagging/tag-association/${seg(v["tag"])}`,
              { object_id: { type: "VirtualMachine", id: ext } },
              { action: "attach" },
            );
            return { ok: true };
          }
        }
      }
      if (typeId === LIBRARY_ITEM && command === "deploy") {
        const item = await this.getResource(LIBRARY_ITEM, resourceId, accountId);
        const id = await deployLibraryItem(this, ext, String(item.fields["type"] ?? ""), v);
        return { ok: true, vm: id };
      }
    } finally {
      this.invalidate();
    }
    throw new Error(`vSphere plugin: command "${command}" is not supported for ${typeId}`);
  }

  async deleteResource(typeId: string, resourceId: string, accountId: string): Promise<void> {
    const ext = externalIdOf(resourceId);
    switch (typeId) {
      case VM: {
        const v = (await this.vms()).find((x) => x.vm === ext);
        if (v && v.power_state !== "POWERED_OFF")
          throw new VsphereApiError("Power the VM off before deleting it.", 409);
        await this.api.delete(`/vcenter/vm/${seg(ext)}`);
        break;
      }
      case HOST:
        await this.api.delete(`/vcenter/host/${seg(ext)}`);
        break;
      case DATACENTER:
        await this.api.delete(`/vcenter/datacenter/${seg(ext)}`);
        break;
      case RESOURCE_POOL:
        await this.api.delete(`/vcenter/resource-pool/${seg(ext)}`);
        break;
      case LIBRARY: {
        const lib = await this.getResource(LIBRARY, resourceId, accountId);
        await this.api.delete(
          `/content/${lib.fields["type"] === "SUBSCRIBED" ? "subscribed-library" : "local-library"}/${seg(ext)}`,
        );
        break;
      }
      case LIBRARY_ITEM:
        await this.api.delete(`/content/library/item/${seg(ext)}`);
        break;
      case TAG_CATEGORY:
        await this.api.delete(`/cis/tagging/category/${seg(ext)}`);
        break;
      case TAG:
        await this.api.delete(`/cis/tagging/tag/${seg(ext)}`);
        break;
      case CUSTOMIZATION_SPEC:
        await this.api.delete(`/vcenter/guest/customization-specs/${seg(ext)}`);
        break;
      default:
        throw new Error(`vSphere plugin: ${typeId} cannot be deleted`);
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
    const num = (k: string) => (has(k) && fields[k] !== "" ? Number(fields[k]) : undefined);
    const bool = (k: string) => (has(k) ? fields[k] === "true" : undefined);
    const compact = (o: Record<string, unknown>) =>
      Object.fromEntries(Object.entries(o).filter(([, x]) => x !== undefined));
    switch (typeId) {
      case VM: {
        const cpu = compact({
          count: num("cpuCount"),
          cores_per_socket: num("coresPerSocket"),
          hot_add_enabled: bool("cpuHotAdd"),
        });
        if (Object.keys(cpu).length)
          await this.api.patch(`/vcenter/vm/${seg(ext)}/hardware/cpu`, cpu);
        const mem = compact({ size_MiB: num("memoryMb"), hot_add_enabled: bool("memoryHotAdd") });
        if (Object.keys(mem).length)
          await this.api.patch(`/vcenter/vm/${seg(ext)}/hardware/memory`, mem);
        break;
      }
      case RESOURCE_POOL: {
        const alloc = (prefix: "cpu" | "memory", unit: "Mhz" | "Mb") =>
          compact({
            reservation: num(`${prefix}Reservation${unit}`),
            limit: num(`${prefix}Limit${unit}`),
            expandable_reservation: bool(`${prefix}Expandable`),
            ...(has(`${prefix}Shares`) && fields[`${prefix}Shares`]
              ? { shares: { level: fields[`${prefix}Shares`] } }
              : {}),
          });
        const body = compact({ name: has("name") ? fields["name"] : undefined });
        const c = alloc("cpu", "Mhz");
        const m = alloc("memory", "Mb");
        if (Object.keys(c).length) body["cpu_allocation"] = c;
        if (Object.keys(m).length) body["memory_allocation"] = m;
        await this.api.patch(`/vcenter/resource-pool/${seg(ext)}`, body);
        break;
      }
      case LIBRARY: {
        const lib = await this.getResource(LIBRARY, resourceId, accountId);
        await this.api.patch(
          `/content/${lib.fields["type"] === "SUBSCRIBED" ? "subscribed-library" : "local-library"}/${seg(ext)}`,
          compact({
            name: has("name") ? fields["name"] : undefined,
            description: has("description") ? fields["description"] : undefined,
          }),
        );
        break;
      }
      case LIBRARY_ITEM:
        await this.api.patch(
          `/content/library/item/${seg(ext)}`,
          compact({
            name: has("name") ? fields["name"] : undefined,
            description: has("description") ? fields["description"] : undefined,
          }),
        );
        break;
      case TAG:
        await this.api.patch(
          `/cis/tagging/tag/${seg(ext)}`,
          compact({
            name: has("name") ? fields["name"] : undefined,
            description: has("description") ? fields["description"] : undefined,
          }),
        );
        break;
      case TAG_CATEGORY: {
        const types = has("associableTypes")
          ? (fields["associableTypes"] ?? "")
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean)
          : undefined;
        await this.api.patch(
          `/cis/tagging/category/${seg(ext)}`,
          compact({
            name: has("name") ? fields["name"] : undefined,
            description: has("description") ? fields["description"] : undefined,
            associable_types: types,
          }),
        );
        break;
      }
      default:
        throw new Error(`vSphere plugin: ${typeId} cannot be edited`);
    }
    this.invalidate();
    return this.getResource(typeId, resourceId, accountId);
  }
}

/** Placement object from prompt/create values, omitting empty picks. */
export function placementOf(v: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [form, api] of [
    ["folder", "folder"],
    ["resourcePool", "resource_pool"],
    ["host", "host"],
    ["cluster", "cluster"],
    ["datastore", "datastore"],
  ] as const) {
    if (v[form]) out[api] = v[form];
  }
  return out;
}

/** Deploy a VM template (vm-template) or an OVF package (ovf) library item. */
export async function deployLibraryItem(
  client: VsphereClient,
  itemId: string,
  type: string,
  v: Record<string, string>,
): Promise<string> {
  const name = v["name"];
  if (!name) throw new VsphereApiError("A VM name is required.", 400);
  if (type.toLowerCase() === "ovf") {
    let pool = v["resourcePool"];
    if (!pool && v["cluster"]) {
      pool = (
        await client.api.get<{ resource_pool?: string }>(`/vcenter/cluster/${seg(v["cluster"])}`)
      )?.resource_pool;
    }
    if (!pool) throw new VsphereApiError("Pick a cluster or resource pool to deploy into.", 400);
    const res = await client.api.post<{
      succeeded?: boolean;
      resource_id?: { id?: string };
      error?: { errors?: Array<{ message?: { default_message?: string } }> };
    }>(
      `/vcenter/ovf/library-item/${seg(itemId)}`,
      {
        target: {
          resource_pool_id: pool,
          ...(v["host"] ? { host_id: v["host"] } : {}),
          ...(v["folder"] ? { folder_id: v["folder"] } : {}),
        },
        deployment_spec: {
          name,
          accept_all_eula: true,
          ...(v["datastore"] ? { default_datastore_id: v["datastore"] } : {}),
        },
      },
      { action: "deploy" },
    );
    if (!res?.succeeded) {
      const msg = res?.error?.errors
        ?.map((e) => e.message?.default_message ?? "")
        .filter(Boolean)
        .join("; ");
      throw new VsphereApiError(`OVF deployment failed${msg ? `: ${msg}` : ""}`, 500);
    }
    return res.resource_id?.id ?? "";
  }
  const placement = placementOf(v);
  delete placement["datastore"];
  const cpu = v["cpuCount"] ? Number(v["cpuCount"]) : undefined;
  const mem = v["memoryMb"] ? Number(v["memoryMb"]) : undefined;
  return client.api.post<string>(
    `/vcenter/vm-template/library-items/${seg(itemId)}`,
    {
      name,
      ...(Object.keys(placement).length ? { placement } : {}),
      ...(v["datastore"]
        ? {
            vm_home_storage: { datastore: v["datastore"] },
            disk_storage: { datastore: v["datastore"] },
          }
        : {}),
      powered_on: v["powerOn"] === "true",
      ...(v["spec"] ? { guest_customization: { name: v["spec"] } } : {}),
      ...(cpu || mem
        ? {
            hardware_customization: {
              ...(cpu ? { cpu_update: { num_cpus: cpu } } : {}),
              ...(mem ? { memory_update: { memory: mem } } : {}),
            },
          }
        : {}),
    },
    { action: "deploy" },
  );
}
