/**
 * Create forms and create calls. Every id the API wants (region, plan, OS,
 * application, snapshot, Kubernetes version, database plan, object storage
 * cluster and tier, firewall group, VPC) is a picker fed from the live API.
 */

import type {
  CreateFieldConfig,
  CreateResourceConfig,
  ImageOption,
  PolicyOption,
  ResourceInstance,
  SelectOption,
  SizeOption,
} from "@infrawrench/plugin-base";
import { dnsContentField } from "@infrawrench/plugin-base";
import { type VultrApi, intOr, listValue, toBase64, trailingId } from "./api.js";
import { type PlanCatalogCache, instanceSizeOptions } from "./catalog.js";
import {
  mapBlock,
  mapBucket,
  mapCluster,
  mapDatabase,
  mapDatabaseUser,
  mapDnsRecord,
  mapDomain,
  mapFirewallGroup,
  mapInstance,
  mapLoadBalancer,
  mapLogicalDb,
  mapNodePool,
  mapObjectStorage,
  mapReservedIp,
  mapSnapshot,
  mapSshKey,
  mapStartupScript,
  mapVpc,
} from "./listers.js";
import { regionOptions } from "./regions.js";
import type {
  VultrApplication,
  VultrBlock,
  VultrDatabase,
  VultrDatabasePlan,
  VultrDatabaseUser,
  VultrDomain,
  VultrDomainRecord,
  VultrFirewallGroup,
  VultrInstance,
  VultrKubernetesCluster,
  VultrLoadBalancer,
  VultrNodePool,
  VultrObjectStorage,
  VultrObjectStorageTier,
  VultrOs,
  VultrReservedIp,
  VultrSnapshot,
  VultrSshKey,
  VultrStartupScript,
  VultrVpc,
} from "./types.js";

export interface CreateContext {
  api: VultrApi;
  catalog: PlanCatalogCache;
}

/** Engine versions Vultr accepts; there is no listing endpoint for them. */
export const DATABASE_VERSIONS: Record<string, string[]> = {
  pg: ["18", "17", "16", "15", "14"],
  mysql: ["8"],
  valkey: ["7"],
  kafka: ["3.8", "3.7"],
};

export const ENGINE_LABELS: Record<string, string> = {
  pg: "PostgreSQL",
  mysql: "MySQL",
  valkey: "Valkey",
  kafka: "Apache Kafka",
};

const HIDDEN_OS_FAMILIES = new Set(["iso", "snapshot", "backup", "application", "marketplace_app"]);

const OS_FAMILY_LABELS: Record<string, string> = {
  ubuntu: "Ubuntu",
  debian: "Debian",
  centos: "CentOS",
  almalinux: "AlmaLinux",
  rockylinux: "Rocky Linux",
  fedora: "Fedora",
  "fedora-coreos": "Fedora CoreOS",
  flatcar: "Flatcar",
  alpinelinux: "Alpine",
  archlinux: "Arch Linux",
  opensuse: "openSUSE",
  freebsd: "FreeBSD",
  openbsd: "OpenBSD",
  windows: "Windows",
};

/** OS, one-click apps, marketplace apps and the account's snapshots as one picker. */
export async function imageOptions(api: VultrApi): Promise<ImageOption[]> {
  const [oses, apps, snapshots] = await Promise.all([
    api.all<VultrOs>("/os", "os").catch(() => [] as VultrOs[]),
    api
      .all<VultrApplication>("/applications", "applications")
      .catch(() => [] as VultrApplication[]),
    api.all<VultrSnapshot>("/snapshots", "snapshots").catch(() => [] as VultrSnapshot[]),
  ]);
  const out: ImageOption[] = [];
  for (const os of oses) {
    const family = os.family ?? "";
    if (HIDDEN_OS_FAMILIES.has(family)) continue;
    out.push({
      id: `os:${os.id}`,
      label: os.name ?? String(os.id),
      family,
      category: OS_FAMILY_LABELS[family] ?? (family || "Other"),
    });
  }
  for (const s of snapshots.filter((x) => x.status === "complete")) {
    out.push({
      id: `snapshot:${s.id}`,
      label: s.description || `Snapshot ${s.id.slice(0, 8)}`,
      category: "My Snapshots",
      isOwned: true,
    });
  }
  for (const a of apps) {
    const marketplace = a.type === "marketplace" && a.image_id;
    out.push({
      id: marketplace ? `image:${a.image_id}` : `app:${a.id}`,
      label: a.deploy_name || a.name || String(a.id),
      category: marketplace ? "Marketplace" : "One-Click Apps",
    });
  }
  return out;
}

/** The create body's boot source from an image-picker value. */
export function bootSource(value: string | undefined): Record<string, string | number> {
  const v = (value ?? "").trim();
  const [kind, ...rest] = v.split(":");
  const id = rest.join(":");
  switch (kind) {
    case "os":
      return { os_id: Number(id) };
    case "app":
      return { app_id: Number(id) };
    case "image":
      return { image_id: id };
    case "snapshot":
      return { snapshot_id: id };
    default:
      if (/^\d+$/.test(v)) return { os_id: Number(v) };
      throw new Error("Pick an operating system, application or snapshot to deploy.");
  }
}

/** Reuse a stored SSH key with the same key material, or upload it. */
export async function ensureSshKey(api: VultrApi, publicKey: string): Promise<string> {
  const material = publicKey.trim().split(/\s+/).slice(0, 2).join(" ");
  const keys = await api.all<VultrSshKey>("/ssh-keys", "ssh_keys");
  const existing = keys.find(
    (k) => (k.ssh_key ?? "").trim().split(/\s+/).slice(0, 2).join(" ") === material,
  );
  if (existing) return existing.id;
  const comment = publicKey.trim().split(/\s+/)[2];
  const created = await api.send<{ ssh_key?: VultrSshKey }>("POST", "/ssh-keys", {
    name: comment ? `infrawrench-${comment}`.slice(0, 64) : `infrawrench-${Date.now()}`,
    ssh_key: publicKey.trim(),
  });
  if (!created.ssh_key?.id) throw new Error("Vultr did not return the uploaded SSH key.");
  return created.ssh_key.id;
}

const tagsField: CreateFieldConfig = {
  key: "tags",
  label: "Tags",
  kind: "string-list",
  required: false,
  addLabel: "Add tag",
};

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
  resourceTypeId: string,
  outputKey: string,
  opts: { required?: boolean; description?: string } = {},
): CreateFieldConfig => ({
  key,
  label,
  kind: "resource-picker",
  required: opts.required ?? false,
  associationSources: [{ pluginId: "vultr", resourceTypeId, outputKey }],
  ...(opts.description ? { description: opts.description } : {}),
});

const regionField = (
  regions: Awaited<ReturnType<typeof regionOptions>>,
  def = "ewr",
): CreateFieldConfig => ({
  key: "region",
  label: "Region",
  kind: "region-picker",
  required: true,
  regions,
  defaultValue: regions.find((r) => r.id === def)?.id ?? regions[0]?.id ?? "",
});

async function startupScriptOptions(api: VultrApi): Promise<SelectOption[]> {
  const scripts = await api
    .all<VultrStartupScript>("/startup-scripts", "startup_scripts")
    .catch(() => [] as VultrStartupScript[]);
  return [
    { id: "", label: "None" },
    ...scripts
      .filter((s) => (s.type ?? "boot") === "boot")
      .map((s) => ({ id: s.id, label: s.name ?? s.id })),
  ];
}

export async function instancePolicyOptions(api: VultrApi): Promise<PolicyOption[]> {
  const instances = await api.all<VultrInstance>("/instances", "instances").catch(() => []);
  return instances.map((i) => ({
    id: i.id,
    label: i.label || i.hostname || i.id,
    description: `${i.main_ip ?? ""} · ${i.plan ?? ""}`,
    category: i.region ?? "Instances",
  }));
}

export function databasePlanOptions(plans: VultrDatabasePlan[]): SizeOption[] {
  return plans.map((p) => {
    const engines = Object.entries(p.supported_engines ?? {})
      .filter(([, ok]) => ok === true)
      .map(([engine]) => engine);
    return {
      id: p.id,
      label: p.id,
      vcpus: p.vcpu_count ?? 0,
      memoryMb: p.ram ?? 0,
      diskGb: p.disk ?? 0,
      category:
        `${p.number_of_nodes ?? 1} node${(p.number_of_nodes ?? 1) === 1 ? "" : "s"} · ${p.type ?? ""}`.trim(),
      ...(typeof p.monthly_cost === "number" ? { priceMonthly: p.monthly_cost } : {}),
      ...(engines.length ? { availableFor: engines } : {}),
    };
  });
}

const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

export const maintenanceFields = (current?: {
  dow?: string;
  time?: string;
}): CreateFieldConfig[] => [
  {
    key: "maintenanceDow",
    label: "Maintenance Day",
    kind: "select",
    required: false,
    defaultValue: current?.dow || "sunday",
    options: DAYS.map((d) => ({ id: d, label: d[0]!.toUpperCase() + d.slice(1) })),
  },
  {
    key: "maintenanceTime",
    label: "Maintenance Time (UTC)",
    kind: "select",
    required: false,
    defaultValue: current?.time || "02:00",
    options: Array.from({ length: 24 }, (_, h) => {
      const t = `${String(h).padStart(2, "0")}:00`;
      return { id: t, label: t };
    }),
  },
];

export async function getCreateConfig(
  ctx: CreateContext,
  typeId: string,
  parentResourceId?: string,
): Promise<CreateResourceConfig> {
  const { api } = ctx;
  switch (typeId) {
    case "instance": {
      const [regions, plans, images, scripts] = await Promise.all([
        regionOptions(api),
        ctx.catalog.get(),
        imageOptions(api),
        startupScriptOptions(api),
      ]);
      const sizes = instanceSizeOptions(plans);
      return {
        fields: [
          { key: "label", label: "Label", kind: "text", required: true },
          {
            key: "hostname",
            label: "Hostname",
            kind: "text",
            required: false,
            description: "Defaults to the label",
          },
          regionField(regions),
          {
            key: "plan",
            label: "Plan",
            kind: "size-picker",
            required: true,
            sizes,
            filterByFieldKey: "region",
            defaultValue: sizes.find((s) => s.id === "vc2-1c-1gb")?.id ?? sizes[0]?.id ?? "",
          },
          {
            key: "image",
            label: "Image",
            kind: "image-picker",
            required: true,
            images,
            defaultValue: images.find((i) => i.id === "os:2284")?.id ?? images[0]?.id ?? "",
          },
          { key: "sshPublicKey", label: "SSH Key", kind: "ssh-key-picker", required: false },
          {
            key: "scriptId",
            label: "Startup Script",
            kind: "select",
            required: false,
            defaultValue: "",
            options: scripts,
          },
          {
            key: "userData",
            label: "Cloud-init User Data",
            kind: "code",
            codeLanguage: "yaml",
            required: false,
          },
          yesNo("backups", "Automatic Backups", "false", "Billed at 20% of the plan price"),
          yesNo("enableIpv6", "IPv6", "true"),
          yesNo(
            "ddosProtection",
            "DDoS Protection",
            "false",
            "Billed per instance; not in every region",
          ),
          picker("firewallGroupId", "Firewall Group", "firewall-group", "firewallGroupId"),
          picker("vpcId", "VPC", "vpc", "vpcId", {
            description: "Attach a private network in the same region",
          }),
          tagsField,
        ],
      };
    }
    case "block-storage": {
      const regions = await regionOptions(api);
      return {
        fields: [
          { key: "label", label: "Label", kind: "text", required: false },
          regionField(regions),
          {
            key: "blockType",
            label: "Type",
            kind: "select",
            required: true,
            defaultValue: "high_perf",
            options: [
              { id: "high_perf", label: "NVMe (high performance)", description: "10 GB to 10 TB" },
              {
                id: "storage_opt",
                label: "HDD (storage optimized)",
                description: "40 GB to 40 TB",
              },
            ],
          },
          {
            key: "sizeGb",
            label: "Size",
            kind: "disk-slider",
            required: true,
            minGb: 10,
            maxGb: 40000,
            defaultGb: 50,
            stepGb: 10,
          },
          picker("instanceId", "Attach to Instance", "instance", "instanceId", {
            description: "Must be in the same region",
          }),
        ],
      };
    }
    case "snapshot":
      return {
        fields: [
          picker("instanceId", "Instance", "instance", "instanceId", { required: true }),
          { key: "description", label: "Description", kind: "text", required: false },
        ],
      };
    case "kubernetes-cluster": {
      const [regions, plans, versions] = await Promise.all([
        regionOptions(api, "kubernetes"),
        ctx.catalog.get(),
        api.get<{ versions?: string[] }>("/kubernetes/versions").catch(() => ({ versions: [] })),
      ]);
      const versionOptions = (versions.versions ?? []).map((v) => ({ id: v, label: v }));
      const sizes = instanceSizeOptions(plans);
      return {
        fields: [
          { key: "label", label: "Label", kind: "text", required: true },
          regionField(regions),
          {
            key: "version",
            label: "Kubernetes Version",
            kind: "select",
            required: true,
            options: versionOptions,
            defaultValue: versionOptions[0]?.id ?? "",
          },
          yesNo("haControlPlanes", "HA Control Plane", "false", "Billed per cluster"),
          yesNo(
            "enableFirewall",
            "Managed Firewall",
            "true",
            "Creates a firewall group for the nodes",
          ),
          picker("vpcId", "VPC", "vpc", "vpcId", {
            description: "Leave empty and Vultr creates a VPC for the cluster",
          }),
          {
            key: "poolLabel",
            label: "Node Pool Label",
            kind: "text",
            required: true,
            defaultValue: "pool-1",
          },
          {
            key: "plan",
            label: "Node Plan",
            kind: "size-picker",
            required: true,
            sizes,
            filterByFieldKey: "region",
            defaultValue: sizes.find((s) => s.id === "vc2-2c-4gb")?.id ?? sizes[0]?.id ?? "",
          },
          {
            key: "nodeQuantity",
            label: "Nodes",
            kind: "number",
            required: true,
            minValue: 1,
            maxValue: 100,
            defaultValue: "3",
          },
          yesNo("autoScaler", "Autoscaler", "false"),
          {
            key: "minNodes",
            label: "Autoscaler Minimum",
            kind: "number",
            required: false,
            minValue: 1,
            defaultValue: "1",
            showWhen: { fieldKey: "autoScaler", fieldValue: "true" },
          },
          {
            key: "maxNodes",
            label: "Autoscaler Maximum",
            kind: "number",
            required: false,
            minValue: 1,
            defaultValue: "5",
            showWhen: { fieldKey: "autoScaler", fieldValue: "true" },
          },
        ],
      };
    }
    case "node-pool": {
      const plans = await ctx.catalog.get();
      const sizes = instanceSizeOptions(plans);
      const fields: CreateFieldConfig[] = [];
      if (!parentResourceId) {
        fields.push(
          picker("clusterId", "Cluster", "kubernetes-cluster", "clusterId", { required: true }),
        );
      }
      fields.push(
        { key: "label", label: "Label", kind: "text", required: true },
        {
          key: "plan",
          label: "Node Plan",
          kind: "size-picker",
          required: true,
          sizes,
          defaultValue: sizes.find((s) => s.id === "vc2-2c-4gb")?.id ?? sizes[0]?.id ?? "",
        },
        {
          key: "nodeQuantity",
          label: "Nodes",
          kind: "number",
          required: true,
          minValue: 1,
          maxValue: 100,
          defaultValue: "2",
        },
        yesNo("autoScaler", "Autoscaler", "false"),
        {
          key: "minNodes",
          label: "Autoscaler Minimum",
          kind: "number",
          required: false,
          minValue: 1,
          defaultValue: "1",
          showWhen: { fieldKey: "autoScaler", fieldValue: "true" },
        },
        {
          key: "maxNodes",
          label: "Autoscaler Maximum",
          kind: "number",
          required: false,
          minValue: 1,
          defaultValue: "5",
          showWhen: { fieldKey: "autoScaler", fieldValue: "true" },
        },
        { key: "tag", label: "Tag", kind: "text", required: false },
      );
      return { fields };
    }
    case "database": {
      const [regions, plans] = await Promise.all([
        regionOptions(api),
        api
          .all<VultrDatabasePlan>("/databases/plans", "plans")
          .catch(() => [] as VultrDatabasePlan[]),
      ]);
      const sizes = databasePlanOptions(plans);
      const versionField = (engine: string): CreateFieldConfig => ({
        key: `version_${engine}`,
        label: `${ENGINE_LABELS[engine]} Version`,
        kind: "select",
        required: false,
        defaultValue: DATABASE_VERSIONS[engine]![0]!,
        options: DATABASE_VERSIONS[engine]!.map((v) => ({ id: v, label: v })),
        showWhen: { fieldKey: "engine", fieldValue: engine },
      });
      return {
        fields: [
          { key: "label", label: "Label", kind: "text", required: true },
          {
            key: "engine",
            label: "Engine",
            kind: "select",
            required: true,
            defaultValue: "pg",
            options: Object.entries(ENGINE_LABELS).map(([id, label]) => ({ id, label })),
          },
          versionField("pg"),
          versionField("mysql"),
          versionField("valkey"),
          versionField("kafka"),
          regionField(regions),
          {
            key: "plan",
            label: "Plan",
            kind: "size-picker",
            required: true,
            sizes,
            filterByFieldKey: "engine",
            defaultValue: sizes[0]?.id ?? "",
          },
          {
            key: "trustedIps",
            label: "Trusted IPs",
            kind: "string-list",
            required: false,
            addLabel: "Add IP or CIDR",
            description: "Leave empty to accept connections from anywhere",
          },
          picker("vpcId", "VPC", "vpc", "vpcId"),
          ...maintenanceFields(),
          { key: "tag", label: "Tag", kind: "text", required: false },
        ],
      };
    }
    case "database-user": {
      const fields: CreateFieldConfig[] = [];
      if (!parentResourceId) fields.push(await databaseSelect(api));
      fields.push(
        { key: "username", label: "Username", kind: "text", required: true },
        {
          key: "password",
          label: "Password",
          kind: "password",
          required: false,
          description: "Leave empty and Vultr generates one",
        },
        {
          key: "encryption",
          label: "Password Encryption (MySQL)",
          kind: "select",
          required: false,
          defaultValue: "",
          options: [
            { id: "", label: "Engine default" },
            { id: "caching_sha2_password", label: "caching_sha2_password" },
            { id: "mysql_native_password", label: "mysql_native_password (legacy clients)" },
          ],
        },
        {
          key: "permission",
          label: "Kafka Permission",
          kind: "select",
          required: false,
          defaultValue: "",
          options: [
            { id: "", label: "Not a Kafka cluster" },
            { id: "admin", label: "Admin" },
            { id: "read", label: "Read" },
            { id: "write", label: "Write" },
            { id: "readwrite", label: "Read and write" },
          ],
        },
      );
      return { fields };
    }
    case "database-db": {
      const fields: CreateFieldConfig[] = [];
      if (!parentResourceId) fields.push(await databaseSelect(api, ["mysql", "pg"]));
      fields.push({ key: "name", label: "Name", kind: "text", required: true });
      return { fields };
    }
    case "load-balancer": {
      const [regions, instances] = await Promise.all([
        regionOptions(api, "load_balancers"),
        instancePolicyOptions(api),
      ]);
      const proto = (key: string, label: string, def: string): CreateFieldConfig => ({
        key,
        label,
        kind: "select",
        required: true,
        defaultValue: def,
        options: [
          { id: "http", label: "HTTP" },
          { id: "https", label: "HTTPS" },
          { id: "tcp", label: "TCP" },
        ],
      });
      return {
        fields: [
          { key: "label", label: "Label", kind: "text", required: false },
          regionField(regions),
          {
            key: "nodes",
            label: "Load Balancer Nodes",
            kind: "select",
            required: false,
            defaultValue: "1",
            options: ["1", "3", "5", "7", "9"].map((n) => ({ id: n, label: n })),
            description: "Each node is billed; more nodes handle more connections",
          },
          {
            key: "balancingAlgorithm",
            label: "Algorithm",
            kind: "select",
            required: false,
            defaultValue: "roundrobin",
            options: [
              { id: "roundrobin", label: "Round robin" },
              { id: "leastconn", label: "Least connections" },
            ],
          },
          proto("frontendProtocol", "Frontend Protocol", "http"),
          {
            key: "frontendPort",
            label: "Frontend Port",
            kind: "number",
            required: true,
            defaultValue: "80",
            minValue: 1,
            maxValue: 65535,
          },
          proto("backendProtocol", "Backend Protocol", "http"),
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
            key: "instances",
            label: "Backend Instances",
            kind: "policy-picker",
            required: false,
            policies: instances,
          },
          {
            key: "healthProtocol",
            label: "Health Check Protocol",
            kind: "select",
            required: false,
            defaultValue: "http",
            options: [
              { id: "http", label: "HTTP" },
              { id: "https", label: "HTTPS" },
              { id: "tcp", label: "TCP" },
            ],
          },
          {
            key: "healthPort",
            label: "Health Check Port",
            kind: "number",
            required: false,
            defaultValue: "80",
          },
          {
            key: "healthPath",
            label: "Health Check Path",
            kind: "text",
            required: false,
            defaultValue: "/",
            showWhen: { fieldKey: "healthProtocol", fieldValues: ["http", "https"] },
          },
          yesNo("sslRedirect", "Redirect HTTP to HTTPS", "false"),
          yesNo("proxyProtocol", "Proxy Protocol", "false"),
          picker("vpcId", "VPC", "vpc", "vpcId", {
            description: "Reach the backends over this private network",
          }),
        ],
      };
    }
    case "firewall-group":
      return {
        fields: [
          { key: "description", label: "Description", kind: "text", required: true },
          yesNo("allowSsh", "Allow SSH (TCP 22) from anywhere", "true"),
          yesNo("allowWeb", "Allow HTTP and HTTPS (TCP 80, 443) from anywhere", "false"),
          yesNo("allowPing", "Allow ping (ICMP)", "true"),
        ],
      };
    case "vpc": {
      const regions = await regionOptions(api);
      return {
        fields: [
          { key: "description", label: "Description", kind: "text", required: true },
          regionField(regions),
          {
            key: "subnet",
            label: "IPv4 Range",
            kind: "text",
            required: false,
            placeholder: "10.10.0.0/20",
            description: "Private range in CIDR form; leave empty for Vultr to choose one",
          },
        ],
      };
    }
    case "reserved-ip": {
      const regions = await regionOptions(api);
      return {
        fields: [
          regionField(regions),
          {
            key: "ipType",
            label: "Type",
            kind: "select",
            required: true,
            defaultValue: "v4",
            options: [
              { id: "v4", label: "IPv4 address" },
              { id: "v6", label: "IPv6 subnet" },
            ],
          },
          { key: "label", label: "Label", kind: "text", required: false },
          picker("instanceId", "Attach to Instance", "instance", "instanceId"),
        ],
      };
    }
    case "domain":
      return {
        fields: [
          {
            key: "domain",
            label: "Domain",
            kind: "text",
            required: true,
            placeholder: "example.com",
          },
          {
            key: "ip",
            label: "Default IP",
            kind: "text",
            required: false,
            description: "Optional: Vultr creates default A records pointing at this address",
          },
          yesNo("dnsSec", "DNSSEC", "false"),
        ],
      };
    case "dns-record": {
      const fields: CreateFieldConfig[] = [];
      if (!parentResourceId) {
        const domains = await api
          .all<VultrDomain>("/domains", "domains")
          .catch(() => [] as VultrDomain[]);
        fields.push({
          key: "domain",
          label: "Domain",
          kind: "select",
          required: true,
          options: domains.map((d) => ({ id: d.domain, label: d.domain })),
        });
      }
      fields.push(
        {
          key: "type",
          label: "Type",
          kind: "select",
          required: true,
          defaultValue: "A",
          options: ["A", "AAAA", "CNAME", "MX", "TXT", "NS", "SRV", "CAA", "SSHFP"].map((t) => ({
            id: t,
            label: t,
          })),
        },
        {
          key: "name",
          label: "Name",
          kind: "text",
          required: false,
          description: "Relative to the domain; leave empty for the apex",
        },
        ...dnsContentField({ key: "data", label: "Data" }),
        {
          key: "ttl",
          label: "TTL (seconds)",
          kind: "number",
          required: false,
          defaultValue: "300",
          minValue: 0,
        },
        {
          key: "priority",
          label: "Priority",
          kind: "number",
          required: false,
          defaultValue: "10",
          minValue: 0,
          maxValue: 65535,
          showWhen: { fieldKey: "type", fieldValues: ["MX", "SRV"] },
        },
      );
      return { fields };
    }
    case "object-storage": {
      const tiers = await api
        .get<{ tiers?: VultrObjectStorageTier[] }>("/object-storage/tiers")
        .catch(() => ({ tiers: [] as VultrObjectStorageTier[] }));
      const options: SelectOption[] = [];
      for (const t of tiers.tiers ?? []) {
        for (const loc of t.locations ?? []) {
          options.push({
            id: `${loc.id}:${t.id}`,
            label: `${t.sales_name ?? t.slug ?? t.id} · ${loc.region ?? loc.hostname ?? loc.id}`,
            description: [
              t.price != null ? `$${t.price}/mo base` : "",
              t.disk_gb_price != null ? `$${t.disk_gb_price}/GB stored` : "",
              loc.hostname ?? "",
            ]
              .filter(Boolean)
              .join(" · "),
          });
        }
      }
      return {
        fields: [
          { key: "label", label: "Label", kind: "text", required: true },
          {
            key: "clusterTier",
            label: "Location and Tier",
            kind: "select",
            required: true,
            options,
            defaultValue: options[0]?.id ?? "",
          },
        ],
      };
    }
    case "bucket": {
      const fields: CreateFieldConfig[] = [];
      if (!parentResourceId) {
        const subs = await api
          .all<VultrObjectStorage>("/object-storage", "object_storages")
          .catch(() => [] as VultrObjectStorage[]);
        fields.push({
          key: "subscriptionId",
          label: "Object Storage",
          kind: "select",
          required: true,
          options: subs.map((s) => ({
            id: s.id,
            label: s.label || s.id,
            description: s.s3_hostname ?? "",
          })),
        });
      }
      fields.push(
        {
          key: "name",
          label: "Name",
          kind: "text",
          required: true,
          description: "3 to 63 lowercase letters, digits and dashes",
        },
        yesNo("versioning", "Versioning", "false"),
        yesNo(
          "objectLock",
          "Object Lock",
          "false",
          "Can only be turned on when the bucket is created",
        ),
      );
      return { fields };
    }
    case "ssh-key":
      return {
        fields: [
          { key: "name", label: "Name", kind: "text", required: true },
          {
            key: "publicKey",
            label: "Public Key",
            kind: "text",
            multiline: true,
            required: true,
            placeholder: "ssh-ed25519 AAAA… user@host",
          },
        ],
      };
    case "startup-script":
      return {
        fields: [
          { key: "name", label: "Name", kind: "text", required: true },
          {
            key: "type",
            label: "Type",
            kind: "select",
            required: true,
            defaultValue: "boot",
            options: [
              { id: "boot", label: "Boot: runs on first boot" },
              { id: "pxe", label: "PXE: iPXE chain script" },
            ],
          },
          {
            key: "script",
            label: "Script",
            kind: "code",
            codeLanguage: "shell",
            required: true,
            defaultValue: "#!/bin/bash\n",
          },
        ],
      };
    default:
      throw new Error(`Vultr plugin: no create form for "${typeId}"`);
  }
}

async function databaseSelect(api: VultrApi, engines?: string[]): Promise<CreateFieldConfig> {
  const dbs = await api
    .all<VultrDatabase>("/databases", "databases")
    .catch(() => [] as VultrDatabase[]);
  return {
    key: "databaseId",
    label: "Database",
    kind: "select",
    required: true,
    options: dbs
      .filter((d) => !engines || engines.includes(d.database_engine ?? ""))
      .map((d) => ({
        id: d.id,
        label: d.label || d.id,
        description: `${ENGINE_LABELS[d.database_engine ?? ""] ?? d.database_engine ?? ""} · ${d.region ?? ""}`,
      })),
  };
}

/** Firewall rules for the create form's presets, for both address families. */
export function firewallPresetRules(
  fields: Record<string, string>,
): Array<Record<string, unknown>> {
  const rules: Array<Record<string, unknown>> = [];
  const both = (protocol: string, port: string, notes: string) => {
    rules.push({
      ip_type: "v4",
      protocol,
      subnet: "0.0.0.0",
      subnet_size: 0,
      ...(port ? { port } : {}),
      notes,
    });
    rules.push({
      ip_type: "v6",
      protocol,
      subnet: "::",
      subnet_size: 0,
      ...(port ? { port } : {}),
      notes,
    });
  };
  if (fields["allowSsh"] !== "false") both("tcp", "22", "SSH");
  if (fields["allowWeb"] === "true") {
    both("tcp", "80", "HTTP");
    both("tcp", "443", "HTTPS");
  }
  if (fields["allowPing"] !== "false") {
    rules.push({
      ip_type: "v4",
      protocol: "icmp",
      subnet: "0.0.0.0",
      subnet_size: 0,
      notes: "Ping",
    });
  }
  return rules;
}

/** `a.b.c.d/nn` into Vultr's split subnet and mask. */
export function splitCidr(cidr: string): { subnet: string; size: number } | null {
  const m = /^\s*([0-9a-fA-F:.]+)\/(\d{1,3})\s*$/.exec(cidr);
  if (!m) return null;
  return { subnet: m[1]!, size: Number(m[2]) };
}

export function databaseVersion(fields: Record<string, string>): string {
  const engine = fields["engine"] || "pg";
  return fields[`version_${engine}`] || fields["version"] || DATABASE_VERSIONS[engine]?.[0] || "";
}

export async function createResource(
  ctx: CreateContext,
  typeId: string,
  accountId: string,
  fields: Record<string, string>,
  parentResourceId?: string,
): Promise<ResourceInstance> {
  const { api } = ctx;
  const parentId = parentResourceId ? trailingId(parentResourceId) : "";
  switch (typeId) {
    case "instance": {
      const sshKeyIds = fields["sshPublicKey"]
        ? [await ensureSshKey(api, fields["sshPublicKey"])]
        : [];
      const tags = listValue(fields["tags"]);
      const userData = fields["userData"]?.trim();
      const body = {
        region: fields["region"],
        plan: fields["plan"],
        label: fields["label"],
        hostname: fields["hostname"] || fields["label"],
        ...bootSource(fields["image"]),
        ...(sshKeyIds.length ? { sshkey_id: sshKeyIds } : {}),
        ...(fields["scriptId"] ? { script_id: fields["scriptId"] } : {}),
        ...(userData ? { user_data: toBase64(userData) } : {}),
        backups: fields["backups"] === "true" ? "enabled" : "disabled",
        enable_ipv6: fields["enableIpv6"] !== "false",
        ddos_protection: fields["ddosProtection"] === "true",
        ...(fields["firewallGroupId"] ? { firewall_group_id: fields["firewallGroupId"] } : {}),
        ...(fields["vpcId"] ? { attach_vpc: [fields["vpcId"]] } : {}),
        tags,
      };
      const res = await api.send<{ instance?: VultrInstance }>("POST", "/instances", body);
      if (!res.instance) throw new Error("Vultr accepted the request but returned no instance.");
      return mapInstance(res.instance, accountId);
    }
    case "block-storage": {
      const res = await api.send<{ block?: VultrBlock }>("POST", "/blocks", {
        region: fields["region"],
        size_gb: intOr(fields["sizeGb"], 50),
        ...(fields["label"] ? { label: fields["label"] } : {}),
        block_type: fields["blockType"] || "high_perf",
      });
      if (!res.block) throw new Error("Vultr accepted the request but returned no volume.");
      if (fields["instanceId"]) {
        await api.send("POST", `/blocks/${res.block.id}/attach`, {
          instance_id: fields["instanceId"],
          live: true,
        });
        res.block.attached_to_instance = fields["instanceId"];
      }
      return mapBlock(res.block, accountId);
    }
    case "snapshot": {
      if (!fields["instanceId"]) throw new Error("Pick the instance to snapshot.");
      const res = await api.send<{ snapshot?: VultrSnapshot }>("POST", "/snapshots", {
        instance_id: fields["instanceId"],
        ...(fields["description"] ? { description: fields["description"] } : {}),
      });
      if (!res.snapshot) throw new Error("Vultr accepted the request but returned no snapshot.");
      return mapSnapshot(res.snapshot, accountId);
    }
    case "kubernetes-cluster": {
      const autoscale = fields["autoScaler"] === "true";
      const res = await api.send<{ vke_cluster?: VultrKubernetesCluster }>(
        "POST",
        "/kubernetes/clusters",
        {
          label: fields["label"],
          region: fields["region"],
          version: fields["version"],
          ha_controlplanes: fields["haControlPlanes"] === "true",
          enable_firewall: fields["enableFirewall"] !== "false",
          ...(fields["vpcId"] ? { vpc_id: fields["vpcId"] } : {}),
          node_pools: [
            {
              node_quantity: intOr(fields["nodeQuantity"], 3),
              label: fields["poolLabel"] || "pool-1",
              plan: fields["plan"],
              auto_scaler: autoscale,
              ...(autoscale
                ? {
                    min_nodes: intOr(fields["minNodes"], 1),
                    max_nodes: intOr(fields["maxNodes"], 5),
                  }
                : {}),
            },
          ],
        },
      );
      if (!res.vke_cluster) throw new Error("Vultr accepted the request but returned no cluster.");
      return mapCluster(res.vke_cluster, accountId);
    }
    case "node-pool": {
      const clusterId = fields["clusterId"] || parentId;
      if (!clusterId) throw new Error("Pick the cluster to add the node pool to.");
      const autoscale = fields["autoScaler"] === "true";
      const res = await api.send<{ node_pool?: VultrNodePool }>(
        "POST",
        `/kubernetes/clusters/${clusterId}/node-pools`,
        {
          node_quantity: intOr(fields["nodeQuantity"], 2),
          label: fields["label"],
          plan: fields["plan"],
          ...(fields["tag"] ? { tag: fields["tag"] } : {}),
          auto_scaler: autoscale,
          ...(autoscale
            ? { min_nodes: intOr(fields["minNodes"], 1), max_nodes: intOr(fields["maxNodes"], 5) }
            : {}),
        },
      );
      if (!res.node_pool) throw new Error("Vultr accepted the request but returned no node pool.");
      const cluster = await api.get<{ vke_cluster?: VultrKubernetesCluster }>(
        `/kubernetes/clusters/${clusterId}`,
      );
      return mapNodePool(res.node_pool, cluster.vke_cluster ?? { id: clusterId }, accountId);
    }
    case "database": {
      const engine = fields["engine"] || "pg";
      const trusted = listValue(fields["trustedIps"]);
      const res = await api.send<{ database?: VultrDatabase }>("POST", "/databases", {
        database_engine: engine,
        database_engine_version: databaseVersion(fields),
        region: fields["region"],
        plan: fields["plan"],
        label: fields["label"],
        ...(fields["tag"] ? { tag: fields["tag"] } : {}),
        ...(fields["vpcId"] ? { vpc_id: fields["vpcId"] } : {}),
        ...(trusted.length ? { trusted_ips: trusted } : {}),
        ...(fields["maintenanceDow"] ? { maintenance_dow: fields["maintenanceDow"] } : {}),
        ...(fields["maintenanceTime"] ? { maintenance_time: fields["maintenanceTime"] } : {}),
      });
      if (!res.database) throw new Error("Vultr accepted the request but returned no database.");
      return mapDatabase(res.database, accountId);
    }
    case "database-user": {
      const databaseId = fields["databaseId"] || parentId;
      if (!databaseId) throw new Error("Pick the database to add the user to.");
      const res = await api.send<{ user?: VultrDatabaseUser }>(
        "POST",
        `/databases/${databaseId}/users`,
        {
          username: fields["username"],
          ...(fields["password"] ? { password: fields["password"] } : {}),
          ...(fields["encryption"] ? { encryption: fields["encryption"] } : {}),
          ...(fields["permission"] ? { permission: fields["permission"] } : {}),
        },
      );
      const user = res.user ?? { username: fields["username"] ?? "" };
      const out = mapDatabaseUser(user, databaseId, accountId);
      if (user.password) {
        out.secretStates = [
          { fieldKey: "password", resolution: { kind: "plaintext", value: user.password } },
        ];
      }
      return out;
    }
    case "database-db": {
      const databaseId = fields["databaseId"] || parentId;
      if (!databaseId) throw new Error("Pick the database cluster.");
      await api.send("POST", `/databases/${databaseId}/dbs`, { name: fields["name"] });
      return mapLogicalDb(fields["name"] ?? "", databaseId, accountId);
    }
    case "load-balancer": {
      const healthProtocol = fields["healthProtocol"] || "http";
      const res = await api.send<{ load_balancer?: VultrLoadBalancer }>("POST", "/load-balancers", {
        region: fields["region"],
        ...(fields["label"] ? { label: fields["label"] } : {}),
        nodes: intOr(fields["nodes"], 1),
        balancing_algorithm: fields["balancingAlgorithm"] || "roundrobin",
        ssl_redirect: fields["sslRedirect"] === "true",
        proxy_protocol: fields["proxyProtocol"] === "true",
        forwarding_rules: [
          {
            frontend_protocol: fields["frontendProtocol"] || "http",
            frontend_port: intOr(fields["frontendPort"], 80),
            backend_protocol: fields["backendProtocol"] || "http",
            backend_port: intOr(fields["backendPort"], 80),
          },
        ],
        health_check: {
          protocol: healthProtocol,
          port: intOr(fields["healthPort"], 80),
          ...(healthProtocol !== "tcp" ? { path: fields["healthPath"] || "/" } : {}),
          check_interval: 15,
          response_timeout: 5,
          unhealthy_threshold: 5,
          healthy_threshold: 5,
        },
        instances: listValue(fields["instances"]),
        ...(fields["vpcId"] ? { vpc: fields["vpcId"] } : {}),
      });
      if (!res.load_balancer)
        throw new Error("Vultr accepted the request but returned no load balancer.");
      return mapLoadBalancer(res.load_balancer, accountId);
    }
    case "firewall-group": {
      const res = await api.send<{ firewall_group?: VultrFirewallGroup }>("POST", "/firewalls", {
        description: fields["description"],
      });
      if (!res.firewall_group)
        throw new Error("Vultr accepted the request but returned no firewall group.");
      const rules = firewallPresetRules(fields);
      for (const rule of rules) {
        await api.send("POST", `/firewalls/${res.firewall_group.id}/rules`, rule);
      }
      return mapFirewallGroup({ ...res.firewall_group, rule_count: rules.length }, accountId, []);
    }
    case "vpc": {
      const cidr = fields["subnet"] ? splitCidr(fields["subnet"]) : null;
      if (fields["subnet"] && !cidr)
        throw new Error("Enter the IPv4 range in CIDR form, e.g. 10.10.0.0/20.");
      const res = await api.send<{ vpc?: VultrVpc }>("POST", "/vpcs", {
        region: fields["region"],
        description: fields["description"],
        ...(cidr ? { v4_subnet: cidr.subnet, v4_subnet_mask: cidr.size } : {}),
      });
      if (!res.vpc) throw new Error("Vultr accepted the request but returned no VPC.");
      return mapVpc(res.vpc, accountId, 0);
    }
    case "reserved-ip": {
      const res = await api.send<{ reserved_ip?: VultrReservedIp }>("POST", "/reserved-ips", {
        region: fields["region"],
        ip_type: fields["ipType"] || "v4",
        ...(fields["label"] ? { label: fields["label"] } : {}),
      });
      if (!res.reserved_ip)
        throw new Error("Vultr accepted the request but returned no reserved IP.");
      if (fields["instanceId"]) {
        await api.send("POST", `/reserved-ips/${res.reserved_ip.id}/attach`, {
          instance_id: fields["instanceId"],
        });
        res.reserved_ip.instance_id = fields["instanceId"];
      }
      return mapReservedIp(res.reserved_ip, accountId);
    }
    case "domain": {
      const res = await api.send<{ domain?: VultrDomain }>("POST", "/domains", {
        domain: fields["domain"],
        ...(fields["ip"] ? { ip: fields["ip"] } : {}),
        dns_sec: fields["dnsSec"] === "true" ? "enabled" : "disabled",
      });
      return mapDomain(res.domain ?? { domain: fields["domain"] ?? "" }, accountId, null);
    }
    case "dns-record": {
      const domain = fields["domain"] || parentId;
      if (!domain) throw new Error("Pick the domain to add the record to.");
      const res = await api.send<{ record?: VultrDomainRecord }>(
        "POST",
        `/domains/${encodeURIComponent(domain)}/records`,
        recordBody(fields),
      );
      if (!res.record) throw new Error("Vultr accepted the request but returned no record.");
      return mapDnsRecord(res.record, domain, accountId);
    }
    case "object-storage": {
      const [clusterId, tierId] = (fields["clusterTier"] ?? "").split(":");
      if (!clusterId || !tierId) throw new Error("Pick a location and tier.");
      const res = await api.send<{ object_storage?: VultrObjectStorage }>(
        "POST",
        "/object-storage",
        {
          cluster_id: Number(clusterId),
          tier_id: Number(tierId),
          label: fields["label"],
        },
      );
      if (!res.object_storage)
        throw new Error("Vultr accepted the request but returned no subscription.");
      return mapObjectStorage(res.object_storage, accountId);
    }
    case "bucket": {
      const subId = fields["subscriptionId"] || parentId;
      if (!subId) throw new Error("Pick the Object Storage subscription.");
      await api.send("POST", `/object-storage/${subId}/bucket`, {
        name: fields["name"],
        ...(fields["versioning"] === "true" ? { enable_bucket_versioning: true } : {}),
        ...(fields["objectLock"] === "true" ? { enable_object_lock: true } : {}),
      });
      const sub = await api.get<{ object_storage?: VultrObjectStorage }>(
        `/object-storage/${subId}`,
      );
      return mapBucket(fields["name"] ?? "", sub.object_storage ?? { id: subId }, accountId);
    }
    case "ssh-key": {
      const res = await api.send<{ ssh_key?: VultrSshKey }>("POST", "/ssh-keys", {
        name: fields["name"],
        ssh_key: (fields["publicKey"] ?? "").trim(),
      });
      if (!res.ssh_key) throw new Error("Vultr accepted the request but returned no SSH key.");
      return mapSshKey(res.ssh_key, accountId);
    }
    case "startup-script": {
      const res = await api.send<{ startup_script?: VultrStartupScript }>(
        "POST",
        "/startup-scripts",
        {
          name: fields["name"],
          type: fields["type"] || "boot",
          script: toBase64(fields["script"] ?? ""),
        },
      );
      if (!res.startup_script)
        throw new Error("Vultr accepted the request but returned no script.");
      return mapStartupScript(res.startup_script, accountId);
    }
    default:
      throw new Error(`Vultr plugin: cannot create "${typeId}"`);
  }
}

/** Form fields to a DNS record body. `@` means the apex, which Vultr spells as "". */
export function recordBody(fields: Record<string, string>): Record<string, unknown> {
  const type = fields["type"] ?? "A";
  const name = (fields["name"] ?? "").trim();
  const body: Record<string, unknown> = {
    type,
    name: name === "@" ? "" : name,
    data: fields["data"] ?? "",
  };
  const ttl = intOr(fields["ttl"]);
  if (ttl !== undefined) body["ttl"] = ttl;
  if (type === "MX" || type === "SRV") body["priority"] = intOr(fields["priority"], 10);
  return body;
}
