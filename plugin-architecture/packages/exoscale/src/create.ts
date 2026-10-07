/**
 * Create forms and create calls. Zones, instance types, templates,
 * security groups, private networks, SKS versions, DBaaS service types,
 * plans and versions, and DNS domains all come from live listings.
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
import { dnsContentField, signedS3Fetch } from "@infrawrench/plugin-base";
import {
  DEFAULT_ZONE,
  type ExoscaleApi,
  intOr,
  labelsFromText,
  listValue,
  trailingId,
  utf8ToBase64,
  zonal,
} from "./api.js";
import {
  type Json,
  dbaasPath,
  instance,
  mapBucket,
  mapCluster,
  mapDbaas,
  mapDbaasDatabase,
  mapDbaasUser,
  mapDomain,
  mapElasticIp,
  mapInstance,
  mapNlb,
  mapNodepool,
  mapPrivateNetwork,
  mapSecurityGroup,
  mapSnapshot,
  mapVolume,
  mapVolumeSnapshot,
  num,
  sosEndpoint,
  str,
} from "./listers.js";

const FLAGS: Record<string, string> = {
  ch: "🇨🇭",
  de: "🇩🇪",
  at: "🇦🇹",
  bg: "🇧🇬",
  hr: "🇭🇷",
  es: "🇪🇸",
};
const CITIES: Record<string, string> = {
  "ch-gva-2": "Geneva",
  "ch-dk-2": "Zurich",
  "de-fra-1": "Frankfurt",
  "de-muc-1": "Munich",
  "at-vie-1": "Vienna 1",
  "at-vie-2": "Vienna 2",
  "bg-sof-1": "Sofia",
  "hr-zag-1": "Zagreb",
  "es-mad-1": "Madrid",
};

export async function zoneOptions(api: ExoscaleApi, allowed?: string[]): Promise<RegionOption[]> {
  const zones = await api.zones();
  return zones
    .filter((z) => !allowed || allowed.includes(z))
    .map((z) => {
      const flag = FLAGS[z.split("-")[0] ?? ""];
      return { id: z, label: CITIES[z] ?? z, location: z, ...(flag ? { flag } : {}) };
    });
}

const regionField = (regions: RegionOption[]): CreateFieldConfig => ({
  key: "zone",
  label: "Zone",
  kind: "region-picker",
  required: true,
  regions,
  defaultValue: regions.find((r) => r.id === DEFAULT_ZONE)?.id ?? regions[0]?.id ?? "",
});

export async function instanceTypeOptions(api: ExoscaleApi): Promise<SizeOption[]> {
  const res = await api
    .get<{ "instance-types"?: Json[] }>(DEFAULT_ZONE, "/instance-type")
    .catch(() => ({}) as Json);
  const types = ((res as Json)["instance-types"] as Json[] | undefined) ?? [];
  return types
    .filter((t) => t["authorized"] !== false)
    .map((t) => {
      const family = str(t["family"]);
      return {
        id: str(t["id"]),
        label: `${family}.${str(t["size"])}`,
        vcpus: num(t["cpus"]),
        memoryMb: Math.round(num(t["memory"]) / 1048576),
        category: family.charAt(0).toUpperCase() + family.slice(1),
        ...(Array.isArray(t["zones"])
          ? { availableFor: (t["zones"] as string[]).map(String) }
          : {}),
      };
    })
    .sort((a, b) => a.vcpus - b.vcpus || a.memoryMb - b.memoryMb);
}

export async function templateOptions(
  api: ExoscaleApi,
  zone = DEFAULT_ZONE,
): Promise<ImageOption[]> {
  const [pub, priv] = await Promise.all([
    api
      .get<{ templates?: Json[] }>(zone, "/template?visibility=public")
      .catch(() => ({ templates: [] as Json[] })),
    api
      .get<{ templates?: Json[] }>(zone, "/template?visibility=private")
      .catch(() => ({ templates: [] as Json[] })),
  ]);
  const out: ImageOption[] = [];
  for (const t of priv.templates ?? []) {
    out.push({ id: str(t["id"]), label: str(t["name"]), category: "My Templates", isOwned: true });
  }
  for (const t of pub.templates ?? []) {
    const family = str(t["family"]);
    out.push({
      id: str(t["id"]),
      label: str(t["name"]),
      family,
      category: family ? family.charAt(0).toUpperCase() + family.slice(1) : "Other",
      ...(t["default-user"] ? { description: `User ${str(t["default-user"])}` } : {}),
    });
  }
  return out;
}

async function securityGroupPolicies(api: ExoscaleApi): Promise<PolicyOption[]> {
  const res = await api
    .get<{ "security-groups"?: Json[] }>(DEFAULT_ZONE, "/security-group")
    .catch(() => ({}) as Json);
  return (((res as Json)["security-groups"] as Json[] | undefined) ?? []).map((g) => ({
    id: str(g["id"]),
    label: str(g["name"]),
    ...(g["description"] ? { description: str(g["description"]) } : {}),
    category: "Security groups",
  }));
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
  required = false,
  description?: string,
): CreateFieldConfig => ({
  key,
  label,
  kind: "resource-picker",
  required,
  associationSources: [{ pluginId: "exoscale", resourceTypeId: typeId, outputKey }],
  scopeFromFieldKey: "zone",
  ...(description ? { description } : {}),
});

const DBAAS_LABELS: Record<string, string> = {
  pg: "PostgreSQL",
  mysql: "MySQL",
  valkey: "Valkey",
  kafka: "Apache Kafka",
  opensearch: "OpenSearch",
  grafana: "Grafana",
  clickhouse: "ClickHouse",
};

export async function getCreateConfig(
  api: ExoscaleApi,
  typeId: string,
  parentResourceId?: string,
): Promise<CreateResourceConfig> {
  switch (typeId) {
    case "instance": {
      const [regions, sizes, images, groups] = await Promise.all([
        zoneOptions(api),
        instanceTypeOptions(api),
        templateOptions(api),
        securityGroupPolicies(api),
      ]);
      return {
        fields: [
          { key: "name", label: "Name", kind: "text", required: true },
          regionField(regions),
          {
            key: "instanceType",
            label: "Type",
            kind: "size-picker",
            required: true,
            sizes,
            filterByFieldKey: "zone",
            defaultValue: sizes.find((s) => s.label === "standard.small")?.id ?? sizes[0]?.id ?? "",
          },
          {
            key: "template",
            label: "Template",
            kind: "image-picker",
            required: true,
            images,
            defaultValue:
              images.find((i) => /Ubuntu 24\.04 LTS$/i.test(i.label))?.id ?? images[0]?.id ?? "",
          },
          {
            key: "diskGb",
            label: "Disk",
            kind: "disk-slider",
            required: true,
            minGb: 10,
            maxGb: 1600,
            defaultGb: 50,
            stepGb: 10,
          },
          { key: "sshPublicKey", label: "SSH Key", kind: "ssh-key-picker", required: false },
          {
            key: "securityGroups",
            label: "Security Groups",
            kind: "policy-picker",
            required: false,
            policies: groups,
          },
          picker("privateNetworkId", "Private Network", "private-network", "networkId"),
          {
            key: "publicIp",
            label: "Public IP",
            kind: "select",
            required: false,
            defaultValue: "inet4",
            options: [
              { id: "inet4", label: "IPv4" },
              { id: "dual", label: "IPv4 and IPv6" },
              { id: "none", label: "None (private only)" },
            ],
          },
          {
            key: "userData",
            label: "Cloud-init User Data",
            kind: "code",
            codeLanguage: "yaml",
            required: false,
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
    case "block-storage":
      return {
        fields: [
          { key: "name", label: "Name", kind: "text", required: true },
          regionField(await zoneOptions(api)),
          {
            key: "sizeGb",
            label: "Size",
            kind: "disk-slider",
            required: true,
            minGb: 10,
            maxGb: 10000,
            defaultGb: 50,
            stepGb: 10,
          },
          picker("instanceId", "Attach to Instance", "instance", "instanceId"),
        ],
      };
    case "block-storage-snapshot":
      return {
        fields: [
          {
            key: "volumeRef",
            label: "Volume",
            kind: "resource-picker",
            required: true,
            associationSources: [
              { pluginId: "exoscale", resourceTypeId: "block-storage", outputKey: "volumeRef" },
            ],
          },
          { key: "name", label: "Name", kind: "text", required: true },
        ],
      };
    case "snapshot":
      return {
        fields: [
          {
            key: "instanceRef",
            label: "Instance",
            kind: "resource-picker",
            required: true,
            associationSources: [
              { pluginId: "exoscale", resourceTypeId: "instance", outputKey: "instanceRef" },
            ],
          },
        ],
      };
    case "template":
      return {
        fields: [
          regionField(await zoneOptions(api)),
          { key: "name", label: "Name", kind: "text", required: true },
          {
            key: "url",
            label: "Image URL",
            kind: "text",
            required: true,
            placeholder: "https://…/image.qcow2",
            description: "A qcow2 image Exoscale can download",
          },
          { key: "checksum", label: "MD5 Checksum", kind: "text", required: true },
          {
            key: "defaultUser",
            label: "Default User",
            kind: "text",
            required: false,
            defaultValue: "ubuntu",
          },
          { key: "description", label: "Description", kind: "text", required: false },
        ],
      };
    case "private-network":
      return {
        fields: [
          { key: "name", label: "Name", kind: "text", required: true },
          regionField(await zoneOptions(api)),
          { key: "description", label: "Description", kind: "text", required: false },
          yesNo(
            "managed",
            "Managed (DHCP)",
            "true",
            "Exoscale hands out addresses from the range below",
          ),
          {
            key: "startIp",
            label: "Start IP",
            kind: "text",
            required: false,
            defaultValue: "10.0.0.10",
            showWhen: { fieldKey: "managed", fieldValue: "true" },
          },
          {
            key: "endIp",
            label: "End IP",
            kind: "text",
            required: false,
            defaultValue: "10.0.0.250",
            showWhen: { fieldKey: "managed", fieldValue: "true" },
          },
          {
            key: "netmask",
            label: "Netmask",
            kind: "text",
            required: false,
            defaultValue: "255.255.255.0",
            showWhen: { fieldKey: "managed", fieldValue: "true" },
          },
        ],
      };
    case "security-group":
      return {
        fields: [
          { key: "name", label: "Name", kind: "text", required: true },
          { key: "description", label: "Description", kind: "text", required: false },
          yesNo("allowSsh", "Allow SSH (TCP 22) from anywhere", "true"),
          yesNo("allowWeb", "Allow HTTP and HTTPS from anywhere", "false"),
          yesNo("allowPing", "Allow ping (ICMP)", "true"),
        ],
      };
    case "elastic-ip":
      return {
        fields: [
          regionField(await zoneOptions(api)),
          { key: "description", label: "Description", kind: "text", required: false },
          {
            key: "family",
            label: "Family",
            kind: "select",
            required: false,
            defaultValue: "inet4",
            options: [
              { id: "inet4", label: "IPv4" },
              { id: "inet6", label: "IPv6" },
            ],
          },
          {
            key: "healthcheckMode",
            label: "Health Check",
            kind: "select",
            required: false,
            defaultValue: "",
            options: [
              { id: "", label: "None" },
              { id: "tcp", label: "TCP" },
              { id: "http", label: "HTTP" },
              { id: "https", label: "HTTPS" },
            ],
            description: "A managed elastic IP only routes to instances passing the check",
          },
          {
            key: "healthcheckPort",
            label: "Health Check Port",
            kind: "number",
            required: false,
            defaultValue: "80",
            showWhen: { fieldKey: "healthcheckMode", fieldValues: ["tcp", "http", "https"] },
          },
          {
            key: "healthcheckUri",
            label: "Health Check Path",
            kind: "text",
            required: false,
            defaultValue: "/",
            showWhen: { fieldKey: "healthcheckMode", fieldValues: ["http", "https"] },
          },
        ],
      };
    case "sks-cluster": {
      const [regions, versions] = await Promise.all([
        zoneOptions(api),
        api
          .get<{ "sks-cluster-versions"?: string[] }>(DEFAULT_ZONE, "/sks-cluster-version")
          .catch(() => ({}) as Json),
      ]);
      const list = ((versions as Json)["sks-cluster-versions"] as string[] | undefined) ?? [];
      return {
        fields: [
          { key: "name", label: "Name", kind: "text", required: true },
          regionField(regions),
          {
            key: "version",
            label: "Kubernetes Version",
            kind: "select",
            required: true,
            options: list.map((v) => ({ id: v, label: v })),
            defaultValue: list[0] ?? "",
          },
          {
            key: "level",
            label: "Service Level",
            kind: "select",
            required: true,
            defaultValue: "starter",
            options: [
              { id: "starter", label: "Starter", description: "Free control plane, no SLA" },
              { id: "pro", label: "Pro", description: "HA control plane with an SLA (billed)" },
            ],
          },
          {
            key: "cni",
            label: "CNI",
            kind: "select",
            required: false,
            defaultValue: "calico",
            options: [
              { id: "calico", label: "Calico" },
              { id: "cilium", label: "Cilium" },
            ],
          },
          yesNo("autoUpgrade", "Auto-upgrade patch versions", "true"),
          yesNo("defaultSecurityGroup", "Create a security group for the nodes", "true"),
          { key: "description", label: "Description", kind: "text", required: false },
        ],
      };
    }
    case "sks-nodepool": {
      const [sizes, groups] = await Promise.all([
        instanceTypeOptions(api),
        securityGroupPolicies(api),
      ]);
      const fields: CreateFieldConfig[] = [];
      if (!parentResourceId) {
        fields.push({
          key: "clusterRef",
          label: "Cluster",
          kind: "resource-picker",
          required: true,
          associationSources: [
            { pluginId: "exoscale", resourceTypeId: "sks-cluster", outputKey: "clusterRef" },
          ],
        });
      }
      fields.push(
        { key: "name", label: "Name", kind: "text", required: true },
        {
          key: "instanceType",
          label: "Instance Type",
          kind: "size-picker",
          required: true,
          sizes,
          defaultValue: sizes.find((s) => s.label === "standard.medium")?.id ?? sizes[0]?.id ?? "",
        },
        {
          key: "size",
          label: "Nodes",
          kind: "number",
          required: true,
          minValue: 1,
          maxValue: 100,
          defaultValue: "2",
        },
        {
          key: "diskGb",
          label: "Disk",
          kind: "disk-slider",
          required: false,
          minGb: 20,
          maxGb: 800,
          defaultGb: 50,
          stepGb: 10,
        },
        {
          key: "securityGroups",
          label: "Security Groups",
          kind: "policy-picker",
          required: false,
          policies: groups,
          description: "Include the cluster's node security group",
        },
      );
      return { fields };
    }
    case "nlb":
      return {
        fields: [
          { key: "name", label: "Name", kind: "text", required: true },
          regionField(await zoneOptions(api)),
          { key: "description", label: "Description", kind: "text", required: false },
        ],
      };
    case "dbaas": {
      const [regions, types] = await Promise.all([
        zoneOptions(api),
        api
          .get<{ "dbaas-service-types"?: Json[] }>(DEFAULT_ZONE, "/dbaas-service-type")
          .catch(() => ({}) as Json),
      ]);
      const list = (((types as Json)["dbaas-service-types"] as Json[] | undefined) ?? []).filter(
        (t) => DBAAS_LABELS[str(t["name"])],
      );
      const sizes: SizeOption[] = [];
      for (const t of list) {
        for (const p of (t["plans"] as Json[] | undefined) ?? []) {
          if (p["authorized"] === false) continue;
          sizes.push({
            id: `${str(t["name"])}:${str(p["name"])}`,
            label: str(p["name"]),
            vcpus: num(p["node-cpu-count"]),
            memoryMb: Math.round(num(p["node-memory"]) / 1048576),
            diskGb: Math.round(num(p["disk-space"]) / 1073741824),
            category: `${num(p["node-count"])} node${num(p["node-count"]) === 1 ? "" : "s"}`,
            availableFor: [str(t["name"])],
          });
        }
      }
      const versionFields = list.map((t): CreateFieldConfig => ({
        key: `version_${str(t["name"])}`,
        label: `${DBAAS_LABELS[str(t["name"])]} Version`,
        kind: "select",
        required: false,
        options: ((t["available-versions"] as string[] | undefined) ?? []).map((v) => ({
          id: v,
          label: v,
        })),
        defaultValue: str(t["default-version"]),
        showWhen: { fieldKey: "type", fieldValue: str(t["name"]) },
      }));
      return {
        fields: [
          {
            key: "name",
            label: "Name",
            kind: "text",
            required: true,
            description: "Lowercase letters, digits and dashes; unique in the organization",
          },
          {
            key: "type",
            label: "Type",
            kind: "select",
            required: true,
            options: list.map((t) => ({
              id: str(t["name"]),
              label: DBAAS_LABELS[str(t["name"])] ?? str(t["name"]),
            })),
            defaultValue: list.some((t) => t["name"] === "pg") ? "pg" : str(list[0]?.["name"]),
          },
          ...versionFields,
          regionField(regions),
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
            description: "Leave empty to allow none until you add some",
          },
          yesNo("terminationProtection", "Termination protection", "true"),
        ],
      };
    }
    case "dbaas-user":
    case "dbaas-database": {
      const fields: CreateFieldConfig[] = [];
      if (!parentResourceId) {
        const res = await api
          .get<{ "dbaas-services"?: Json[] }>(DEFAULT_ZONE, "/dbaas-service")
          .catch(() => ({}) as Json);
        const allowed =
          typeId === "dbaas-user"
            ? ["pg", "mysql", "valkey", "kafka", "opensearch"]
            : ["pg", "mysql"];
        fields.push({
          key: "service",
          label: "Service",
          kind: "select",
          required: true,
          options: (((res as Json)["dbaas-services"] as Json[] | undefined) ?? [])
            .filter((s) => allowed.includes(str(s["type"])))
            .map((s) => ({
              id: `${str(s["zone"])}/${str(s["name"])}`,
              label: str(s["name"]),
              description: `${DBAAS_LABELS[str(s["type"])] ?? str(s["type"])} · ${str(s["zone"])}`,
            })),
        });
      }
      fields.push(
        typeId === "dbaas-user"
          ? { key: "username", label: "Username", kind: "text", required: true }
          : { key: "name", label: "Name", kind: "text", required: true },
      );
      return { fields };
    }
    case "dns-domain":
      return {
        fields: [
          {
            key: "name",
            label: "Domain",
            kind: "text",
            required: true,
            placeholder: "example.com",
          },
        ],
      };
    case "dns-record": {
      const fields: CreateFieldConfig[] = [];
      if (!parentResourceId) {
        const res = await api
          .get<{ "dns-domains"?: Json[] }>(DEFAULT_ZONE, "/dns-domain")
          .catch(() => ({}) as Json);
        fields.push({
          key: "domainId",
          label: "Domain",
          kind: "select",
          required: true,
          options: (((res as Json)["dns-domains"] as Json[] | undefined) ?? []).map((d) => ({
            id: str(d["id"]),
            label: str(d["unicode-name"]),
          })),
        });
      }
      fields.push(
        {
          key: "type",
          label: "Type",
          kind: "select",
          required: true,
          defaultValue: "A",
          options: [
            "A",
            "AAAA",
            "CNAME",
            "ALIAS",
            "MX",
            "TXT",
            "NS",
            "SRV",
            "CAA",
            "SSHFP",
            "NAPTR",
            "URL",
          ].map((t) => ({ id: t, label: t })),
        },
        {
          key: "name",
          label: "Name",
          kind: "text",
          required: false,
          description: "Relative to the domain; empty for the apex",
        },
        ...dnsContentField({ key: "content", label: "Content" }),
        {
          key: "ttl",
          label: "TTL (seconds)",
          kind: "number",
          required: false,
          defaultValue: "3600",
          minValue: 0,
        },
        {
          key: "priority",
          label: "Priority",
          kind: "number",
          required: false,
          defaultValue: "10",
          showWhen: { fieldKey: "type", fieldValues: ["MX", "SRV"] },
        },
      );
      return { fields };
    }
    case "bucket":
      return {
        fields: [
          {
            key: "name",
            label: "Name",
            kind: "text",
            required: true,
            description: "Globally unique: lowercase letters, digits, dots and dashes",
          },
          regionField(await zoneOptions(api)),
        ],
      };
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
    case "anti-affinity-group":
      return {
        fields: [
          { key: "name", label: "Name", kind: "text", required: true },
          { key: "description", label: "Description", kind: "text", required: false },
        ],
      };
    default:
      throw new Error(`Exoscale plugin: no create form for "${typeId}"`);
  }
}

/** Reuse a registered key with the same material, or register it. Returns its name. */
export async function ensureSshKey(api: ExoscaleApi, publicKey: string): Promise<string> {
  const key = publicKey.trim();
  const comment = key.split(/\s+/)[2];
  const name =
    `infrawrench-${(comment ?? "key").replace(/[^A-Za-z0-9_.-]+/g, "-")}-${key.split(/\s+/)[1]?.slice(-8) ?? Date.now()}`.slice(
      0,
      100,
    );
  const res = await api
    .get<{ "ssh-keys"?: Json[] }>(DEFAULT_ZONE, "/ssh-key")
    .catch(() => ({}) as Json);
  if ((((res as Json)["ssh-keys"] as Json[] | undefined) ?? []).some((k) => k["name"] === name))
    return name;
  await api.mutate(DEFAULT_ZONE, "POST", "/ssh-key", { name, "public-key": key });
  return name;
}

export function securityGroupPresetRules(fields: Record<string, string>): Json[] {
  const rules: Json[] = [];
  const both = (protocol: string, port: number, description: string) => {
    for (const network of ["0.0.0.0/0", "::/0"]) {
      rules.push({
        "flow-direction": "ingress",
        protocol,
        network,
        "start-port": port,
        "end-port": port,
        description,
      });
    }
  };
  if (fields["allowSsh"] !== "false") both("tcp", 22, "SSH");
  if (fields["allowWeb"] === "true") {
    both("tcp", 80, "HTTP");
    both("tcp", 443, "HTTPS");
  }
  if (fields["allowPing"] !== "false") {
    rules.push({
      "flow-direction": "ingress",
      protocol: "icmp",
      network: "0.0.0.0/0",
      icmp: { type: 8, code: 0 },
      description: "Ping",
    });
  }
  return rules;
}

export function recordBody(fields: Record<string, string>, includeType = true): Json {
  const type = fields["type"] ?? "A";
  const name = (fields["name"] ?? "").trim();
  return {
    ...(includeType ? { type } : {}),
    name: name === "@" ? "" : name,
    content: fields["content"] ?? "",
    ttl: intOr(fields["ttl"], 3600),
    ...(type === "MX" || type === "SRV" ? { priority: intOr(fields["priority"], 10) } : {}),
  };
}

const splitRef = (ref: string | undefined): { zone: string; id: string } => {
  const v = ref ?? "";
  const i = v.indexOf("/");
  return i < 0 ? { zone: DEFAULT_ZONE, id: v } : { zone: v.slice(0, i), id: v.slice(i + 1) };
};

export async function createBucket(api: ExoscaleApi, zone: string, name: string): Promise<void> {
  const res = await signedS3Fetch({
    accessKey: api.apiKey,
    secretKey: api.apiSecret,
    region: zone,
    method: "PUT",
    url: `${sosEndpoint(zone)}/${encodeURIComponent(name)}`,
  });
  if (!res.ok) {
    const err = new Error(
      `SOS refused to create the bucket: ${res.status} ${(await res.text()).slice(0, 200)}`,
    ) as Error & { status: number };
    err.status = res.status;
    throw err;
  }
}

export async function createResource(
  api: ExoscaleApi,
  typeId: string,
  accountId: string,
  fields: Record<string, string>,
  parentResourceId?: string,
): Promise<ResourceInstance> {
  const zone = fields["zone"] || DEFAULT_ZONE;
  const labels = labelsFromText(fields["labels"]);
  switch (typeId) {
    case "instance": {
      const sshKey = fields["sshPublicKey"] ? await ensureSshKey(api, fields["sshPublicKey"]) : "";
      const groups = listValue(fields["securityGroups"]);
      const op = await api.mutate(zone, "POST", "/instance", {
        name: fields["name"],
        "instance-type": { id: fields["instanceType"] },
        template: { id: fields["template"] },
        "disk-size": intOr(fields["diskGb"], 50),
        "public-ip-assignment": fields["publicIp"] || "inet4",
        ...(sshKey ? { "ssh-key": { name: sshKey } } : {}),
        ...(groups.length ? { "security-groups": groups.map((id) => ({ id })) } : {}),
        ...(fields["userData"] ? { "user-data": utf8ToBase64(fields["userData"]) } : {}),
        ...(Object.keys(labels).length ? { labels } : {}),
      });
      const id = op.reference?.id ?? "";
      if (fields["privateNetworkId"] && id) {
        await api.mutate(zone, "PUT", `/private-network/${fields["privateNetworkId"]}:attach`, {
          instance: { id },
        });
      }
      const created = id
        ? await api
            .get<Json>(zone, `/instance/${id}`)
            .catch(() => ({ id, name: fields["name"] }) as Json)
        : { id, name: fields["name"] };
      return mapInstance(created, zone, accountId);
    }
    case "block-storage": {
      const op = await api.mutate(zone, "POST", "/block-storage", {
        name: fields["name"],
        size: intOr(fields["sizeGb"], 50),
      });
      const id = op.reference?.id ?? "";
      if (fields["instanceId"] && id) {
        await api.mutate(zone, "PUT", `/block-storage/${id}:attach`, {
          instance: { id: fields["instanceId"] },
        });
      }
      return mapVolume(
        {
          id,
          name: fields["name"],
          size: intOr(fields["sizeGb"], 50),
          instance: fields["instanceId"] ? { id: fields["instanceId"] } : undefined,
        },
        zone,
        accountId,
      );
    }
    case "block-storage-snapshot": {
      const ref = splitRef(fields["volumeRef"]);
      if (!ref.id) throw new Error("Pick the volume to snapshot.");
      const op = await api.mutate(ref.zone, "POST", `/block-storage/${ref.id}:create-snapshot`, {
        name: fields["name"],
      });
      return mapVolumeSnapshot(
        {
          id: op.reference?.id ?? "",
          name: fields["name"],
          "block-storage-volume": { id: ref.id },
        },
        ref.zone,
        accountId,
      );
    }
    case "snapshot": {
      const ref = splitRef(fields["instanceRef"]);
      if (!ref.id) throw new Error("Pick the instance to snapshot.");
      const op = await api.mutate(ref.zone, "POST", `/instance/${ref.id}:create-snapshot`);
      return mapSnapshot(
        { id: op.reference?.id ?? "", name: "snapshot", instance: { id: ref.id } },
        ref.zone,
        accountId,
      );
    }
    case "template": {
      const op = await api.mutate(zone, "POST", "/template", {
        name: fields["name"],
        url: fields["url"],
        checksum: fields["checksum"],
        "default-user": fields["defaultUser"] || undefined,
        description: fields["description"] || undefined,
        "ssh-key-enabled": true,
        "password-enabled": false,
      });
      return instance(
        accountId,
        "template",
        `${zone}/${op.reference?.id ?? ""}`,
        fields["name"] ?? "",
        { name: fields["name"] ?? "", region: zone },
        {
          outputs: { templateId: op.reference?.id ?? "" },
        },
      );
    }
    case "private-network": {
      const managed = fields["managed"] !== "false";
      const op = await api.mutate(zone, "POST", "/private-network", {
        name: fields["name"],
        ...(fields["description"] ? { description: fields["description"] } : {}),
        ...(managed
          ? { "start-ip": fields["startIp"], "end-ip": fields["endIp"], netmask: fields["netmask"] }
          : {}),
      });
      return mapPrivateNetwork(
        {
          id: op.reference?.id ?? "",
          name: fields["name"],
          "start-ip": managed ? fields["startIp"] : "",
          "end-ip": fields["endIp"],
          netmask: fields["netmask"],
        },
        zone,
        accountId,
      );
    }
    case "security-group": {
      const op = await api.mutate(DEFAULT_ZONE, "POST", "/security-group", {
        name: fields["name"],
        ...(fields["description"] ? { description: fields["description"] } : {}),
      });
      const id = op.reference?.id ?? "";
      const rules = securityGroupPresetRules(fields);
      for (const rule of rules)
        await api.mutate(DEFAULT_ZONE, "POST", `/security-group/${id}/rules`, rule);
      return mapSecurityGroup(
        { id, name: fields["name"], description: fields["description"], rules },
        accountId,
      );
    }
    case "elastic-ip": {
      const mode = fields["healthcheckMode"];
      const op = await api.mutate(zone, "POST", "/elastic-ip", {
        addressfamily: fields["family"] || "inet4",
        ...(fields["description"] ? { description: fields["description"] } : {}),
        ...(mode
          ? {
              healthcheck: {
                mode,
                port: intOr(fields["healthcheckPort"], 80),
                ...(mode !== "tcp" ? { uri: fields["healthcheckUri"] || "/" } : {}),
              },
            }
          : {}),
      });
      const id = op.reference?.id ?? "";
      const eip = id
        ? await api.get<Json>(zone, `/elastic-ip/${id}`).catch(() => ({ id }) as Json)
        : { id };
      return mapElasticIp(eip, zone, accountId, []);
    }
    case "sks-cluster": {
      const op = await api.mutate(zone, "POST", "/sks-cluster", {
        name: fields["name"],
        version: fields["version"],
        level: fields["level"] || "starter",
        cni: fields["cni"] || "calico",
        "auto-upgrade": fields["autoUpgrade"] !== "false",
        "create-default-security-group": fields["defaultSecurityGroup"] !== "false",
        addons: [
          "exoscale-cloud-controller",
          "exoscale-container-storage-interface",
          "metrics-server",
        ],
        ...(fields["description"] ? { description: fields["description"] } : {}),
      });
      const id = op.reference?.id ?? "";
      const cluster = id
        ? await api
            .get<Json>(zone, `/sks-cluster/${id}`)
            .catch(() => ({ id, name: fields["name"] }) as Json)
        : { id, name: fields["name"] };
      return mapCluster(cluster, zone, accountId);
    }
    case "sks-nodepool": {
      const ref = fields["clusterRef"]
        ? splitRef(fields["clusterRef"])
        : parentResourceId
          ? zonal(parentResourceId)
          : { zone: "", id: "" };
      if (!ref.id) throw new Error("Pick the cluster.");
      const groups = listValue(fields["securityGroups"]);
      const op = await api.mutate(ref.zone, "POST", `/sks-cluster/${ref.id}/nodepool`, {
        name: fields["name"],
        "instance-type": { id: fields["instanceType"] },
        size: intOr(fields["size"], 2),
        "disk-size": intOr(fields["diskGb"], 50),
        ...(groups.length ? { "security-groups": groups.map((id) => ({ id })) } : {}),
      });
      const cluster = await api
        .get<Json>(ref.zone, `/sks-cluster/${ref.id}`)
        .catch(() => ({ id: ref.id }) as Json);
      const pool = ((cluster["nodepools"] as Json[] | undefined) ?? []).find(
        (p) => p["id"] === op.reference?.id,
      ) ?? { id: op.reference?.id ?? "", name: fields["name"], size: intOr(fields["size"], 2) };
      return mapNodepool(pool, cluster, ref.zone, accountId);
    }
    case "nlb": {
      const op = await api.mutate(zone, "POST", "/load-balancer", {
        name: fields["name"],
        ...(fields["description"] ? { description: fields["description"] } : {}),
      });
      const id = op.reference?.id ?? "";
      const lb = id
        ? await api
            .get<Json>(zone, `/load-balancer/${id}`)
            .catch(() => ({ id, name: fields["name"] }) as Json)
        : { id };
      return mapNlb(lb, zone, accountId);
    }
    case "dbaas": {
      const [type, plan] = (fields["plan"] ?? "").includes(":")
        ? (fields["plan"] ?? "").split(":")
        : [fields["type"] ?? "pg", fields["plan"] ?? ""];
      const name = fields["name"] ?? "";
      const version = fields[`version_${type}`];
      await api.mutate(zone, "POST", `/dbaas-${dbaasPath(type ?? "pg")}/${name}`, {
        plan,
        ...(version ? { version } : {}),
        "ip-filter": listValue(fields["ipFilter"]),
        "termination-protection": fields["terminationProtection"] !== "false",
      });
      return mapDbaas({ name, type, zone, plan, state: "rebuilding" }, accountId);
    }
    case "dbaas-user":
    case "dbaas-database": {
      const ref = fields["service"]
        ? splitRef(fields["service"])
        : parentResourceId
          ? zonal(parentResourceId)
          : { zone: "", id: "" };
      if (!ref.id) throw new Error("Pick the database service.");
      const svc = await api.get<{ "dbaas-services"?: Json[] }>(DEFAULT_ZONE, "/dbaas-service");
      const found = (svc["dbaas-services"] ?? []).find((s) => s["name"] === ref.id);
      const type = str(found?.["type"]);
      if (!type) throw new Error("That database service no longer exists.");
      const base = `/dbaas-${dbaasPath(type)}/${ref.id}`;
      if (typeId === "dbaas-user") {
        await api.mutate(ref.zone, "POST", `${base}/user`, { username: fields["username"] });
        return mapDbaasUser(
          { username: fields["username"], type: "normal" },
          { name: ref.id, zone: ref.zone },
          accountId,
        );
      }
      await api.mutate(ref.zone, "POST", `${base}/database`, { "database-name": fields["name"] });
      return mapDbaasDatabase(fields["name"] ?? "", { name: ref.id, zone: ref.zone }, accountId);
    }
    case "dns-domain": {
      const op = await api.mutate(DEFAULT_ZONE, "POST", "/dns-domain", {
        "unicode-name": fields["name"],
      });
      return mapDomain(
        { id: op.reference?.id ?? "", "unicode-name": fields["name"] },
        accountId,
        0,
      );
    }
    case "dns-record": {
      const domainId = fields["domainId"] || (parentResourceId ? trailingId(parentResourceId) : "");
      if (!domainId) throw new Error("Pick the domain.");
      const op = await api.mutate(
        DEFAULT_ZONE,
        "POST",
        `/dns-domain/${domainId}/record`,
        recordBody(fields),
      );
      const domain = await api
        .get<Json>(DEFAULT_ZONE, `/dns-domain/${domainId}`)
        .catch(() => ({ id: domainId }) as Json);
      return instance(
        accountId,
        "dns-record",
        `${domainId}/${op.reference?.id ?? ""}`,
        `${fields["name"] || "@"} ${fields["type"] ?? "A"}`,
        {
          type: fields["type"] ?? "A",
          name: fields["name"] ?? "",
          content: fields["content"] ?? "",
          ttl: intOr(fields["ttl"], 3600) ?? 3600,
          priority: intOr(fields["priority"], 0) ?? 0,
          domainName: str(domain["unicode-name"]),
        },
        { parentResourceId: `${accountId}:dns-domain:${domainId}` },
      );
    }
    case "bucket": {
      await createBucket(api, zone, fields["name"] ?? "");
      return mapBucket({ name: fields["name"], "zone-name": zone, size: 0 }, accountId);
    }
    case "ssh-key": {
      await api.mutate(DEFAULT_ZONE, "POST", "/ssh-key", {
        name: fields["name"],
        "public-key": (fields["publicKey"] ?? "").trim(),
      });
      return instance(accountId, "ssh-key", fields["name"] ?? "", fields["name"] ?? "", {
        name: fields["name"] ?? "",
        fingerprint: "",
      });
    }
    case "anti-affinity-group": {
      const op = await api.mutate(DEFAULT_ZONE, "POST", "/anti-affinity-group", {
        name: fields["name"],
        ...(fields["description"] ? { description: fields["description"] } : {}),
      });
      return instance(
        accountId,
        "anti-affinity-group",
        op.reference?.id ?? "",
        fields["name"] ?? "",
        { name: fields["name"] ?? "", description: fields["description"] ?? "", instanceCount: 0 },
        {
          outputs: { groupId: op.reference?.id ?? "" },
        },
      );
    }
    default:
      throw new Error(`Exoscale plugin: cannot create "${typeId}"`);
  }
}

export type { SelectOption };
