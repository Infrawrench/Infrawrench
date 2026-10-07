import type {
  CreateResourceConfig,
  DashboardStat,
  DetailViewSchema,
  HostServices,
  LogsFetchParams,
  LogsFetchResult,
  MetricSeries,
  PluginClient,
  QuotaUsage,
  ResourceCreateReturn,
  ResourceInstance,
  SidebarItemSchema,
  StorageObject,
} from "@infrawrench/plugin-base";
import { externalIdOf } from "@infrawrench/plugin-base";
import { OpenStackApi, OpenStackApiError, type Service } from "./api.js";
import {
  describeRule,
  gib,
  isPublicReadAcl,
  mapLimit,
  mapRuleFields,
  mapServerFields,
  serverAddresses,
  str,
  type NovaServer,
  type SgRule,
} from "./mappers.js";
import {
  CONTAINER,
  DNS_RECORDSET,
  DNS_ZONE,
  FLAVOR,
  FLOATING_IP,
  IMAGE,
  KEYPAIR,
  LB_LISTENER,
  LB_POOL,
  LOADBALANCER,
  NETWORK,
  ROUTER,
  SECURITY_GROUP,
  SERVER,
  SG_RULE,
  STACK,
  SUBNET,
  VOLUME,
  VOLUME_BACKUP,
  VOLUME_SNAPSHOT,
  resourceTypes,
} from "./resources.js";
import {
  ENRICH_KEY,
  renderOpenStackDetail,
  renderOpenStackSidebar,
  type OpenStackEnrichment,
} from "./render.js";
import { openstackCreateConfig, openstackCreateResource } from "./create.js";
import {
  openstackAttach,
  openstackDelete,
  openstackInvokeAction,
  openstackPrompt,
  openstackUpdate,
} from "./ops.js";
import { fetchOpenStackQuotas, fetchServerMetrics } from "./extras.js";

type Fields = Record<string, string | number | boolean>;
type Obj = Record<string, unknown>;

const CACHE_MS = 10_000;

/** Which OpenStack service a resource type lives in. */
export const SERVICE_OF: Record<string, Service> = {
  [SERVER]: "compute",
  [FLAVOR]: "compute",
  [KEYPAIR]: "compute",
  [IMAGE]: "image",
  [VOLUME]: "block-storage",
  [VOLUME_SNAPSHOT]: "block-storage",
  [VOLUME_BACKUP]: "block-storage",
  [NETWORK]: "network",
  [SUBNET]: "network",
  [ROUTER]: "network",
  [FLOATING_IP]: "network",
  [SECURITY_GROUP]: "network",
  [SG_RULE]: "network",
  [LOADBALANCER]: "load-balancer",
  [LB_LISTENER]: "load-balancer",
  [LB_POOL]: "load-balancer",
  [CONTAINER]: "object-store",
  [DNS_ZONE]: "dns",
  [DNS_RECORDSET]: "dns",
  [STACK]: "orchestration",
};

export class OpenStackClient implements PluginClient {
  readonly api: OpenStackApi;
  private readonly cache = new Map<string, { at: number; p: Promise<unknown> }>();

  constructor(credentials: Record<string, string>, services?: HostServices) {
    const authUrl = credentials["authUrl"] ?? "";
    if (!authUrl) throw new Error("OpenStack plugin: missing authUrl credential");
    const has = (k: string) => !!credentials[k];
    if (
      !(has("applicationCredentialId") && has("applicationCredentialSecret")) &&
      !(has("username") && has("password"))
    ) {
      throw new Error(
        "OpenStack plugin: enter an application credential ID and secret, or a username and password",
      );
    }
    const pick = (k: string) => (credentials[k] ? { [k]: credentials[k] } : {});
    this.api = new OpenStackApi(
      {
        authUrl,
        ...pick("applicationCredentialId"),
        ...pick("applicationCredentialSecret"),
        ...pick("username"),
        ...pick("password"),
        ...pick("userDomain"),
        ...pick("project"),
        ...pick("projectDomain"),
        ...pick("region"),
        ...pick("interface"),
        ...pick("caCert"),
      },
      services?.http,
    );
  }

  cached<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.p as Promise<T>;
    const p = fn();
    p.catch(() => this.cache.delete(key));
    this.cache.set(key, { at: Date.now(), p });
    return p;
  }

  invalidate(): void {
    this.cache.clear();
  }

  async projectId(): Promise<string> {
    return (await this.api.token()).projectId;
  }

  instance(
    accountId: string,
    typeId: string,
    externalId: string,
    displayName: string,
    fields: Fields,
    extra: { parentResourceId?: string; resolvedOutputs?: Record<string, string> } = {},
  ): ResourceInstance {
    const now = new Date().toISOString();
    return {
      id: `${accountId}:${typeId}:${externalId}`,
      pluginId: "openstack",
      resourceTypeId: typeId,
      accountId,
      displayName: displayName || externalId,
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
  // Raw lists (memoised; reused by pickers and cross-references)
  // ---------------------------------------------------------------------------

  servers(): Promise<NovaServer[]> {
    return this.cached("servers", () =>
      this.api.paginate<NovaServer & Obj>("compute", "/servers/detail", "servers"),
    );
  }
  flavors(): Promise<
    Array<{
      id: string;
      name: string;
      vcpus: number;
      ram: number;
      disk: number;
      "OS-FLV-EXT-DATA:ephemeral"?: number;
      "os-flavor-access:is_public"?: boolean;
    }>
  > {
    return this.cached("flavors", () =>
      this.api.paginate("compute", "/flavors/detail", "flavors", {}, { limit: 1000 }),
    );
  }
  async neutron<T extends Obj>(path: string, key: string, projectScoped = true): Promise<T[]> {
    const pid = projectScoped ? await this.projectId() : "";
    return this.cached(`neutron:${path}:${pid}`, () =>
      this.api.paginate<T>("network", `/v2.0/${path}`, key, pid ? { project_id: pid } : {}),
    );
  }
  networks(): Promise<Obj[]> {
    return this.neutron("networks", "networks", false);
  }
  ports(): Promise<Obj[]> {
    return this.neutron("ports", "ports");
  }
  images(owned = true): Promise<Obj[]> {
    return this.cached(`images:${owned}`, async () =>
      this.api.paginate<Obj>(
        "image",
        "/v2/images",
        "images",
        owned ? { owner: await this.projectId() } : {},
        { limit: 200 },
      ),
    );
  }
  volumes(): Promise<Obj[]> {
    return this.cached("volumes", () =>
      this.api.paginate<Obj>("block-storage", "/volumes/detail", "volumes"),
    );
  }
  securityGroups(): Promise<
    Array<Obj & { id: string; name: string; security_group_rules?: SgRule[] }>
  > {
    return this.neutron("security-groups", "security_groups");
  }
  async containers(): Promise<
    Array<{ name: string; count: number; bytes: number; last_modified?: string }>
  > {
    return this.cached("containers", async () => {
      const out: Array<{ name: string; count: number; bytes: number; last_modified?: string }> = [];
      let marker = "";
      for (let page = 0; page < 50; page++) {
        const list = await this.api.get<
          Array<{ name: string; count: number; bytes: number; last_modified?: string }>
        >("object-store", "", {
          format: "json",
          limit: 1000,
          ...(marker ? { marker } : {}),
        });
        out.push(...(list ?? []));
        if (!list || list.length < 1000) break;
        marker = list[list.length - 1]!.name;
      }
      return out;
    });
  }
  async lbList(kind: "loadbalancers" | "listeners" | "pools" | "healthmonitors"): Promise<Obj[]> {
    const pid = await this.projectId();
    return this.cached(`lb:${kind}`, () =>
      this.api.paginate<Obj>("load-balancer", `/v2/lbaas/${kind}`, kind, { project_id: pid }),
    );
  }

  // ---------------------------------------------------------------------------
  // Listing
  // ---------------------------------------------------------------------------

  async listResources(typeId: string, accountId: string): Promise<ResourceInstance[]> {
    const service = SERVICE_OF[typeId];
    if (!service) throw new Error(`OpenStack plugin: unknown resource type "${typeId}"`);
    // Optional services (Octavia, Swift, Designate, Heat) are simply absent on some clouds.
    if (
      !["compute", "network", "image", "block-storage"].includes(service) &&
      !(await this.api.hasService(service))
    )
      return [];
    switch (typeId) {
      case SERVER:
        return this.listServers(accountId);
      case FLAVOR:
        return (await this.flavors()).map((fl) =>
          this.instance(
            accountId,
            FLAVOR,
            fl.id,
            fl.name,
            {
              name: fl.name,
              vcpus: fl.vcpus,
              ramMb: fl.ram,
              diskGb: fl.disk,
              ephemeralGb: fl["OS-FLV-EXT-DATA:ephemeral"] ?? 0,
              isPublic: fl["os-flavor-access:is_public"] !== false,
            },
            { resolvedOutputs: { flavorId: fl.id } },
          ),
        );
      case KEYPAIR: {
        const data = await this.api.get<{
          keypairs?: Array<{
            keypair: { name: string; fingerprint?: string; public_key?: string; type?: string };
          }>;
        }>("compute", "/os-keypairs");
        return (data?.keypairs ?? []).map(({ keypair: k }) =>
          this.instance(
            accountId,
            KEYPAIR,
            k.name,
            k.name,
            { name: k.name, type: k.type ?? "ssh", fingerprint: k.fingerprint ?? "" },
            {
              resolvedOutputs: { publicKey: k.public_key ?? "" },
            },
          ),
        );
      }
      case IMAGE: {
        const pid = await this.projectId();
        return (await this.images()).map((i) =>
          this.instance(
            accountId,
            IMAGE,
            str(i["id"]),
            str(i["name"]),
            {
              name: str(i["name"]),
              status: str(i["status"]),
              visibility: str(i["visibility"]),
              protected: i["protected"] === true,
              osDistro: str(i["os_distro"]),
              diskFormat: str(i["disk_format"]),
              sizeGb: gib(i["size"]),
              minDiskGb: Number(i["min_disk"] ?? 0),
              minRamMb: Number(i["min_ram"] ?? 0),
              owned: i["owner"] === pid,
              imageType: str(i["image_type"]) || "image",
              sourceServerId: str(i["instance_uuid"]),
              createdAt: str(i["created_at"]),
            },
            { resolvedOutputs: { imageId: str(i["id"]) } },
          ),
        );
      }
      case VOLUME:
        return (await this.volumes()).map((v) => {
          const att = (
            v["attachments"] as Array<{ server_id?: string; device?: string }> | undefined
          )?.[0];
          return this.instance(
            accountId,
            VOLUME,
            str(v["id"]),
            str(v["name"]) || str(v["id"]).slice(0, 8),
            {
              name: str(v["name"]),
              description: str(v["description"]),
              sizeGb: Number(v["size"] ?? 0),
              status: str(v["status"]),
              volumeType: str(v["volume_type"]),
              availabilityZone: str(v["availability_zone"]),
              bootable: v["bootable"] === "true" || v["bootable"] === true,
              encrypted: v["encrypted"] === true,
              serverId: att?.server_id ?? "",
              device: att?.device ?? "",
              createdAt: str(v["created_at"]),
            },
            { resolvedOutputs: { volumeId: str(v["id"]) } },
          );
        });
      case VOLUME_SNAPSHOT:
        return (
          await this.api.paginate<Obj>("block-storage", "/snapshots/detail", "snapshots")
        ).map((s) =>
          this.instance(
            accountId,
            VOLUME_SNAPSHOT,
            str(s["id"]),
            str(s["name"]) || str(s["id"]).slice(0, 8),
            {
              name: str(s["name"]),
              description: str(s["description"]),
              status: str(s["status"]),
              sizeGb: Number(s["size"] ?? 0),
              volumeId: str(s["volume_id"]),
              createdAt: str(s["created_at"]),
            },
            { resolvedOutputs: { snapshotId: str(s["id"]) } },
          ),
        );
      case VOLUME_BACKUP:
        return (
          await this.api
            .paginate<Obj>("block-storage", "/backups/detail", "backups")
            .catch(() => [])
        ).map((b) =>
          this.instance(
            accountId,
            VOLUME_BACKUP,
            str(b["id"]),
            str(b["name"]) || str(b["id"]).slice(0, 8),
            {
              name: str(b["name"]),
              description: str(b["description"]),
              status: str(b["status"]),
              sizeGb: Number(b["size"] ?? 0),
              volumeId: str(b["volume_id"]),
              incremental: b["is_incremental"] === true,
              createdAt: str(b["created_at"]),
            },
            { resolvedOutputs: { backupId: str(b["id"]) } },
          ),
        );
      case NETWORK: {
        const pid = await this.projectId();
        return (await this.networks()).map((n) =>
          this.instance(
            accountId,
            NETWORK,
            str(n["id"]),
            str(n["name"]) || str(n["id"]).slice(0, 8),
            {
              name: str(n["name"]),
              description: str(n["description"]),
              status: str(n["status"]),
              adminStateUp: n["admin_state_up"] !== false,
              mtu: Number(n["mtu"] ?? 0),
              external: n["router:external"] === true,
              shared: n["shared"] === true,
              owned: n["project_id"] === pid || n["tenant_id"] === pid,
              subnetIds: ((n["subnets"] as string[] | undefined) ?? []).join(", "),
            },
            { resolvedOutputs: { networkId: str(n["id"]) } },
          ),
        );
      }
      case SUBNET:
        return (await this.neutron<Obj>("subnets", "subnets")).map((s) =>
          this.instance(
            accountId,
            SUBNET,
            str(s["id"]),
            str(s["name"]) || str(s["cidr"]),
            {
              name: str(s["name"]),
              description: str(s["description"]),
              cidr: str(s["cidr"]),
              ipVersion: Number(s["ip_version"] ?? 4),
              gatewayIp: str(s["gateway_ip"]),
              enableDhcp: s["enable_dhcp"] !== false,
              dnsNameservers: ((s["dns_nameservers"] as string[] | undefined) ?? []).join(", "),
              networkId: str(s["network_id"]),
            },
            { resolvedOutputs: { subnetId: str(s["id"]), cidr: str(s["cidr"]) } },
          ),
        );
      case ROUTER: {
        const ports = await this.ports().catch(() => [] as Obj[]);
        return (await this.neutron<Obj>("routers", "routers")).map((r) => {
          const gw = r["external_gateway_info"] as {
            network_id?: string;
            external_fixed_ips?: Array<{ ip_address?: string }>;
          } | null;
          const ifaces = ports
            .filter(
              (p) =>
                p["device_id"] === r["id"] &&
                String(p["device_owner"] ?? "").startsWith("network:router_interface"),
            )
            .flatMap((p) =>
              ((p["fixed_ips"] as Array<{ subnet_id?: string }> | undefined) ?? []).map(
                (ip) => ip.subnet_id ?? "",
              ),
            )
            .filter(Boolean);
          return this.instance(
            accountId,
            ROUTER,
            str(r["id"]),
            str(r["name"]) || str(r["id"]).slice(0, 8),
            {
              name: str(r["name"]),
              description: str(r["description"]),
              status: str(r["status"]),
              adminStateUp: r["admin_state_up"] !== false,
              externalNetworkId: gw?.network_id ?? "",
              externalIps: (gw?.external_fixed_ips ?? [])
                .map((i) => i.ip_address ?? "")
                .filter(Boolean)
                .join(", "),
              subnetIds: [...new Set(ifaces)].join(", "),
            },
            { resolvedOutputs: { routerId: str(r["id"]) } },
          );
        });
      }
      case FLOATING_IP: {
        const [fips, ports] = await Promise.all([
          this.neutron<Obj>("floatingips", "floatingips"),
          this.ports().catch(() => [] as Obj[]),
        ]);
        const deviceOf = new Map(ports.map((p) => [str(p["id"]), p]));
        return fips.map((ip) => {
          const port = deviceOf.get(str(ip["port_id"]));
          const serverId =
            port && String(port["device_owner"] ?? "").startsWith("compute:")
              ? str(port["device_id"])
              : "";
          return this.instance(
            accountId,
            FLOATING_IP,
            str(ip["id"]),
            str(ip["floating_ip_address"]),
            {
              ip: str(ip["floating_ip_address"]),
              description: str(ip["description"]),
              status: str(ip["status"]),
              networkId: str(ip["floating_network_id"]),
              portId: str(ip["port_id"]),
              fixedIp: str(ip["fixed_ip_address"]),
              serverId,
              dnsName: str(ip["dns_name"]),
            },
            { resolvedOutputs: { ip: str(ip["floating_ip_address"]) } },
          );
        });
      }
      case SECURITY_GROUP:
        return (await this.securityGroups()).map((g) =>
          this.instance(
            accountId,
            SECURITY_GROUP,
            g.id,
            g.name,
            {
              name: g.name,
              description: str(g["description"]),
              stateful: g["stateful"] !== false,
              ruleCount: (g.security_group_rules ?? []).length,
            },
            { resolvedOutputs: { securityGroupId: g.id } },
          ),
        );
      case SG_RULE:
        return (await this.securityGroups()).flatMap((g) =>
          (g.security_group_rules ?? []).map((r) =>
            this.instance(
              accountId,
              SG_RULE,
              r.id,
              `${g.name}: ${describeRule(r)}`,
              mapRuleFields(r),
              {
                parentResourceId: `${accountId}:${SECURITY_GROUP}:${g.id}`,
              },
            ),
          ),
        );
      case LOADBALANCER:
        return (await this.lbList("loadbalancers")).map((lb) =>
          this.instance(
            accountId,
            LOADBALANCER,
            str(lb["id"]),
            str(lb["name"]) || str(lb["vip_address"]),
            {
              name: str(lb["name"]),
              description: str(lb["description"]),
              provisioningStatus: str(lb["provisioning_status"]),
              operatingStatus: str(lb["operating_status"]),
              vipAddress: str(lb["vip_address"]),
              vipSubnetId: str(lb["vip_subnet_id"]),
              vipPortId: str(lb["vip_port_id"]),
              provider: str(lb["provider"]),
              adminStateUp: lb["admin_state_up"] !== false,
              listenerIds: ((lb["listeners"] as Array<{ id: string }> | undefined) ?? [])
                .map((l) => l.id)
                .join(", "),
              poolIds: ((lb["pools"] as Array<{ id: string }> | undefined) ?? [])
                .map((p) => p.id)
                .join(", "),
            },
            {
              resolvedOutputs: {
                vipAddress: str(lb["vip_address"]),
                loadBalancerId: str(lb["id"]),
              },
            },
          ),
        );
      case LB_LISTENER:
        return (await this.lbList("listeners")).map((l) => {
          const lbId =
            ((l["loadbalancers"] as Array<{ id: string }> | undefined) ?? [])[0]?.id ?? "";
          return this.instance(
            accountId,
            LB_LISTENER,
            str(l["id"]),
            str(l["name"]) || `${str(l["protocol"])}:${str(l["protocol_port"])}`,
            {
              name: str(l["name"]),
              protocol: str(l["protocol"]),
              port: Number(l["protocol_port"] ?? 0),
              defaultPoolId: str(l["default_pool_id"]),
              connectionLimit: Number(l["connection_limit"] ?? -1),
              adminStateUp: l["admin_state_up"] !== false,
              provisioningStatus: str(l["provisioning_status"]),
              operatingStatus: str(l["operating_status"]),
              loadBalancerId: lbId,
            },
            lbId ? { parentResourceId: `${accountId}:${LOADBALANCER}:${lbId}` } : {},
          );
        });
      case LB_POOL:
        return (await this.lbList("pools")).map((p) => {
          const lbId =
            ((p["loadbalancers"] as Array<{ id: string }> | undefined) ?? [])[0]?.id ?? "";
          return this.instance(
            accountId,
            LB_POOL,
            str(p["id"]),
            str(p["name"]) || str(p["id"]).slice(0, 8),
            {
              name: str(p["name"]),
              protocol: str(p["protocol"]),
              lbAlgorithm: str(p["lb_algorithm"]),
              memberCount: ((p["members"] as unknown[] | undefined) ?? []).length,
              healthMonitorId: str(p["healthmonitor_id"]),
              provisioningStatus: str(p["provisioning_status"]),
              operatingStatus: str(p["operating_status"]),
              loadBalancerId: lbId,
            },
            lbId ? { parentResourceId: `${accountId}:${LOADBALANCER}:${lbId}` } : {},
          );
        });
      case CONTAINER: {
        const [list, base] = await Promise.all([
          this.containers(),
          this.api.endpoint("object-store"),
        ]);
        return mapLimit(list, 6, async (c) => {
          const head = await this.api
            .request("object-store", "HEAD", `/${encodeURIComponent(c.name)}`)
            .catch(() => undefined);
          const acl = head
            ? Object.entries(head.headers).find(
                ([k]) => k.toLowerCase() === "x-container-read",
              )?.[1]
            : undefined;
          return this.instance(
            accountId,
            CONTAINER,
            c.name,
            c.name,
            {
              name: c.name,
              objectCount: c.count,
              sizeGb: gib(c.bytes),
              publicRead: isPublicReadAcl(acl),
              lastModified: c.last_modified ?? "",
            },
            { resolvedOutputs: { url: `${base}/${encodeURIComponent(c.name)}` } },
          );
        });
      }
      case DNS_ZONE:
        return (await this.api.paginate<Obj>("dns", "/v2/zones", "zones")).map((z) =>
          this.instance(
            accountId,
            DNS_ZONE,
            str(z["id"]),
            str(z["name"]).replace(/\.$/, ""),
            {
              name: str(z["name"]),
              email: str(z["email"]),
              ttl: Number(z["ttl"] ?? 0),
              description: str(z["description"]),
              status: str(z["status"]),
              type: str(z["type"]),
              serial: Number(z["serial"] ?? 0),
            },
            { resolvedOutputs: { zoneId: str(z["id"]) } },
          ),
        );
      case DNS_RECORDSET:
        return (await this.api.paginate<Obj>("dns", "/v2/recordsets", "recordsets")).map((r) =>
          this.instance(
            accountId,
            DNS_RECORDSET,
            `${str(r["zone_id"])}/${str(r["id"])}`,
            `${str(r["name"])} ${str(r["type"])}`,
            {
              name: str(r["name"]),
              type: str(r["type"]),
              content: ((r["records"] as string[] | undefined) ?? []).join(", "),
              ttl: Number(r["ttl"] ?? 0),
              description: str(r["description"]),
              status: str(r["status"]),
              zoneId: str(r["zone_id"]),
            },
            { parentResourceId: `${accountId}:${DNS_ZONE}:${str(r["zone_id"])}` },
          ),
        );
      case STACK:
        return (await this.api.paginate<Obj>("orchestration", "/stacks", "stacks")).map((s) =>
          this.instance(
            accountId,
            STACK,
            `${str(s["stack_name"])}/${str(s["id"])}`,
            str(s["stack_name"]),
            {
              name: str(s["stack_name"]),
              status: str(s["stack_status"]),
              statusReason: str(s["stack_status_reason"]),
              description: str(s["description"]),
              createdAt: str(s["creation_time"]),
              updatedAt: str(s["updated_time"]),
            },
            { resolvedOutputs: { stackId: str(s["id"]) } },
          ),
        );
      default:
        throw new Error(`OpenStack plugin: unknown resource type "${typeId}"`);
    }
  }

  private async listServers(accountId: string): Promise<ResourceInstance[]> {
    const [servers, networks] = await Promise.all([
      this.servers(),
      this.networks().catch(() => [] as Obj[]),
    ]);
    const byName = new Map(networks.map((n) => [str(n["name"]), str(n["id"])]));
    return servers.map((s) => {
      const addrs = serverAddresses(s);
      return this.instance(accountId, SERVER, s.id, s.name, mapServerFields(s, byName), {
        resolvedOutputs: { serverId: s.id, publicIp: addrs.publicIp, privateIp: addrs.privateIp },
      });
    });
  }

  async getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<ResourceInstance> {
    const ext = externalIdOf(resourceId);
    const found = (await this.listResources(typeId, accountId)).find((r) => r.externalId === ext);
    if (!found) throw new OpenStackApiError(`OpenStack ${typeId} ${ext} not found`, 404);
    return found;
  }

  async resolveOutput(
    typeId: string,
    resourceId: string,
    outputKey: string,
    accountId: string,
  ): Promise<string> {
    const r = await this.getResource(typeId, resourceId, accountId);
    const v = r.resolvedOutputs[outputKey];
    if (v !== undefined) return v;
    if (typeId === SUBNET && outputKey === "cidr") return str(r.fields["cidr"]);
    throw new Error(`OpenStack plugin: cannot resolve output "${outputKey}" for type "${typeId}"`);
  }

  // ---------------------------------------------------------------------------
  // Detail
  // ---------------------------------------------------------------------------

  async enrichDetail(resource: ResourceInstance): Promise<ResourceInstance> {
    const ext = resource.externalId ?? externalIdOf(resource.id);
    const d: OpenStackEnrichment = {};
    const t = resource.resourceTypeId;
    if (t === SERVER) {
      const [flavors, fips, sgs, volumes, console] = await Promise.all([
        this.flavors().catch(() => []),
        this.neutron<Obj>("floatingips", "floatingips").catch(() => [] as Obj[]),
        this.securityGroups().catch(() => []),
        this.volumes().catch(() => [] as Obj[]),
        resource.fields["status"] === "ACTIVE"
          ? this.api
              .json<{ remote_console?: { url?: string } }>(
                "compute",
                "POST",
                `/servers/${encodeURIComponent(ext)}/remote-consoles`,
                {
                  body: { remote_console: { protocol: "vnc", type: "novnc" } },
                },
              )
              .catch(() => undefined)
          : Promise.resolve(undefined),
      ]);
      d.flavors = flavors.map((fl) => ({
        id: fl.id,
        label: fl.name,
        description: `${fl.vcpus} vCPU, ${fl.ram} MiB, ${fl.disk} GiB`,
      }));
      d.freeFloatingIps = fips
        .filter((ip) => !ip["port_id"])
        .map((ip) => ({ id: str(ip["id"]), label: str(ip["floating_ip_address"]) }));
      d.attachedFloatingIps = fips
        .filter(
          (ip) =>
            ip["port_id"] &&
            String(resource.fields["floatingIps"] ?? "").includes(str(ip["floating_ip_address"])),
        )
        .map((ip) => ({ id: str(ip["id"]), label: str(ip["floating_ip_address"]) }));
      d.securityGroups = sgs.map((g) => ({ id: g.name, label: g.name }));
      d.freeVolumes = volumes
        .filter((v) => v["status"] === "available")
        .map((v) => ({ id: str(v["id"]), label: str(v["name"]) || str(v["id"]) }));
      if (console?.remote_console?.url) d.consoleUrl = console.remote_console.url;
    }
    if (t === SECURITY_GROUP) {
      const g = (await this.securityGroups()).find((x) => x.id === ext);
      d.rules = (g?.security_group_rules ?? []).map((r) => ({
        id: r.id,
        label: describeRule(r),
        description: str(r.description),
      }));
    }
    if (t === ROUTER) {
      const [subnets, networks] = await Promise.all([
        this.neutron<Obj>("subnets", "subnets").catch(() => [] as Obj[]),
        this.networks().catch(() => [] as Obj[]),
      ]);
      d.subnets = subnets.map((s) => ({
        id: str(s["id"]),
        label: `${str(s["name"]) || str(s["id"]).slice(0, 8)} (${str(s["cidr"])})`,
      }));
      d.externalNetworks = networks
        .filter((n) => n["router:external"] === true)
        .map((n) => ({ id: str(n["id"]), label: str(n["name"]) }));
    }
    if (t === LB_POOL) {
      const members = await this.api
        .get<{ members?: Obj[] }>(
          "load-balancer",
          `/v2/lbaas/pools/${encodeURIComponent(ext)}/members`,
        )
        .catch(() => ({ members: [] as Obj[] }));
      d.members = (members?.members ?? []).map((m) => ({
        id: str(m["id"]),
        label: `${str(m["address"])}:${str(m["protocol_port"])}`,
        description: `${str(m["operating_status"])} weight ${str(m["weight"])}`,
      }));
      d.subnets = (await this.neutron<Obj>("subnets", "subnets").catch(() => [] as Obj[])).map(
        (s) => ({ id: str(s["id"]), label: `${str(s["name"])} (${str(s["cidr"])})` }),
      );
    }
    if (t === LOADBALANCER) {
      d.pools = (await this.lbList("pools").catch(() => [] as Obj[]))
        .filter((p) =>
          ((p["loadbalancers"] as Array<{ id: string }> | undefined) ?? []).some(
            (l) => l.id === ext,
          ),
        )
        .map((p) => ({ id: str(p["id"]), label: str(p["name"]) || str(p["id"]).slice(0, 8) }));
    }
    if (t === STACK) {
      const [detail, res] = await Promise.all([
        this.api
          .get<{
            stack?: {
              outputs?: Array<{ output_key: string; output_value: unknown; description?: string }>;
              parameters?: Record<string, string>;
            };
          }>("orchestration", `/stacks/${ext}`)
          .catch(() => undefined),
        this.api
          .get<{ resources?: Obj[] }>("orchestration", `/stacks/${ext}/resources`)
          .catch(() => undefined),
      ]);
      d.stackOutputs = (detail?.stack?.outputs ?? []).map((o) => ({
        id: o.output_key,
        label: typeof o.output_value === "string" ? o.output_value : JSON.stringify(o.output_value),
        description: o.description ?? "",
      }));
      d.stackParameters = Object.entries(detail?.stack?.parameters ?? {})
        .filter(([k]) => !k.startsWith("OS::"))
        .map(([k, v]) => ({ id: k, label: String(v) }));
      d.stackResources = (res?.resources ?? []).map((r) => ({
        id: str(r["resource_name"]),
        label: str(r["resource_type"]),
        description: `${str(r["resource_status"])} ${str(r["physical_resource_id"])}`,
      }));
    }
    return {
      ...resource,
      resolvedOutputs: { ...resource.resolvedOutputs, [ENRICH_KEY]: JSON.stringify(d) },
    };
  }

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    return renderOpenStackDetail(resource);
  }

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    return renderOpenStackSidebar(resource);
  }

  async fetchDashboardStats(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<DashboardStat[]> {
    const r = await this.getResource(typeId, resourceId, accountId);
    const f = r.fields;
    if (typeId === SERVER) {
      return [
        {
          label: "Status",
          value: str(f["status"]),
          variant:
            f["status"] === "ACTIVE"
              ? "status-healthy"
              : f["status"] === "ERROR"
                ? "status-error"
                : "status-degraded",
        },
        { label: "Flavor", value: str(f["flavor"]) },
        ...(r.resolvedOutputs["publicIp"]
          ? [{ label: "IP", value: r.resolvedOutputs["publicIp"] }]
          : []),
      ];
    }
    if (typeId === VOLUME)
      return [
        { label: "Size", value: `${str(f["sizeGb"])} GiB` },
        { label: "Status", value: str(f["status"]) },
      ];
    if (typeId === CONTAINER)
      return [
        { label: "Objects", value: str(f["objectCount"]) },
        { label: "Size", value: `${str(f["sizeGb"])} GiB` },
      ];
    return [];
  }

  // ---------------------------------------------------------------------------
  // Logs, metrics, quotas, storage
  // ---------------------------------------------------------------------------

  async getLogs(
    typeId: string,
    resourceId: string,
    _accountId: string,
    params: LogsFetchParams,
  ): Promise<LogsFetchResult> {
    const ext = externalIdOf(resourceId);
    if (typeId === SERVER) {
      const res = await this.api.json<{ output?: string }>(
        "compute",
        "POST",
        `/servers/${encodeURIComponent(ext)}/action`,
        {
          body: {
            "os-getConsoleOutput": {
              length: Math.min(Math.max(params.tailLines ?? 200, 10), 5000),
            },
          },
        },
      );
      return {
        text: res?.output ?? "",
        containers: ["Console log"],
        activeContainer: "Console log",
      };
    }
    if (typeId === STACK) {
      const res = await this.api.get<{ events?: Obj[] }>("orchestration", `/stacks/${ext}/events`, {
        sort_dir: "desc",
        limit: params.tailLines ?? 200,
      });
      const lines = (res?.events ?? [])
        .map(
          (e) =>
            `${str(e["event_time"])} ${str(e["resource_name"])} ${str(e["resource_status"])} ${str(e["resource_status_reason"])}`,
        )
        .reverse();
      return {
        text: lines.map((l) => `${l}\n`).join(""),
        containers: ["Events"],
        activeContainer: "Events",
      };
    }
    return { text: "", containers: [], activeContainer: "" };
  }

  fetchMetricSeries(
    typeId: string,
    resourceId: string,
    _accountId: string,
    timeRange?: { startMs: number; endMs: number },
  ): Promise<MetricSeries[]> {
    if (typeId !== SERVER) return Promise.resolve([]);
    return fetchServerMetrics(this, externalIdOf(resourceId), timeRange);
  }

  fetchQuotas(_accountId: string): Promise<QuotaUsage[]> {
    return fetchOpenStackQuotas(this);
  }

  async listStorageObjects(bucket: string, prefix: string): Promise<StorageObject[]> {
    const items = await this.api.get<
      Array<{
        name?: string;
        subdir?: string;
        bytes?: number;
        last_modified?: string;
        content_type?: string;
      }>
    >("object-store", `/${encodeURIComponent(bucket)}`, {
      format: "json",
      prefix,
      delimiter: "/",
      limit: 10000,
    });
    return (items ?? []).map((i) => {
      if (i.subdir) {
        return {
          key: i.subdir,
          name: i.subdir.slice(prefix.length).replace(/\/$/, ""),
          size: 0,
          lastModified: "",
          isDirectory: true,
        };
      }
      const key = i.name ?? "";
      return {
        key,
        name: key.slice(prefix.length),
        size: i.bytes ?? 0,
        lastModified: i.last_modified ?? "",
        isDirectory: false,
        ...(i.content_type ? { contentType: i.content_type } : {}),
      };
    });
  }

  async uploadStorageObject(
    bucket: string,
    key: string,
    file: File,
    onProgress?: (pct: number) => void,
  ): Promise<void> {
    const bytes = new Uint8Array(await file.arrayBuffer());
    await this.api.request(
      "object-store",
      "PUT",
      `/${encodeURIComponent(bucket)}/${key.split("/").map(encodeURIComponent).join("/")}`,
      {
        rawBody: bytes,
        headers: { "Content-Type": file.type || "application/octet-stream" },
      },
    );
    onProgress?.(100);
  }

  async makeStorageFolder(bucket: string, key: string): Promise<void> {
    const k = key.endsWith("/") ? key : `${key}/`;
    await this.api.request(
      "object-store",
      "PUT",
      `/${encodeURIComponent(bucket)}/${k.split("/").map(encodeURIComponent).join("/")}`,
      {
        rawBody: "",
        headers: { "Content-Type": "application/directory" },
      },
    );
  }

  async deleteStorageObject(bucket: string, key: string): Promise<void> {
    const path = (k: string) =>
      `/${encodeURIComponent(bucket)}/${k.split("/").map(encodeURIComponent).join("/")}`;
    if (!key.endsWith("/")) {
      await this.api.request("object-store", "DELETE", path(key));
      return;
    }
    const all = await this.api.get<Array<{ name: string }>>(
      "object-store",
      `/${encodeURIComponent(bucket)}`,
      { format: "json", prefix: key, limit: 10000 },
    );
    await mapLimit(all ?? [], 6, (o) =>
      this.api.request("object-store", "DELETE", path(o.name)).catch(() => undefined),
    );
    await this.api.request("object-store", "DELETE", path(key)).catch(() => undefined);
  }

  // ---------------------------------------------------------------------------
  // Mutations
  // ---------------------------------------------------------------------------

  getCreateConfig(typeId: string, parentResourceId?: string): Promise<CreateResourceConfig> {
    return openstackCreateConfig(this, typeId, parentResourceId);
  }

  createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
    parentResourceId?: string,
  ): Promise<ResourceCreateReturn> {
    return openstackCreateResource(this, typeId, accountId, fields, parentResourceId);
  }

  invokeAction(
    typeId: string,
    resourceId: string,
    actionId: string,
    _accountId: string,
  ): Promise<void> {
    return openstackInvokeAction(this, typeId, externalIdOf(resourceId), actionId);
  }

  executeNoSqlCommand(
    typeId: string,
    resourceId: string,
    _accountId: string,
    command: string,
    args: (string | number)[],
  ): Promise<unknown> {
    return openstackPrompt(this, typeId, externalIdOf(resourceId), command, args);
  }

  deleteResource(typeId: string, resourceId: string, _accountId: string): Promise<void> {
    return openstackDelete(this, typeId, externalIdOf(resourceId));
  }

  updateResource(
    typeId: string,
    resourceId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    return openstackUpdate(this, typeId, resourceId, accountId, fields);
  }

  attachResource(
    sourceTypeId: string,
    sourceResourceId: string,
    targetTypeId: string,
    targetResourceId: string,
    _accountId: string,
  ): Promise<void> {
    return openstackAttach(
      this,
      sourceTypeId,
      externalIdOf(sourceResourceId),
      targetTypeId,
      externalIdOf(targetResourceId),
    );
  }
}

export { resourceTypes };
