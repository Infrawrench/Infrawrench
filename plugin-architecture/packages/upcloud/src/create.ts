/**
 * Create forms and create calls. Zones, plans (with prices), templates,
 * networks, Kubernetes versions and plans, database engines and plans, load
 * balancer plans and Object Storage regions all come from live listings.
 */

import type {
  CreateFieldConfig,
  CreateResourceConfig,
  ImageOption,
  PolicyOption,
  RegionOption,
  ResourceInstance,
  SelectOption,
  SizeOption,
} from "@infrawrench/plugin-base";
import {
  type UpCloudApi,
  intOr,
  labelsFromText,
  listValue,
  splitPair,
  trailingId,
  unwrap,
} from "./api.js";
import {
  type Json,
  mapBackup,
  mapBucket,
  mapCluster,
  mapDatabase,
  mapDatabaseUser,
  mapFloatingIp,
  mapLoadBalancer,
  mapLogicalDb,
  mapNetwork,
  mapNodeGroup,
  mapObjectStorage,
  mapOsUser,
  mapRouter,
  mapServer,
  mapStorage,
  mapTemplate,
  str,
} from "./listers.js";

const FLAGS: Record<string, string> = {
  fi: "🇫🇮",
  de: "🇩🇪",
  nl: "🇳🇱",
  uk: "🇬🇧",
  us: "🇺🇸",
  sg: "🇸🇬",
  au: "🇦🇺",
  es: "🇪🇸",
  pl: "🇵🇱",
  se: "🇸🇪",
  dk: "🇩🇰",
  no: "🇳🇴",
};

/** UpCloud bills hourly up to a monthly price equal to 672 hours (four weeks). */
export const HOURS_PER_MONTH = 672;

export interface Catalog {
  zones: Array<{ id: string; description: string }>;
  plans: Json[];
  prices: Record<string, Record<string, { price?: number; amount?: number }>>;
}

export async function loadCatalog(api: UpCloudApi): Promise<Catalog> {
  const [zones, plans, prices] = await Promise.all([
    api
      .get("/zone")
      .then((r) => unwrap<Json>(r, "zones", "zone"))
      .catch(() => [] as Json[]),
    api
      .get("/plan")
      .then((r) => unwrap<Json>(r, "plans", "plan"))
      .catch(() => [] as Json[]),
    api
      .get("/price")
      .then((r) => unwrap<Json>(r, "prices", "zone"))
      .catch(() => [] as Json[]),
  ]);
  const byZone: Catalog["prices"] = {};
  for (const z of prices) byZone[str(z["name"])] = z as Record<string, { price?: number }>;
  return {
    zones: zones
      .filter((z) => z["public"] !== "no")
      .map((z) => ({ id: str(z["id"]), description: str(z["description"]) })),
    plans,
    prices: byZone,
  };
}

export function zoneOptions(catalog: Catalog, allowed?: string[]): RegionOption[] {
  return catalog.zones
    .filter((z) => !allowed || allowed.includes(z.id))
    .map((z) => {
      const flag = FLAGS[z.id.split("-")[0] ?? ""];
      return { id: z.id, label: z.description || z.id, location: z.id, ...(flag ? { flag } : {}) };
    });
}

/** Monthly price of a server plan in a zone (prices are cents per hour). */
export function planMonthly(catalog: Catalog, plan: string, zone?: string): number | undefined {
  const zones = zone ? [zone] : Object.keys(catalog.prices);
  for (const z of zones) {
    const p = catalog.prices[z]?.[`server_plan_${plan}`]?.price;
    if (typeof p === "number") return Math.round((p / 100) * HOURS_PER_MONTH * 100) / 100;
  }
  return undefined;
}

function planFamily(name: string): string {
  if (name.startsWith("DEV-")) return "Developer";
  if (name.startsWith("HICPU-")) return "High CPU";
  if (name.startsWith("HIMEM-")) return "High Memory";
  if (name.startsWith("GPU-")) return "GPU";
  if (name.startsWith("CLOUDNATIVE-")) return "Cloud Native";
  return "General Purpose";
}

export function planSizeOptions(catalog: Catalog, zone?: string): SizeOption[] {
  return catalog.plans.map((p) => {
    const name = str(p["name"]);
    const price = planMonthly(catalog, name, zone);
    return {
      id: name,
      label: name,
      vcpus: Number(p["core_number"] ?? 0),
      memoryMb: Number(p["memory_amount"] ?? 0),
      diskGb: Number(p["storage_size"] ?? 0),
      category: planFamily(name),
      ...(price !== undefined ? { priceMonthly: price } : {}),
    };
  });
}

export async function templateOptions(api: UpCloudApi): Promise<ImageOption[]> {
  const list = unwrap<Json>(
    await api.get("/storage/template").catch(() => ({})),
    "storages",
    "storage",
  );
  return list
    .filter((t) => t["type"] === "template" && t["state"] !== "error")
    .map((t) => {
      const title = str(t["title"]);
      const owned = t["access"] !== "public";
      return {
        id: str(t["uuid"]),
        label: title,
        family: title.split(" ")[0]?.toLowerCase() ?? "",
        category: owned ? "My Templates" : (title.split(" ")[0] ?? "Other"),
        ...(owned ? { isOwned: true } : {}),
        ...(t["template_type"] === "cloud-init" ? { description: "cloud-init" } : {}),
      };
    });
}

const yesNo = (
  key: string,
  label: string,
  def: "true" | "false",
  description?: string,
): CreateFieldConfig => ({
  key,
  label,
  kind: "select",
  required: false,
  defaultValue: def,
  options: [
    { id: "true", label: "Yes" },
    { id: "false", label: "No" },
  ],
  ...(description ? { description } : {}),
});

const picker = (
  key: string,
  label: string,
  typeId: string,
  outputKey: string,
  opts: { required?: boolean; description?: string } = {},
): CreateFieldConfig => ({
  key,
  label,
  kind: "resource-picker",
  required: opts.required ?? false,
  associationSources: [{ pluginId: "upcloud", resourceTypeId: typeId, outputKey }],
  scopeFromFieldKey: "zone",
  ...(opts.description ? { description: opts.description } : {}),
});

const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

export async function serverIpOptions(api: UpCloudApi): Promise<PolicyOption[]> {
  const ips = unwrap<Json>(
    await api.get("/ip_address").catch(() => ({})),
    "ip_addresses",
    "ip_address",
  );
  return ips
    .filter((ip) => ip["family"] === "IPv4" && ip["server"])
    .map((ip) => ({
      id: str(ip["address"]),
      label: str(ip["address"]),
      description: `${str(ip["access"])} · server ${str(ip["server"]).slice(0, 8)}`,
      category: str(ip["zone"]),
    }));
}

export async function getCreateConfig(
  api: UpCloudApi,
  catalog: () => Promise<Catalog>,
  typeId: string,
  parentResourceId?: string,
): Promise<CreateResourceConfig> {
  switch (typeId) {
    case "server": {
      const [cat, templates] = await Promise.all([catalog(), templateOptions(api)]);
      const zones = zoneOptions(cat);
      const sizes = planSizeOptions(cat);
      return {
        fields: [
          { key: "hostname", label: "Hostname", kind: "text", required: true },
          {
            key: "title",
            label: "Title",
            kind: "text",
            required: false,
            description: "Defaults to the hostname",
          },
          {
            key: "zone",
            label: "Zone",
            kind: "region-picker",
            required: true,
            regions: zones,
            defaultValue: zones.find((z) => z.id === "fi-hel1")?.id ?? zones[0]?.id ?? "",
          },
          {
            key: "plan",
            label: "Plan",
            kind: "size-picker",
            required: true,
            sizes,
            defaultValue: sizes.find((s) => s.id === "1xCPU-2GB")?.id ?? sizes[0]?.id ?? "",
          },
          {
            key: "template",
            label: "Operating System",
            kind: "image-picker",
            required: true,
            images: templates,
            defaultValue:
              templates.find((t) => /Ubuntu Server 24\.04/i.test(t.label))?.id ??
              templates[0]?.id ??
              "",
          },
          {
            key: "diskSizeGb",
            label: "Disk Size",
            kind: "disk-slider",
            required: false,
            minGb: 10,
            maxGb: 4096,
            defaultGb: 50,
            stepGb: 10,
            description: "Defaults to the plan's included storage",
          },
          { key: "sshPublicKey", label: "SSH Key", kind: "ssh-key-picker", required: false },
          {
            key: "userData",
            label: "Cloud-init User Data",
            kind: "code",
            codeLanguage: "yaml",
            required: false,
          },
          picker("networkId", "Private Network", "network", "networkId", {
            description: "Add an interface on one of your private networks",
          }),
          yesNo("ipv6", "Public IPv6", "true"),
          {
            key: "simpleBackup",
            label: "Simple Backup",
            kind: "select",
            required: false,
            defaultValue: "no",
            options: [
              { id: "no", label: "Off" },
              { id: "dailies", label: "Daily (kept a week)" },
              { id: "weeklies", label: "Weekly (daily plus 4 weekly)" },
              { id: "monthlies", label: "Monthly (daily, weekly and monthly)" },
            ],
          },
          {
            key: "labels",
            label: "Labels",
            kind: "string-list",
            required: false,
            addLabel: "Add key=value",
          },
        ],
      };
    }
    case "storage": {
      const cat = await catalog();
      const zones = zoneOptions(cat);
      return {
        fields: [
          { key: "title", label: "Title", kind: "text", required: true },
          {
            key: "zone",
            label: "Zone",
            kind: "region-picker",
            required: true,
            regions: zones,
            defaultValue: zones[0]?.id ?? "",
          },
          {
            key: "sizeGb",
            label: "Size",
            kind: "disk-slider",
            required: true,
            minGb: 1,
            maxGb: 4096,
            defaultGb: 50,
            stepGb: 1,
          },
          {
            key: "tier",
            label: "Tier",
            kind: "select",
            required: true,
            defaultValue: "maxiops",
            options: [
              { id: "maxiops", label: "MaxIOPS" },
              { id: "standard", label: "Standard" },
              { id: "hdd", label: "HDD (archive)" },
            ],
          },
          yesNo("encrypted", "Encrypt at rest", "true"),
          {
            key: "backupInterval",
            label: "Automatic Backups",
            kind: "select",
            required: false,
            defaultValue: "",
            options: [
              { id: "", label: "Off" },
              { id: "daily", label: "Daily" },
              ...DAYS.map((d) => ({ id: d.slice(0, 3), label: `Weekly on ${d}` })),
            ],
          },
          {
            key: "backupRetention",
            label: "Keep Backups (days)",
            kind: "number",
            required: false,
            defaultValue: "7",
            minValue: 1,
            maxValue: 1095,
          },
          picker("serverId", "Attach to Server", "server", "serverId"),
        ],
      };
    }
    case "backup":
      return {
        fields: [
          picker("storageId", "Storage", "storage", "storageId", { required: true }),
          {
            key: "title",
            label: "Title",
            kind: "text",
            required: true,
            defaultValue: `backup-${new Date().toISOString().slice(0, 10)}`,
          },
        ],
      };
    case "template":
      return {
        fields: [
          picker("storageId", "Storage", "storage", "storageId", {
            required: true,
            description: "The storage must be detached or its server stopped",
          }),
          { key: "title", label: "Title", kind: "text", required: true },
        ],
      };
    case "network": {
      const zones = zoneOptions(await catalog());
      return {
        fields: [
          { key: "name", label: "Name", kind: "text", required: true },
          {
            key: "zone",
            label: "Zone",
            kind: "region-picker",
            required: true,
            regions: zones,
            defaultValue: zones[0]?.id ?? "",
          },
          {
            key: "cidr",
            label: "IPv4 Range",
            kind: "text",
            required: true,
            defaultValue: "10.0.10.0/24",
          },
          yesNo("dhcp", "DHCP", "true"),
          yesNo(
            "dhcpDefaultRoute",
            "DHCP default route",
            "false",
            "Send the default route over this network",
          ),
          picker("routerId", "Router", "router", "routerId"),
        ],
      };
    }
    case "router":
      return { fields: [{ key: "name", label: "Name", kind: "text", required: true }] };
    case "floating-ip": {
      const zones = zoneOptions(await catalog());
      return {
        fields: [
          {
            key: "zone",
            label: "Zone",
            kind: "region-picker",
            required: true,
            regions: zones,
            defaultValue: zones[0]?.id ?? "",
          },
          picker("serverId", "Assign to Server", "server", "serverId"),
        ],
      };
    }
    case "kubernetes-cluster": {
      const [cat, versions, plans] = await Promise.all([
        catalog(),
        api.get<Array<{ id: string; version: string }>>("/kubernetes/versions").catch(() => []),
        api
          .get<Array<{ name: string; deprecated?: boolean; max_nodes?: number }>>(
            "/kubernetes/plans",
          )
          .catch(() => []),
      ]);
      const zones = zoneOptions(cat);
      const sizes = planSizeOptions(cat);
      return {
        fields: [
          { key: "name", label: "Name", kind: "text", required: true },
          {
            key: "zone",
            label: "Zone",
            kind: "region-picker",
            required: true,
            regions: zones,
            defaultValue: zones.find((z) => z.id === "de-fra1")?.id ?? zones[0]?.id ?? "",
          },
          {
            key: "version",
            label: "Kubernetes Version",
            kind: "select",
            required: true,
            options: versions.map((v) => ({ id: v.id, label: v.version || v.id })),
            defaultValue: versions[0]?.id ?? "",
          },
          {
            key: "plan",
            label: "Control Plane",
            kind: "select",
            required: true,
            options: plans
              .filter((p) => !p.deprecated)
              .map((p) => ({
                id: p.name,
                label: p.name,
                ...(p.max_nodes ? { description: `Up to ${p.max_nodes} nodes` } : {}),
              })),
            defaultValue: plans.find((p) => p.name === "development")?.name ?? plans[0]?.name ?? "",
          },
          picker("network", "Private Network", "network", "networkId", {
            required: true,
            description: "A private network with DHCP in the same zone",
          }),
          {
            key: "controlPlaneIpFilter",
            label: "API Allowed IPs",
            kind: "string-list",
            required: false,
            addLabel: "Add CIDR",
            defaultValue: "0.0.0.0/0",
          },
          yesNo(
            "privateNodeGroups",
            "Private node groups",
            "false",
            "Nodes get no public IP; needs a NAT gateway",
          ),
          {
            key: "groupName",
            label: "Node Group Name",
            kind: "text",
            required: true,
            defaultValue: "default",
          },
          {
            key: "nodePlan",
            label: "Node Plan",
            kind: "size-picker",
            required: true,
            sizes,
            defaultValue: sizes.find((s) => s.id === "2xCPU-4GB")?.id ?? sizes[0]?.id ?? "",
          },
          {
            key: "nodeCount",
            label: "Nodes",
            kind: "number",
            required: true,
            minValue: 1,
            maxValue: 100,
            defaultValue: "2",
          },
        ],
      };
    }
    case "node-group": {
      const sizes = planSizeOptions(await catalog());
      const fields: CreateFieldConfig[] = [];
      if (!parentResourceId)
        fields.push({
          ...picker("clusterId", "Cluster", "kubernetes-cluster", "clusterId", { required: true }),
        });
      fields.push(
        { key: "name", label: "Name", kind: "text", required: true },
        {
          key: "plan",
          label: "Node Plan",
          kind: "size-picker",
          required: true,
          sizes,
          defaultValue: sizes.find((s) => s.id === "2xCPU-4GB")?.id ?? sizes[0]?.id ?? "",
        },
        {
          key: "count",
          label: "Nodes",
          kind: "number",
          required: true,
          minValue: 0,
          maxValue: 100,
          defaultValue: "2",
        },
        yesNo("antiAffinity", "Spread nodes across hosts", "false"),
        { key: "sshPublicKey", label: "SSH Key", kind: "ssh-key-picker", required: false },
      );
      return { fields };
    }
    case "database": {
      const [cat, types] = await Promise.all([
        catalog(),
        api
          .get<Record<string, Json>>("/database/service-types")
          .catch(() => ({}) as Record<string, Json>),
      ]);
      const zones = zoneOptions(cat);
      const engineIds = Object.keys(types).filter((t) =>
        ["pg", "mysql", "valkey", "opensearch"].includes(t),
      );
      const sizes: SizeOption[] = [];
      for (const engine of engineIds) {
        for (const p of (types[engine]?.["service_plans"] as Json[] | undefined) ?? []) {
          sizes.push({
            id: `${engine}:${str(p["plan"])}`,
            label: str(p["plan"]),
            vcpus: Number(p["core_number"] ?? 0),
            memoryMb: Number(p["memory_amount"] ?? 0),
            diskGb: Math.round(Number(p["storage_size"] ?? 0) / 1024),
            category: `${Number(p["node_count"] ?? 1)} node${Number(p["node_count"] ?? 1) === 1 ? "" : "s"}`,
            availableFor: [engine],
          });
        }
      }
      const label: Record<string, string> = {
        pg: "PostgreSQL",
        mysql: "MySQL",
        valkey: "Valkey",
        opensearch: "OpenSearch",
      };
      return {
        fields: [
          { key: "title", label: "Title", kind: "text", required: true },
          {
            key: "type",
            label: "Engine",
            kind: "select",
            required: true,
            options: engineIds.map((e) => ({
              id: e,
              label: label[e] ?? e,
              description: `Latest ${str(types[e]?.["latest_available_version"])}`,
            })),
            defaultValue: engineIds.includes("pg") ? "pg" : (engineIds[0] ?? ""),
          },
          {
            key: "zone",
            label: "Zone",
            kind: "region-picker",
            required: true,
            regions: zones,
            defaultValue: zones[0]?.id ?? "",
          },
          {
            key: "plan",
            label: "Plan",
            kind: "size-picker",
            required: true,
            sizes,
            filterByFieldKey: "type",
            defaultValue: sizes[0]?.id ?? "",
          },
          {
            key: "ipFilter",
            label: "Allowed IPs",
            kind: "string-list",
            required: false,
            addLabel: "Add CIDR",
            description:
              "Addresses allowed to connect; leave empty to allow none until you add some",
          },
          yesNo(
            "publicAccess",
            "Public access",
            "true",
            "Reachable from the internet (still filtered by the allowed IPs)",
          ),
          {
            key: "maintenanceDow",
            label: "Maintenance Day",
            kind: "select",
            required: false,
            defaultValue: "sunday",
            options: DAYS.map((d) => ({ id: d, label: d })),
          },
          {
            key: "maintenanceTime",
            label: "Maintenance Time (UTC)",
            kind: "text",
            required: false,
            defaultValue: "03:00:00",
          },
          yesNo("terminationProtection", "Termination protection", "true"),
        ],
      };
    }
    case "database-user":
    case "database-db": {
      const fields: CreateFieldConfig[] = [];
      if (!parentResourceId) {
        const dbs = await api.paged<Json>("/database").catch(() => [] as Json[]);
        fields.push({
          key: "databaseId",
          label: "Database",
          kind: "select",
          required: true,
          options: dbs
            .filter((d) => typeId === "database-user" || ["pg", "mysql"].includes(str(d["type"])))
            .map((d) => ({
              id: str(d["uuid"]),
              label: str(d["title"]) || str(d["name"]),
              description: `${str(d["type"])} · ${str(d["zone"])}`,
            })),
        });
      }
      if (typeId === "database-user") {
        fields.push(
          { key: "username", label: "Username", kind: "text", required: true },
          {
            key: "password",
            label: "Password",
            kind: "password",
            required: false,
            description: "Leave empty and UpCloud generates one",
          },
        );
      } else {
        fields.push({ key: "name", label: "Name", kind: "text", required: true });
      }
      return { fields };
    }
    case "load-balancer": {
      const [cat, plans, ips] = await Promise.all([
        catalog(),
        api
          .get<Array<{ name: string; server_number?: number; per_server_max_sessions?: number }>>(
            "/load-balancer/plans?limit=100&offset=0",
          )
          .catch(() => []),
        serverIpOptions(api),
      ]);
      const zones = zoneOptions(cat);
      return {
        fields: [
          { key: "name", label: "Name", kind: "text", required: true },
          {
            key: "zone",
            label: "Zone",
            kind: "region-picker",
            required: true,
            regions: zones,
            defaultValue: zones[0]?.id ?? "",
          },
          {
            key: "plan",
            label: "Plan",
            kind: "select",
            required: true,
            options: plans.map((p) => ({
              id: p.name,
              label: p.name,
              description: `${p.server_number ?? 1} node(s), ${p.per_server_max_sessions ?? ""} sessions each`,
            })),
            defaultValue: plans[0]?.name ?? "development",
          },
          picker("network", "Private Network", "network", "networkId", {
            required: true,
            description: "Backends are reached over this network",
          }),
          {
            key: "mode",
            label: "Mode",
            kind: "select",
            required: true,
            defaultValue: "http",
            options: [
              { id: "http", label: "HTTP" },
              { id: "tcp", label: "TCP" },
            ],
          },
          {
            key: "port",
            label: "Listen Port",
            kind: "number",
            required: true,
            defaultValue: "80",
            minValue: 1,
            maxValue: 65535,
          },
          {
            key: "backendPort",
            label: "Backend Port",
            kind: "number",
            required: true,
            defaultValue: "80",
            minValue: 1,
            maxValue: 65535,
          },
          {
            key: "members",
            label: "Backend Servers",
            kind: "policy-picker",
            required: false,
            policies: ips,
            description: "Pick the servers' private (utility or SDN) addresses",
          },
        ],
      };
    }
    case "object-storage": {
      const regions = await api
        .get<Array<{ name: string; primary_zone?: string }>>("/object-storage-2/regions")
        .catch(() => []);
      return {
        fields: [
          { key: "name", label: "Name", kind: "text", required: true },
          {
            key: "region",
            label: "Region",
            kind: "select",
            required: true,
            options: regions.map((r) => ({
              id: r.name,
              label: r.name,
              ...(r.primary_zone ? { description: `Primary zone ${r.primary_zone}` } : {}),
            })),
            defaultValue: regions[0]?.name ?? "",
          },
        ],
      };
    }
    case "bucket":
    case "object-storage-user": {
      const fields: CreateFieldConfig[] = [];
      if (!parentResourceId) {
        const list = await api.paged<Json>("/object-storage-2").catch(() => [] as Json[]);
        fields.push({
          key: "serviceId",
          label: "Object Storage",
          kind: "select",
          required: true,
          options: list.map((s) => ({
            id: str(s["uuid"]),
            label: str(s["name"]),
            description: str(s["region"]),
          })),
        });
      }
      fields.push(
        typeId === "bucket"
          ? { key: "name", label: "Name", kind: "text", required: true }
          : { key: "username", label: "Username", kind: "text", required: true },
      );
      if (typeId === "object-storage-user") {
        fields.push(yesNo("fullAccess", "Grant full S3 access (ECSS3FullAccess)", "true"));
      }
      return { fields };
    }
    default:
      throw new Error(`UpCloud plugin: no create form for "${typeId}"`);
  }
}

export function simpleBackupValue(plan: string | undefined): string {
  return !plan || plan === "no" ? "no" : `0400,${plan}`;
}

/** Interfaces for a new server: public IPv4, utility, optional IPv6 and SDN. */
export function serverInterfaces(fields: Record<string, string>): Json {
  const iface = (type: string, family: string, network?: string) => ({
    ip_addresses: { ip_address: [{ family }] },
    type,
    ...(network ? { network } : {}),
  });
  const list = [iface("public", "IPv4"), iface("utility", "IPv4")];
  if (fields["ipv6"] !== "false") list.push(iface("public", "IPv6"));
  if (fields["networkId"]) list.push(iface("private", "IPv4", fields["networkId"]));
  return { interfaces: { interface: list } };
}

export async function createResource(
  api: UpCloudApi,
  catalog: () => Promise<Catalog>,
  typeId: string,
  accountId: string,
  fields: Record<string, string>,
  parentResourceId?: string,
): Promise<ResourceInstance> {
  const parentId = parentResourceId ? trailingId(parentResourceId) : "";
  switch (typeId) {
    case "server": {
      const cat = await catalog();
      const plan = cat.plans.find((p) => str(p["name"]) === fields["plan"]);
      const size = intOr(fields["diskSizeGb"]) ?? Number(plan?.["storage_size"] ?? 25);
      const keys = fields["sshPublicKey"] ? [fields["sshPublicKey"].trim()] : [];
      const labels = labelsFromText(fields["labels"]);
      const res = await api.send<{ server?: Json }>("POST", "/server", {
        server: {
          zone: fields["zone"],
          title: fields["title"] || fields["hostname"],
          hostname: fields["hostname"],
          plan: fields["plan"],
          metadata: "yes",
          ...(keys.length ? { login_user: { username: "root", ssh_keys: { ssh_key: keys } } } : {}),
          password_delivery: "none",
          ...(fields["userData"] ? { user_data: fields["userData"] } : {}),
          simple_backup: simpleBackupValue(fields["simpleBackup"]),
          ...(labels.length ? { labels: { label: labels } } : {}),
          storage_devices: {
            storage_device: [
              {
                action: "clone",
                storage: fields["template"],
                title: `${fields["hostname"]}-disk`,
                size,
                tier: "maxiops",
              },
            ],
          },
          networking: serverInterfaces(fields),
        },
      });
      if (!res.server) throw new Error("UpCloud accepted the request but returned no server.");
      return mapServer(res.server, accountId);
    }
    case "storage": {
      const interval = fields["backupInterval"];
      const res = await api.send<{ storage?: Json }>("POST", "/storage", {
        storage: {
          size: String(intOr(fields["sizeGb"], 50)),
          tier: fields["tier"] || "maxiops",
          title: fields["title"],
          zone: fields["zone"],
          ...(fields["encrypted"] !== "false" ? { encrypted: "yes" } : {}),
          ...(interval
            ? {
                backup_rule: {
                  interval,
                  time: "0430",
                  retention: String(intOr(fields["backupRetention"], 7)),
                },
              }
            : {}),
        },
      });
      if (!res.storage) throw new Error("UpCloud accepted the request but returned no storage.");
      if (fields["serverId"]) {
        await api.send("POST", `/server/${fields["serverId"]}/storage/attach`, {
          storage_device: { type: "disk", storage: str(res.storage["uuid"]) },
        });
      }
      return mapStorage(res.storage, accountId);
    }
    case "backup": {
      if (!fields["storageId"]) throw new Error("Pick the storage to back up.");
      const res = await api.send<{ storage?: Json }>(
        "POST",
        `/storage/${fields["storageId"]}/backup`,
        {
          storage: { title: fields["title"] },
        },
      );
      return mapBackup(res.storage ?? { uuid: "", title: fields["title"] }, accountId);
    }
    case "template": {
      if (!fields["storageId"]) throw new Error("Pick the storage to turn into a template.");
      const res = await api.send<{ storage?: Json }>(
        "POST",
        `/storage/${fields["storageId"]}/templatize`,
        {
          storage: { title: fields["title"] },
        },
      );
      return mapTemplate(res.storage ?? { uuid: "", title: fields["title"] }, accountId);
    }
    case "network": {
      const res = await api.send<{ network?: Json }>("POST", "/network", {
        network: {
          name: fields["name"],
          zone: fields["zone"],
          ...(fields["routerId"] ? { router: fields["routerId"] } : {}),
          ip_networks: {
            ip_network: [
              {
                address: fields["cidr"],
                dhcp: fields["dhcp"] === "false" ? "no" : "yes",
                dhcp_default_route: fields["dhcpDefaultRoute"] === "true" ? "yes" : "no",
                family: "IPv4",
              },
            ],
          },
        },
      });
      if (!res.network) throw new Error("UpCloud accepted the request but returned no network.");
      return mapNetwork(res.network, accountId);
    }
    case "router": {
      const res = await api.send<{ router?: Json }>("POST", "/router", {
        router: { name: fields["name"] },
      });
      if (!res.router) throw new Error("UpCloud accepted the request but returned no router.");
      return mapRouter(res.router, accountId);
    }
    case "floating-ip": {
      let mac = "";
      if (fields["serverId"]) mac = await publicMac(api, fields["serverId"]);
      const res = await api.send<{ ip_address?: Json }>("POST", "/ip_address", {
        ip_address: {
          family: "IPv4",
          floating: "yes",
          ...(mac ? { mac } : { zone: fields["zone"] }),
        },
      });
      if (!res.ip_address) throw new Error("UpCloud accepted the request but returned no address.");
      return mapFloatingIp(res.ip_address, accountId);
    }
    case "kubernetes-cluster": {
      const filter = listValue(fields["controlPlaneIpFilter"]);
      const res = await api.send<Json>("POST", "/kubernetes", {
        name: fields["name"],
        zone: fields["zone"],
        version: fields["version"],
        plan: fields["plan"],
        network: fields["network"],
        control_plane_ip_filter: filter.length ? filter : ["0.0.0.0/0"],
        private_node_groups: fields["privateNodeGroups"] === "true",
        node_groups: [
          {
            name: fields["groupName"] || "default",
            plan: fields["nodePlan"],
            count: intOr(fields["nodeCount"], 2),
          },
        ],
      });
      return mapCluster(res, accountId);
    }
    case "node-group": {
      const clusterId = fields["clusterId"] || parentId;
      if (!clusterId) throw new Error("Pick the cluster.");
      const keys = fields["sshPublicKey"] ? [fields["sshPublicKey"].trim()] : [];
      const group = await api.send<Json>("POST", `/kubernetes/${clusterId}/node-groups`, {
        name: fields["name"],
        plan: fields["plan"],
        count: intOr(fields["count"], 2),
        anti_affinity: fields["antiAffinity"] === "true",
        ...(keys.length ? { ssh_keys: keys } : {}),
      });
      const cluster = await api
        .get<Json>(`/kubernetes/${clusterId}`)
        .catch(() => ({ uuid: clusterId }) as Json);
      return mapNodeGroup(group, cluster, accountId);
    }
    case "database": {
      const [type, plan] = splitPlan(fields["plan"], fields["type"]);
      const res = await api.send<Json>("POST", "/database", {
        hostname_prefix: slug(fields["title"] ?? "db"),
        title: fields["title"],
        type,
        plan,
        zone: fields["zone"],
        termination_protection: fields["terminationProtection"] !== "false",
        properties: {
          ip_filter: listValue(fields["ipFilter"]),
          public_access: fields["publicAccess"] !== "false",
        },
        maintenance: {
          dow: fields["maintenanceDow"] || "sunday",
          time: fields["maintenanceTime"] || "03:00:00",
        },
      });
      return mapDatabase(res, accountId);
    }
    case "database-user": {
      const databaseId = fields["databaseId"] || parentId;
      if (!databaseId) throw new Error("Pick the database.");
      const res = await api.send<Json>("POST", `/database/${databaseId}/users`, {
        username: fields["username"],
        ...(fields["password"] ? { password: fields["password"] } : {}),
      });
      const out = mapDatabaseUser(res, databaseId, accountId);
      if (res["password"])
        out.secretStates = [
          { fieldKey: "password", resolution: { kind: "plaintext", value: str(res["password"]) } },
        ];
      return out;
    }
    case "database-db": {
      const databaseId = fields["databaseId"] || parentId;
      if (!databaseId) throw new Error("Pick the database.");
      const res = await api.send<Json>("POST", `/database/${databaseId}/databases`, {
        name: fields["name"],
      });
      return mapLogicalDb({ name: str(res["name"]) || fields["name"] }, databaseId, accountId);
    }
    case "load-balancer": {
      const members = listValue(fields["members"]).map((ip, i) => ({
        name: `member-${i + 1}`,
        ip,
        port: intOr(fields["backendPort"], 80),
        weight: 100,
        max_sessions: 1000,
        type: "static",
        enabled: true,
      }));
      const res = await api.send<Json>("POST", "/load-balancer", {
        name: fields["name"],
        plan: fields["plan"] || "development",
        zone: fields["zone"],
        network_uuid: fields["network"],
        configured_status: "started",
        frontends: [
          {
            name: "default",
            mode: fields["mode"] || "http",
            port: intOr(fields["port"], 80),
            default_backend: "default",
          },
        ],
        backends: [{ name: "default", members }],
        resolvers: [],
      });
      return mapLoadBalancer(res, accountId);
    }
    case "object-storage": {
      const res = await api.send<Json>("POST", "/object-storage-2", {
        name: fields["name"],
        region: fields["region"],
        configured_status: "started",
        networks: [{ name: "public", family: "IPv4", type: "public" }],
      });
      return mapObjectStorage(res, accountId);
    }
    case "bucket": {
      const serviceId = fields["serviceId"] || parentId;
      if (!serviceId) throw new Error("Pick the Object Storage service.");
      const res = await api.send<Json>("POST", `/object-storage-2/${serviceId}/buckets`, {
        name: fields["name"],
      });
      return mapBucket({ name: str(res["name"]) || fields["name"] }, serviceId, accountId);
    }
    case "object-storage-user": {
      const serviceId = fields["serviceId"] || parentId;
      if (!serviceId) throw new Error("Pick the Object Storage service.");
      const res = await api.send<Json>("POST", `/object-storage-2/${serviceId}/users`, {
        username: fields["username"],
      });
      if (fields["fullAccess"] !== "false") {
        await api.send(
          "POST",
          `/object-storage-2/${serviceId}/users/${encodeURIComponent(fields["username"] ?? "")}/policies`,
          {
            name: "ECSS3FullAccess",
          },
        );
      }
      return mapOsUser(
        { ...res, username: str(res["username"]) || fields["username"] },
        serviceId,
        accountId,
      );
    }
    default:
      throw new Error(`UpCloud plugin: cannot create "${typeId}"`);
  }
}

/** The database plan picker value is `{engine}:{plan}`. */
export function splitPlan(value: string | undefined, fallbackType?: string): [string, string] {
  const [a, b] = splitPair((value ?? "").replace(":", "/"));
  return b ? [a, b] : [fallbackType ?? "pg", a];
}

export function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 30) || "db"
  );
}

/** MAC of a server's public IPv4 interface (floating IPs attach by MAC). */
export async function publicMac(api: UpCloudApi, serverId: string): Promise<string> {
  const res = await api.get<{ server?: Json }>(`/server/${serverId}`);
  const ifaces = unwrap<Json>(
    (res.server?.["networking"] as Json | undefined) ?? {},
    "interfaces",
    "interface",
  );
  const pub = ifaces.find(
    (i) =>
      i["type"] === "public" &&
      unwrap<Json>(i, "ip_addresses", "ip_address").some((a) => a["family"] === "IPv4"),
  );
  if (!pub?.["mac"])
    throw new Error("That server has no public IPv4 interface to attach the address to.");
  return str(pub["mac"]);
}

export type { SelectOption };
