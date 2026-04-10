import type {
  PluginClient,
  ResourceInstance,
  DetailViewSchema,
  SidebarItemSchema,
  StorageObject,
  CreateResourceConfig,
  SizeOption,
  ImageOption,
  DiskOption,
  SqlTableMeta,
} from "@infrawrench/plugin-base";
import { dnsRecordBadgeColor, formatDnsTtl } from "@infrawrench/plugin-base";
import { fetchAccessToken, type ServiceAccountKey } from "./auth.js";
import { formatBytes, gcpStatus } from "./utils.js";
import {
  type PricingCacheEntry,
  type PricingRates,
  type GeoRegion,
  regionFromZone,
  geoFromRegion,
  fetchPricingRatesForGeo,
  estimateMachineTypeMonthlyPrices,
} from "./pricing.js";
import type { ListerContext } from "./resource-listers.js";
import * as listers from "./resource-listers.js";

// ─── Token cache ─────────────────────────────────────────────────────────────

interface TokenCache {
  token: string;
  expiresAt: number; // ms
}

// ─── Client ──────────────────────────────────────────────────────────────────

export class GcpClient implements PluginClient {
  private readonly key: ServiceAccountKey;
  private readonly project: string;
  private tokenCache: TokenCache | null = null;
  private machineTypeFamilyRateCache = new Map<string, PricingCacheEntry>();
  private pricingRatesInFlightByGeo = new Map<string, Promise<PricingRates>>();
  /** Cached machine type specs (vcpus + memoryMb) keyed by machine type name, populated during getCreateConfig. */
  private machineTypeSpecCache = new Map<string, { guestCpus: number; memoryMb: number }>();

  constructor(credentials: Record<string, string>) {
    const raw = credentials["serviceAccountJson"];
    if (!raw) throw new Error("GCP plugin: missing serviceAccountJson credential");
    this.key = JSON.parse(raw) as ServiceAccountKey;
    this.project = credentials["project"]?.trim() || this.key.project_id;
    if (!this.project) throw new Error("GCP plugin: could not determine project ID");
  }

  private async token(): Promise<string> {
    const now = Date.now();
    if (this.tokenCache && this.tokenCache.expiresAt > now + 60_000) {
      return this.tokenCache.token;
    }
    const t = await fetchAccessToken(this.key);
    this.tokenCache = { token: t, expiresAt: now + 3_600_000 };
    return t;
  }

  private async get<T>(url: string): Promise<T> {
    const tok = await this.token();
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${tok}` },
    });
    if (!res.ok) {
      throw new Error(`GCP API ${res.status} for ${url}: ${await res.text()}`);
    }
    return res.json() as Promise<T>;
  }

  /** Follow nextPageToken until exhausted, collecting `key` array from each page. */
  private async paginate<T>(
    baseUrl: string,
    key: string,
    params: Record<string, string> = {},
  ): Promise<T[]> {
    const results: T[] = [];
    let pageToken: string | undefined;
    do {
      const url = new URL(baseUrl);
      for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
      if (pageToken) url.searchParams.set("pageToken", pageToken);
      const page = await this.get<Record<string, unknown>>(url.toString());
      const items = page[key];
      if (Array.isArray(items)) results.push(...(items as T[]));
      pageToken = page["nextPageToken"] as string | undefined;
    } while (pageToken);
    return results;
  }

  private get listerCtx(): ListerContext {
    return {
      get: this.get.bind(this),
      paginate: this.paginate.bind(this),
      id: this.id.bind(this),
      now: this.now.bind(this),
    };
  }

  async listResources(typeId: string, accountId: string): Promise<ResourceInstance[]> {
    const p = this.project;
    const ctx = this.listerCtx;
    switch (typeId) {
      case "gce-instance":       return listers.listGceInstances(ctx, accountId, p);
      case "gce-disk":           return listers.listGceDisks(ctx, accountId, p);
      case "gke-cluster":        return listers.listGkeClusters(ctx, accountId, p);
      case "cloudsql-instance":  return listers.listCloudSqlInstances(ctx, accountId, p);
      case "spanner-instance":   return listers.listSpannerInstances(ctx, accountId, p);
      case "bigtable-instance":  return listers.listBigtableInstances(ctx, accountId, p);
      case "firestore-database": return listers.listFirestoreDatabases(ctx, accountId, p);
      case "memorystore-redis":  return listers.listMemorystoreRedis(ctx, accountId, p);
      case "alloydb-cluster":    return listers.listAlloyDbClusters(ctx, accountId, p);
      case "gcs-bucket":         return listers.listGcsBuckets(ctx, accountId, p);
      case "pubsub-topic":       return listers.listPubSubTopics(ctx, accountId, p);
      case "pubsub-subscription":return listers.listPubSubSubscriptions(ctx, accountId, p);
      case "cloud-run-service":  return listers.listCloudRunServices(ctx, accountId, p);
      case "cloud-function":     return listers.listCloudFunctions(ctx, accountId, p);
      case "vpc-network":        return listers.listVpcNetworks(ctx, accountId, p);
      case "bigquery-dataset":   return listers.listBigQueryDatasets(ctx, accountId, p);
      case "artifact-registry-repo": return listers.listArtifactRegistryRepos(ctx, accountId, p);
      case "gcp-service-account":return listers.listServiceAccounts(ctx, accountId, p);
      case "cloud-armor-policy": return listers.listCloudArmorPolicies(ctx, accountId, p);
      case "secret-manager-secret": return listers.listSecretManagerSecrets(ctx, accountId, p);
      case "dataflow-job":       return listers.listDataflowJobs(ctx, accountId, p);
      case "cloud-dns-zone":     return listers.listCloudDnsZones(ctx, accountId, p);
      case "cloud-dns-record-set": return listers.listCloudDnsRecordSets(ctx, accountId, p);
      default:
        throw new Error(`GCP plugin: unknown resource type "${typeId}"`);
    }
  }

  async getResource(typeId: string, resourceId: string, accountId: string): Promise<ResourceInstance> {
    const all = await this.listResources(typeId, accountId);
    const found = all.find((r) => r.id === resourceId);
    if (!found) throw new Error(`GCP plugin: resource ${typeId}/${resourceId} not found`);
    return found;
  }

  async resolveOutput(typeId: string, resourceId: string, outputKey: string, accountId: string): Promise<string> {
    const p = this.project;

    if (typeId === "gke-cluster" && outputKey === "kubeconfig") {
      const resource = await this.getResource(typeId, resourceId, accountId);
      const cluster = await this.get<Record<string, unknown>>(
        `https://container.googleapis.com/v1/projects/${p}/locations/${String(resource.fields["location"])}/clusters/${resource.externalId}`,
      );
      // The endpoint comes from the API response, not from resolvedOutputs
      const endpoint = (cluster["endpoint"] as string) ?? "";
      const caCert = ((cluster["masterAuth"] as Record<string, unknown> | undefined)?.["clusterCaCertificate"] as string) ?? "";
      const tok = await this.token();
      const kubeconfig = [
        "apiVersion: v1",
        "kind: Config",
        `clusters:`,
        `- cluster:`,
        `    server: https://${endpoint}`,
        `    certificate-authority-data: ${caCert}`,
        `  name: ${String(cluster["name"])}`,
        `contexts:`,
        `- context:`,
        `    cluster: ${String(cluster["name"])}`,
        `    user: ${String(cluster["name"])}`,
        `  name: ${String(cluster["name"])}`,
        `current-context: ${String(cluster["name"])}`,
        `users:`,
        `- name: ${String(cluster["name"])}`,
        `  user:`,
        `    token: ${tok}`,
      ].join("\n");
      return kubeconfig;
    }

    if (typeId === "memorystore-redis") {
      const resource = await this.getResource(typeId, resourceId, accountId);
      if (outputKey === "authString") {
        const name = resource.externalId ?? "";
        const data = await this.get<Record<string, unknown>>(
          `https://redis.googleapis.com/v1/${name}/authString`,
        );
        return (data["authString"] as string) ?? "";
      }
      if (outputKey === "host") return String(resource.fields["host"] ?? resource.resolvedOutputs["host"] ?? "");
      if (outputKey === "port") return String(resource.fields["port"] ?? resource.resolvedOutputs["port"] ?? "6379");
      if (outputKey === "redisUrl") {
        const host = String(resource.fields["host"] ?? resource.resolvedOutputs["host"] ?? "");
        const port = String(resource.fields["port"] ?? resource.resolvedOutputs["port"] ?? "6379");
        const name = resource.externalId ?? "";
        try {
          const data = await this.get<Record<string, unknown>>(`https://redis.googleapis.com/v1/${name}/authString`);
          const auth = (data["authString"] as string) ?? "";
          return auth ? `redis://:${auth}@${host}:${port}` : `redis://${host}:${port}`;
        } catch {
          return `redis://${host}:${port}`;
        }
      }
    }

    if (typeId === "cloudsql-instance") {
      const resource = await this.getResource(typeId, resourceId, accountId);
      if (outputKey === "connectionName") return String(resource.fields["connectionName"] ?? resource.resolvedOutputs["connectionName"] ?? "");
      if (outputKey === "ipAddress") return String(resource.fields["ipAddress"] ?? resource.resolvedOutputs["ipAddress"] ?? "");
    }

    if (typeId === "gcs-bucket") {
      if (outputKey === "bucketName") {
        const resource = await this.getResource(typeId, resourceId, accountId);
        return String(resource.fields["name"] ?? resource.displayName);
      }
      if (outputKey === "endpoint") {
        const resource = await this.getResource(typeId, resourceId, accountId);
        return `https://storage.googleapis.com/${String(resource.fields["name"] ?? resource.displayName)}`;
      }
      if (outputKey === "serviceAccountKey") {
        // Create a new service account key via the IAM API
        const tok = await this.token();
        const email = this.key.client_email;
        const res = await fetch(
          `https://iam.googleapis.com/v1/projects/${this.project}/serviceAccounts/${encodeURIComponent(email)}/keys`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${tok}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ keyAlgorithm: "KEY_ALG_RSA_2048" }),
          },
        );
        if (!res.ok) throw new Error(`IAM API ${res.status}: ${await res.text()}`);
        const data = await res.json() as { privateKeyData: string };
        // privateKeyData is base64-encoded JSON — decode it
        return atob(data.privateKeyData);
      }
    }

    if (typeId === "cloud-dns-zone" && outputKey === "nameservers") {
      const resource = await this.getResource(typeId, resourceId, accountId);
      return String(resource.fields["nameservers"] ?? "");
    }

    if (typeId === "secret-manager-secret" && outputKey === "latestVersion") {
      const resource = await this.getResource(typeId, resourceId, accountId);
      const secretName = resource.externalId ?? "";
      const data = await this.get<Record<string, unknown>>(
        `https://secretmanager.googleapis.com/v1/${secretName}/versions/latest:access`,
      );
      const payload = data["payload"] as Record<string, unknown> | undefined;
      const b64 = (payload?.["data"] as string) ?? "";
      return atob(b64);
    }

    throw new Error(`GCP plugin: cannot resolve output "${outputKey}" for type "${typeId}"`);
  }

  // Region slug → {location, flag}
  private static readonly REGION_INFO: Record<string, { location: string; flag: string }> = {
    "us-central1":          { location: "Iowa, USA",               flag: "🇺🇸" },
    "us-east1":             { location: "South Carolina, USA",      flag: "🇺🇸" },
    "us-east4":             { location: "Northern Virginia, USA",   flag: "🇺🇸" },
    "us-east5":             { location: "Columbus, Ohio, USA",      flag: "🇺🇸" },
    "us-south1":            { location: "Dallas, Texas, USA",       flag: "🇺🇸" },
    "us-west1":             { location: "Oregon, USA",              flag: "🇺🇸" },
    "us-west2":             { location: "Los Angeles, USA",         flag: "🇺🇸" },
    "us-west3":             { location: "Salt Lake City, USA",      flag: "🇺🇸" },
    "us-west4":             { location: "Las Vegas, USA",           flag: "🇺🇸" },
    "northamerica-northeast1": { location: "Montréal, Canada",        flag: "🇨🇦" },
    "northamerica-northeast2": { location: "Toronto, Canada",         flag: "🇨🇦" },
    "northamerica-south1":  { location: "Dallas, Texas, USA",         flag: "🇺🇸" },
    "southamerica-east1":   { location: "São Paulo, Brazil",          flag: "🇧🇷" },
    "southamerica-west1":   { location: "Santiago, Chile",            flag: "🇨🇱" },
    "europe-west1":         { location: "Belgium",                    flag: "🇧🇪" },
    "europe-west2":         { location: "London, UK",                 flag: "🇬🇧" },
    "europe-west3":         { location: "Frankfurt, Germany",         flag: "🇩🇪" },
    "europe-west4":         { location: "Netherlands",                flag: "🇳🇱" },
    "europe-west6":         { location: "Zurich, Switzerland",        flag: "🇨🇭" },
    "europe-west8":         { location: "Milan, Italy",               flag: "🇮🇹" },
    "europe-west9":         { location: "Paris, France",              flag: "🇫🇷" },
    "europe-west10":        { location: "Berlin, Germany",            flag: "🇩🇪" },
    "europe-west12":        { location: "Turin, Italy",               flag: "🇮🇹" },
    "europe-central2":      { location: "Warsaw, Poland",             flag: "🇵🇱" },
    "europe-north1":        { location: "Finland",                    flag: "🇫🇮" },
    "europe-north2":        { location: "Stockholm, Sweden",          flag: "🇸🇪" },
    "europe-southwest1":    { location: "Madrid, Spain",              flag: "🇪🇸" },
    "asia-east1":           { location: "Taiwan",                     flag: "🇹🇼" },
    "asia-east2":           { location: "Hong Kong",                  flag: "🇭🇰" },
    "asia-northeast1":      { location: "Tokyo, Japan",               flag: "🇯🇵" },
    "asia-northeast2":      { location: "Osaka, Japan",               flag: "🇯🇵" },
    "asia-northeast3":      { location: "Seoul, South Korea",         flag: "🇰🇷" },
    "asia-south1":          { location: "Mumbai, India",              flag: "🇮🇳" },
    "asia-south2":          { location: "Delhi, India",               flag: "🇮🇳" },
    "asia-southeast1":      { location: "Singapore",                  flag: "🇸🇬" },
    "asia-southeast2":      { location: "Jakarta, Indonesia",         flag: "🇮🇩" },
    "australia-southeast1": { location: "Sydney, Australia",          flag: "🇦🇺" },
    "australia-southeast2": { location: "Melbourne, Australia",       flag: "🇦🇺" },
    "me-west1":             { location: "Tel Aviv, Israel",           flag: "🇮🇱" },
    "me-central1":          { location: "Doha, Qatar",                flag: "🇶🇦" },
    "me-central2":          { location: "Dammam, Saudi Arabia",       flag: "🇸🇦" },
    "africa-south1":        { location: "Johannesburg, South Africa", flag: "🇿🇦" },
  };

  // Curated public image families — no API call needed, GCP resolves to latest
  private static readonly PUBLIC_IMAGES: ImageOption[] = [
    { id: "projects/debian-cloud/global/images/family/debian-12",              label: "Debian 12 (Bookworm)",   category: "Debian",      family: "debian-12" },
    { id: "projects/debian-cloud/global/images/family/debian-11",              label: "Debian 11 (Bullseye)",   category: "Debian",      family: "debian-11" },
    { id: "projects/ubuntu-os-cloud/global/images/family/ubuntu-2404-lts-amd64", label: "Ubuntu 24.04 LTS",     category: "Ubuntu",      family: "ubuntu-2404-lts-amd64" },
    { id: "projects/ubuntu-os-cloud/global/images/family/ubuntu-2204-lts",     label: "Ubuntu 22.04 LTS",       category: "Ubuntu",      family: "ubuntu-2204-lts" },
    { id: "projects/ubuntu-os-cloud/global/images/family/ubuntu-2004-lts",     label: "Ubuntu 20.04 LTS",       category: "Ubuntu",      family: "ubuntu-2004-lts" },
    { id: "projects/centos-cloud/global/images/family/centos-stream-9",        label: "CentOS Stream 9",        category: "CentOS",      family: "centos-stream-9" },
    { id: "projects/rocky-linux-cloud/global/images/family/rocky-linux-9",     label: "Rocky Linux 9",          category: "Rocky Linux", family: "rocky-linux-9" },
    { id: "projects/rocky-linux-cloud/global/images/family/rocky-linux-8",     label: "Rocky Linux 8",          category: "Rocky Linux", family: "rocky-linux-8" },
    { id: "projects/windows-cloud/global/images/family/windows-2022",          label: "Windows Server 2022",    category: "Windows",     family: "windows-2022" },
    { id: "projects/windows-cloud/global/images/family/windows-2019",          label: "Windows Server 2019",    category: "Windows",     family: "windows-2019" },
  ];

  private async getPricingRatesForGeo(geo: GeoRegion): Promise<PricingRates> {
    const cached = this.machineTypeFamilyRateCache.get(geo);
    if (cached && cached.expiresAt > Date.now()) return {
      machineRates: cached.machineRates,
      pdBalancedGbMonthUsd: cached.pdBalancedGbMonthUsd,
    };
    const inFlight = this.pricingRatesInFlightByGeo.get(geo);
    if (inFlight) return inFlight;

    const fetchPromise = (async () => {
      const rates = await fetchPricingRatesForGeo(geo, this.get.bind(this));
      this.machineTypeFamilyRateCache.set(geo, {
        ...rates,
        expiresAt: Date.now() + 6 * 60 * 60 * 1000,
      });
      return rates;
    })();

    this.pricingRatesInFlightByGeo.set(geo, fetchPromise);
    try {
      return await fetchPromise;
    } finally {
      this.pricingRatesInFlightByGeo.delete(geo);
    }
  }

  private async estimateMachineTypeMonthlyPrices(
    machineTypes: Array<{ id: string; vcpus: number; memoryMb: number }>,
    zone: string,
  ): Promise<Record<string, number>> {
    const region = regionFromZone(zone);
    const geo = geoFromRegion(region);
    const rates = await this.getPricingRatesForGeo(geo);
    return estimateMachineTypeMonthlyPrices(machineTypes, rates);
  }

  private async getBalancedDiskMonthlyRate(zone: string): Promise<number | null> {
    const region = regionFromZone(zone);
    const geo = geoFromRegion(region);
    const rates = await this.getPricingRatesForGeo(geo);
    return rates.pdBalancedGbMonthUsd;
  }

  async deleteResource(typeId: string, resourceId: string, accountId: string): Promise<void> {
    const p = this.project;
    const tok = await this.token();

    if (typeId === "gce-instance") {
      const resource = await this.getResource(typeId, resourceId, accountId);
      const zone = String(resource.fields["zone"] ?? "");
      const name = String(resource.fields["name"] ?? (resource.externalId ?? resource.displayName).split("/").pop() ?? "");
      if (!zone || !name) throw new Error("Cannot determine zone or instance name for deletion");
      const res = await fetch(
        `https://compute.googleapis.com/compute/v1/projects/${p}/zones/${zone}/instances/${name}`,
        { method: "DELETE", headers: { Authorization: `Bearer ${tok}` } },
      );
      if (!res.ok) throw new Error(`GCP Compute API ${res.status}: ${await res.text()}`);
      return;
    }

    if (typeId === "gke-cluster") {
      const resource = await this.getResource(typeId, resourceId, accountId);
      const location = String(resource.fields["location"] ?? "");
      const name = resource.externalId ?? resource.displayName;
      if (!location || !name) throw new Error("Cannot determine location or cluster name for deletion");
      const res = await fetch(
        `https://container.googleapis.com/v1/projects/${p}/locations/${location}/clusters/${name}`,
        { method: "DELETE", headers: { Authorization: `Bearer ${tok}` } },
      );
      if (!res.ok) throw new Error(`GKE API ${res.status}: ${await res.text()}`);
      return;
    }

    throw new Error(`GCP plugin: deleteResource not supported for type "${typeId}"`);
  }

  async getCreateConfig(typeId: string): Promise<CreateResourceConfig> {
    const p = this.project;
    if (typeId === "gce-instance") {
      // Fetch zones, machine types, account images, and existing disks in parallel
      const [zonesData, machineTypesData, accountImagesData, disksData] = await Promise.all([
        this.get<{ items?: Array<{ name: string; status: string; region: string }> }>(
          `https://compute.googleapis.com/compute/v1/projects/${p}/zones`,
        ),
        this.get<{ items?: Array<{ name: string; guestCpus: number; memoryMb: number }> }>(
          `https://compute.googleapis.com/compute/v1/projects/${p}/zones/us-central1-a/machineTypes?maxResults=500`,
        ),
        this.get<{ items?: Array<{ name: string; selfLink: string; description?: string; status: string }> }>(
          `https://compute.googleapis.com/compute/v1/projects/${p}/global/images`,
        ).catch(() => ({ items: [] as Array<{ name: string; selfLink: string; description?: string; status: string }> })),
        this.get<{ items?: Record<string, { disks?: Array<{ name: string; selfLink: string; sizeGb: string; status: string; type: string; zone: string }> }> }>(
          `https://compute.googleapis.com/compute/v1/projects/${p}/aggregated/disks`,
        ).catch(() => ({ items: {} })),
      ]);

      // Zones
      const zones = (zonesData.items ?? [])
        .filter((z) => z.status === "UP")
        .map((z) => {
          const regionSlug = z.region.split("/").pop() ?? z.region;
          const info = GcpClient.REGION_INFO[regionSlug];
          return {
            id: z.name,
            label: z.name,
            ...(info ? { location: info.location, flag: info.flag } : { location: regionSlug }),
          };
        })
        .sort((a, b) => a.id.localeCompare(b.id));

      // Machine types grouped by family
      const familyOrder = ["e2", "n1", "n2", "n2d", "c2", "c3", "m1", "m2", "a2", "g2"];
      const familyLabels: Record<string, string> = {
        e2: "E2 · Cost-optimized", n1: "N1 · General purpose", n2: "N2 · General purpose",
        n2d: "N2D · AMD general purpose", c2: "C2 · Compute-optimized", c3: "C3 · Compute-optimized",
        m1: "M1 · Memory-optimized", m2: "M2 · Memory-optimized", a2: "A2 · GPU", g2: "G2 · GPU",
      };
      const machineTypes = (machineTypesData.items ?? []).filter((m) => !m.name.includes("custom"));

      // Pre-populate machine type spec cache so getCreateCostEstimate can skip the API call
      for (const m of machineTypes) {
        this.machineTypeSpecCache.set(m.name, { guestCpus: m.guestCpus, memoryMb: m.memoryMb });
      }

      const sizes: SizeOption[] = machineTypes
        .map((m) => {
          const family = familyOrder.find((f) => m.name.startsWith(f)) ?? m.name.split("-")[0] ?? "other";
          return {
            id: m.name,
            label: m.name,
            vcpus: m.guestCpus,
            memoryMb: m.memoryMb,
            category: familyLabels[family] ?? family.toUpperCase(),
          };
        })
        .sort((a, b) => {
          const ai = familyOrder.indexOf(a.category?.split(" ")[0]?.toLowerCase() ?? "");
          const bi = familyOrder.indexOf(b.category?.split(" ")[0]?.toLowerCase() ?? "");
          if (ai !== bi) return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
          return a.vcpus - b.vcpus || a.memoryMb - b.memoryMb;
        });

      // Images: public families + account-owned
      const accountImages: ImageOption[] = (accountImagesData.items ?? [])
        .filter((i) => i.status === "READY")
        .map((i) => ({ id: i.selfLink, label: i.name, ...(i.description ? { description: i.description } : {}), category: "My Images", isOwned: true as const }));
      const images: ImageOption[] = [...GcpClient.PUBLIC_IMAGES, ...accountImages];

      // Existing disks from aggregated list
      const disks: DiskOption[] = [];
      for (const zoneData of Object.values(disksData.items ?? {}) as Array<{
        disks?: Array<{ name: string; selfLink: string; sizeGb: string; status: string; type: string; zone: string }>;
      }>) {
        for (const d of zoneData.disks ?? []) {
          if (d.status !== "READY") continue;
          const zone = d.zone.split("/").pop() ?? d.zone;
          const diskType = d.type.split("/").pop() ?? "";
          disks.push({ id: d.selfLink, label: d.name, sizeGb: Number(d.sizeGb), zone, diskType });
        }
      }
      disks.sort((a, b) => a.label.localeCompare(b.label));
      const defaultZone = zones.find((z) => z.id === "us-central1-a")?.id ?? zones[0]?.id;

      return {
        fields: [
          { key: "name",        label: "Name",         kind: "text",          required: true },
          { key: "zone",        label: "Zone",          kind: "region-picker", required: true,  regions: zones,  ...(defaultZone ? { defaultValue: defaultZone } : {}) },
          { key: "machineType", label: "Machine Type",  kind: "size-picker",   required: true,  sizes,           defaultValue: "e2-medium" },
          { key: "bootSource",  label: "Boot Disk",     kind: "select",        required: true,  defaultValue: "new-image",
            options: [
              { id: "new-image",      label: "New disk from OS image" },
              { id: "existing-disk",  label: "Existing persistent disk" },
            ],
          },
          { key: "image",  label: "OS Image",       kind: "image-picker", required: true,  images, defaultValue: "projects/debian-cloud/global/images/family/debian-12",
            showWhen: { fieldKey: "bootSource", fieldValue: "new-image" } },
          { key: "diskGb", label: "Boot Disk Size",  kind: "disk-slider",  required: false, minGb: 10, maxGb: 2000, defaultGb: 50, stepGb: 10,
            showWhen: { fieldKey: "bootSource", fieldValue: "new-image" } },
          { key: "existingDisk", label: "Select Disk", kind: "disk-picker", required: true,  disks,
            showWhen: { fieldKey: "bootSource", fieldValue: "existing-disk" } },
          { key: "sshPublicKey", label: "SSH Key", kind: "ssh-key-picker", required: false },
        ],
      };
    }

    if (typeId === "gke-cluster") {
      const [zonesData, machineTypesData, serverConfig] = await Promise.all([
        this.get<{ items?: Array<{ name: string; status: string; region: string }> }>(
          `https://compute.googleapis.com/compute/v1/projects/${p}/zones`,
        ),
        this.get<{ items?: Array<{ name: string; guestCpus: number; memoryMb: number }> }>(
          `https://compute.googleapis.com/compute/v1/projects/${p}/zones/us-central1-a/machineTypes?maxResults=500`,
        ),
        this.get<{
          defaultClusterVersion?: string;
          validMasterVersions?: string[];
        }>(`https://container.googleapis.com/v1/projects/${p}/locations/us-central1-a/serverConfig`),
      ]);

      const locations = (zonesData.items ?? [])
        .filter((zone) => zone.status === "UP")
        .map((zone) => {
          const regionSlug = zone.region.split("/").pop() ?? zone.region;
          const info = GcpClient.REGION_INFO[regionSlug];
          return {
            id: zone.name,
            label: zone.name,
            ...(info ? { location: info.location, flag: info.flag } : { location: regionSlug }),
          };
        })
        .sort((a, b) => a.id.localeCompare(b.id));
      const machineTypes = (machineTypesData.items ?? []).filter((m) => !m.name.includes("custom"));

      // Pre-populate machine type spec cache for GKE cost estimates
      for (const m of machineTypes) {
        this.machineTypeSpecCache.set(m.name, { guestCpus: m.guestCpus, memoryMb: m.memoryMb });
      }

      const familyOrder = ["e2", "n1", "n2", "n2d", "c2", "c3", "m1", "m2", "a2", "g2"];
      const familyLabels: Record<string, string> = {
        e2: "E2 · Cost-optimized", n1: "N1 · General purpose", n2: "N2 · General purpose",
        n2d: "N2D · AMD general purpose", c2: "C2 · Compute-optimized", c3: "C3 · Compute-optimized",
        m1: "M1 · Memory-optimized", m2: "M2 · Memory-optimized", a2: "A2 · GPU", g2: "G2 · GPU",
      };
      const sizes: SizeOption[] = machineTypes
        .map((machineType) => {
          const family = familyOrder.find((candidate) => machineType.name.startsWith(candidate))
            ?? machineType.name.split("-")[0]
            ?? "other";
          return {
            id: machineType.name,
            label: machineType.name,
            vcpus: machineType.guestCpus,
            memoryMb: machineType.memoryMb,
            category: familyLabels[family] ?? family.toUpperCase(),
          };
        })
        .sort((a, b) => {
          const ai = familyOrder.indexOf(a.category?.split(" ")[0]?.toLowerCase() ?? "");
          const bi = familyOrder.indexOf(b.category?.split(" ")[0]?.toLowerCase() ?? "");
          if (ai !== bi) return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
          return a.vcpus - b.vcpus || a.memoryMb - b.memoryMb;
        });
      const versions = (serverConfig.validMasterVersions ?? []).map((version) => ({
        id: version,
        label: version,
      }));
      const defaultLocation = locations.find((location) => location.id === "us-central1-a")?.id ?? locations[0]?.id;
      const defaultVersion = serverConfig.defaultClusterVersion ?? versions[0]?.id;

      return {
        fields: [
          { key: "name", label: "Name", kind: "text", required: true },
          { key: "location", label: "Location", kind: "region-picker", required: true, regions: locations, ...(defaultLocation ? { defaultValue: defaultLocation } : {}) },
          { key: "version", label: "Kubernetes Version", kind: "select", required: true, options: versions, ...(defaultVersion ? { defaultValue: defaultVersion } : {}) },
          { key: "machineType", label: "Node Machine Type", kind: "size-picker", required: true, sizes, defaultValue: "e2-medium" },
          {
            key: "diskSizeGb",
            label: "Disk Per Node",
            kind: "disk-slider",
            required: false,
            minGb: 10,
            maxGb: 2048,
            defaultGb: 100,
            stepGb: 10,
            description: "Persistent disk size attached to each node.",
          },
          {
            key: "nodeCount",
            label: "Node Count",
            kind: "number",
            required: true,
            defaultValue: "3",
            minValue: 1,
            stepValue: 1,
            description: "Initial number of nodes in the default node pool.",
          },
        ],
      };
    }

    throw new Error(`No create config for type "${typeId}"`);
  }

  async getCreateSizePricing(
    typeId: string,
    request: { regionId?: string; sizes: Array<{ id: string; vcpus: number; memoryMb: number }> },
  ): Promise<Record<string, number>> {
    if (typeId !== "gce-instance" && typeId !== "gke-cluster") return {};
    const zone = request.regionId ?? "us-central1-a";
    return this.estimateMachineTypeMonthlyPrices(request.sizes, zone);
  }

  async getCreateCostEstimate(typeId: string, fields: Record<string, string>): Promise<number | null> {
    if (typeId === "gce-instance") {
      const zone = fields["zone"] ?? "us-central1-a";
      const machineType = fields["machineType"] ?? "";
      if (!machineType) return null;

      // Use cached machine type specs (populated during getCreateConfig) to avoid
      // a network roundtrip on every field change — this lets the cost badge update
      // instantly when the storage slider moves.
      let machineTypeData = this.machineTypeSpecCache.get(machineType);
      if (!machineTypeData) {
        const fetched = await this.get<{ guestCpus: number; memoryMb: number }>(
          `https://compute.googleapis.com/compute/v1/projects/${this.project}/zones/${zone}/machineTypes/${machineType}`,
        ).catch(() => null);
        if (!fetched) return null;
        this.machineTypeSpecCache.set(machineType, fetched);
        machineTypeData = fetched;
      }

      const vmMonthly = (
        await this.estimateMachineTypeMonthlyPrices(
          [{ id: machineType, vcpus: machineTypeData.guestCpus, memoryMb: machineTypeData.memoryMb }],
          zone,
        )
      )[machineType] ?? 0;

      let storageMonthly = 0;
      const bootSource = fields["bootSource"] ?? "new-image";
      if (bootSource === "new-image") {
        const diskGb = Number(fields["diskGb"] ?? 50);
        const diskRate = await this.getBalancedDiskMonthlyRate(zone);
        if (diskRate != null && Number.isFinite(diskGb) && diskGb > 0) {
          storageMonthly = diskGb * diskRate;
        }
      }

      const total = vmMonthly + storageMonthly;
      if (!Number.isFinite(total) || total <= 0) return null;
      return Number(total.toFixed(2));
    }

    if (typeId === "gke-cluster") {
      const zone = fields["location"] ?? "us-central1-a";
      const machineType = fields["machineType"] ?? "";
      const nodeCount = Math.max(1, Number(fields["nodeCount"] ?? 3));
      if (!machineType) return null;

      let machineTypeData = this.machineTypeSpecCache.get(machineType);
      if (!machineTypeData) {
        const fetched = await this.get<{ guestCpus: number; memoryMb: number }>(
          `https://compute.googleapis.com/compute/v1/projects/${this.project}/zones/${zone}/machineTypes/${machineType}`,
        ).catch(() => null);
        if (!fetched) return null;
        this.machineTypeSpecCache.set(machineType, fetched);
        machineTypeData = fetched;
      }

      const perNodeVm = (
        await this.estimateMachineTypeMonthlyPrices(
          [{ id: machineType, vcpus: machineTypeData.guestCpus, memoryMb: machineTypeData.memoryMb }],
          zone,
        )
      )[machineType] ?? 0;

      const diskGb = Number(fields["diskSizeGb"] ?? 100);
      const diskRate = await this.getBalancedDiskMonthlyRate(zone);
      const perNodeDisk = diskRate != null && Number.isFinite(diskGb) && diskGb > 0
        ? diskGb * diskRate
        : 0;

      const total = (perNodeVm + perNodeDisk) * nodeCount;
      if (!Number.isFinite(total) || total <= 0) return null;
      return Number(total.toFixed(2));
    }

    return null;
  }

  async createResource(typeId: string, accountId: string, fields: Record<string, string>): Promise<ResourceInstance> {
    if (typeId === "gce-instance") {
      const p = this.project;
      const zone = fields["zone"] ?? "";
      const machineType = fields["machineType"] ?? "";
      const name = fields["name"] ?? "";
      const tok = await this.token();
      const bootSource = fields["bootSource"] ?? "new-image";

      let bootDisk: Record<string, unknown>;
      if (bootSource === "existing-disk") {
        bootDisk = { boot: true, source: fields["existingDisk"] };
      } else {
        const diskSizeGb = Number(fields["diskGb"] ?? 50);
        bootDisk = {
          boot: true,
          autoDelete: true,
          initializeParams: {
            sourceImage: fields["image"] ?? "projects/debian-cloud/global/images/family/debian-12",
            diskSizeGb: String(diskSizeGb),
          },
        };
      }

      // SSH key → GCP metadata format: "username:ssh-rsa AAAA..."
      let metadata: Record<string, unknown> | undefined;
      const sshPub = fields["sshPublicKey"];
      if (sshPub) {
        const comment = sshPub.trim().split(" ")[2] ?? "";
        const username = comment.split("@")[0] || "user";
        metadata = { items: [{ key: "ssh-keys", value: `${username}:${sshPub.trim()}` }] };
      }

      const body: Record<string, unknown> = {
        name,
        machineType: `zones/${zone}/machineTypes/${machineType}`,
        disks: [bootDisk],
        networkInterfaces: [{
          network: "global/networks/default",
          accessConfigs: [{ type: "ONE_TO_ONE_NAT", name: "External NAT" }],
        }],
        ...(metadata ? { metadata } : {}),
      };
      const res = await fetch(
        `https://compute.googleapis.com/compute/v1/projects/${p}/zones/${zone}/instances`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      if (!res.ok) {
        throw new Error(`GCP Compute API ${res.status}: ${await res.text()}`);
      }
      // The API returns an Operation, not the instance directly — return a stub and let the user refresh
      const now = new Date().toISOString();
      return {
        id: this.id(accountId, "gce-instance", `${p}/${zone}/${name}`),
        pluginId: "gcp",
        resourceTypeId: "gce-instance",
        accountId,
        displayName: name,
        fields: { name, zone, machineType, status: "PROVISIONING" },
        resolvedOutputs: {},
        secretStates: [],
        externalId: name,
        createdAt: now,
        updatedAt: now,
      };
    }

    if (typeId === "gke-cluster") {
      const p = this.project;
      const location = fields["location"] ?? "";
      const machineType = fields["machineType"] ?? "e2-medium";
      const requestedDiskSizeGb = Number.parseInt(fields["diskSizeGb"] ?? "100", 10);
      const diskSizeGb = Number.isFinite(requestedDiskSizeGb) && requestedDiskSizeGb >= 10
        ? requestedDiskSizeGb
        : 100;
      const name = fields["name"] ?? "";
      const version = fields["version"] ?? "";
      const requestedNodeCount = Number.parseInt(fields["nodeCount"] ?? "3", 10);
      const initialNodeCount = Number.isFinite(requestedNodeCount) && requestedNodeCount > 0
        ? requestedNodeCount
        : 3;
      const tok = await this.token();
      const body = {
        cluster: {
          name,
          ...(version ? { initialClusterVersion: version } : {}),
          initialNodeCount,
          nodeConfig: {
            machineType,
            diskSizeGb,
          },
        },
      };
      const res = await fetch(
        `https://container.googleapis.com/v1/projects/${p}/locations/${location}/clusters`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      if (!res.ok) {
        throw new Error(`GKE API ${res.status}: ${await res.text()}`);
      }
      const now = new Date().toISOString();
      return {
        id: this.id(accountId, "gke-cluster", `${p}/${location}/${name}`),
        pluginId: "gcp",
        resourceTypeId: "gke-cluster",
        accountId,
        displayName: name,
        fields: {
          name,
          location,
          version,
          machineType,
          diskSizeGb,
          nodeCount: initialNodeCount,
          status: "PROVISIONING",
        },
        resolvedOutputs: {},
        secretStates: [],
        externalId: name,
        createdAt: now,
        updatedAt: now,
      };
    }

    throw new Error(`GCP plugin: createResource not supported for type "${typeId}"`);
  }

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    const fields = resource.fields;
    const statusVal = String(fields["status"] ?? fields["state"] ?? "");
    const subtitle = String(
      fields["region"] ?? fields["location"] ?? fields["zone"] ?? resource.resourceTypeId,
    );
    const base: DetailViewSchema = {
      title: resource.displayName,
      subtitle,
      status: { kind: "status-dot", status: gcpStatus(statusVal), ...(statusVal ? { label: statusVal } : {}) },
      sections: [
        {
          kind: "section",
          title: "Details",
          children: [
            {
              kind: "key-value-list",
              items: Object.entries(fields)
                .filter(([, v]) => v !== "" && v !== undefined)
                .map(([key, value]) => ({ key, value: String(value) })),
            },
          ],
        },
      ],
      headerActions: [
        { kind: "action", label: "Refresh", action: { type: "refresh-resource" } },
      ],
    };

    if (resource.resourceTypeId === "gcs-bucket") {
      base.storageBrowser = { bucketName: resource.externalId ?? resource.displayName };
      delete base.status;
    }

    if (resource.resourceTypeId === "bigquery-dataset") {
      const datasetId = String(resource.fields["name"] ?? "");
      const tablesJson = resource.resolvedOutputs["__tables__"] ?? "[]";
      const tables: SqlTableMeta[] = (() => { try { return JSON.parse(tablesJson) as SqlTableMeta[]; } catch { return []; } })();
      base.sqlEditor = {
        connectionStringOutputKey: "__bigquery__",
        defaultQuery: `SELECT * FROM \`${datasetId}.INFORMATION_SCHEMA.TABLES\` LIMIT 20`,
        tables,
      };
    }

    if (resource.resourceTypeId === "cloud-dns-zone") {
      const dnsName = String(fields["dnsName"] ?? "");
      const nameservers = String(fields["nameservers"] ?? "");
      const nsList = nameservers.split(", ").filter(Boolean);
      const visibility = String(fields["visibility"] ?? "public");
      const dnssec = String(fields["dnssecState"] ?? "off");
      base.subtitle = `Cloud DNS \u00B7 ${visibility}`;
      base.status = { kind: "status-dot", status: "healthy", label: "Active" };
      base.sections = [
        {
          kind: "section",
          title: "Zone Info",
          children: [
            {
              kind: "key-value-list",
              items: [
                { key: "DNS Name", value: dnsName, copyable: true },
                { key: "Zone Name", value: String(fields["name"] ?? "") },
                { key: "Visibility", value: visibility },
                { key: "DNSSEC", value: dnssec },
                ...(fields["description"] ? [{ key: "Description", value: String(fields["description"]) }] : []),
              ],
            },
          ],
        },
        ...(nsList.length > 0
          ? [
              {
                kind: "section" as const,
                title: "Nameservers",
                children: [
                  {
                    kind: "key-value-list" as const,
                    items: nsList.map((ns, i) => ({
                      key: `NS ${i + 1}`,
                      value: ns,
                      copyable: true,
                    })),
                  },
                  {
                    kind: "text" as const,
                    content: "Point your domain registrar to these nameservers to use Google Cloud DNS.",
                    variant: "muted" as const,
                  },
                ],
              },
            ]
          : []),
      ];
    }

    if (resource.resourceTypeId === "cloud-dns-record-set") {
      const type = String(fields["type"] ?? "");
      const name = String(fields["name"] ?? "");
      const rrdatas = String(fields["rrdatas"] ?? "");
      const ttl = Number(fields["ttl"] ?? 300);
      const zoneName = String(fields["zoneName"] ?? "");
      base.subtitle = `${type} → ${rrdatas.length > 50 ? `${rrdatas.slice(0, 47)}...` : rrdatas}`;
      base.status = { kind: "status-dot", status: "healthy" };
      base.sections = [
        {
          kind: "section",
          title: "Record Details",
          children: [
            { kind: "badge", label: type, color: dnsRecordBadgeColor(type) },
            {
              kind: "key-value-list",
              items: [
                { key: "Type", value: type },
                { key: "Name", value: name, copyable: true },
                { key: "Data", value: rrdatas, copyable: true },
                { key: "TTL", value: formatDnsTtl(ttl) },
                ...(zoneName ? [{ key: "Zone", value: zoneName }] : []),
              ],
            },
          ],
        },
      ];
    }

    return base;
  }

  // ─── BigQuery query execution ─────────────────────────────────────────────

  async executeQuery(resourceId: string, _accountId: string, sql: string): Promise<{ rows: Record<string, unknown>[]; durationMs: number }> {
    const externalId = resourceId.split(":").slice(2).join(":");
    const colonIdx = externalId.indexOf(":");
    const project = externalId.slice(0, colonIdx);
    const datasetId = externalId.slice(colonIdx + 1);
    const tok = await this.token();
    const start = Date.now();

    // Submit query job
    const jobRes = await fetch(
      `https://bigquery.googleapis.com/bigquery/v2/projects/${project}/jobs`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          configuration: {
            query: {
              query: sql,
              useLegacySql: false,
              defaultDataset: { projectId: project, datasetId },
            },
          },
        }),
      },
    );
    if (!jobRes.ok) throw new Error(`BigQuery error ${jobRes.status}: ${await jobRes.text()}`);
    const job = await jobRes.json() as Record<string, unknown>;
    const jobRef = job["jobReference"] as Record<string, string>;
    const jobId = jobRef["jobId"];
    const location = jobRef["location"];

    // Poll until complete (BigQuery Jobs.getQueryResults has built-in timeout)
    let data: Record<string, unknown>;
    for (;;) {
      const r = await fetch(
        `https://bigquery.googleapis.com/bigquery/v2/projects/${project}/queries/${jobId}?location=${encodeURIComponent(location ?? "")}&maxResults=1000&timeoutMs=10000`,
        { headers: { Authorization: `Bearer ${tok}` } },
      );
      if (!r.ok) throw new Error(`BigQuery poll error ${r.status}: ${await r.text()}`);
      data = await r.json() as Record<string, unknown>;
      if (data["jobComplete"]) break;
    }

    // Parse schema + rows
    const schemaFields = ((data["schema"] as Record<string, unknown> | undefined)?.["fields"] as Array<Record<string, unknown>> | undefined) ?? [];
    const columns = schemaFields.map((f) => String(f["name"]));
    const rawRows = (data["rows"] as Array<{ f: Array<{ v: unknown }> }> | undefined) ?? [];
    const rows = rawRows.map((r) => {
      const obj: Record<string, unknown> = {};
      r.f.forEach((cell, i) => { obj[columns[i] ?? String(i)] = cell.v; });
      return obj;
    });

    return { rows, durationMs: Date.now() - start };
  }

  async introspectResource(resourceId: string, _accountId: string): Promise<SqlTableMeta[]> {
    const externalId = resourceId.split(":").slice(2).join(":");
    const colonIdx = externalId.indexOf(":");
    const project = externalId.slice(0, colonIdx);
    const datasetId = externalId.slice(colonIdx + 1);

    const data = await this.get<{ tables?: Array<Record<string, unknown>> }>(
      `https://bigquery.googleapis.com/bigquery/v2/projects/${project}/datasets/${datasetId}/tables?maxResults=200`,
    );

    const tableItems = data.tables ?? [];
    const metas = await Promise.all(
      tableItems.slice(0, 100).map(async (t): Promise<SqlTableMeta> => {
        const ref = t["tableReference"] as Record<string, string> | undefined;
        const tableId = ref?.["tableId"] ?? "";
        try {
          const td = await this.get<{ schema?: { fields: Array<Record<string, unknown>> } }>(
            `https://bigquery.googleapis.com/bigquery/v2/projects/${project}/datasets/${datasetId}/tables/${tableId}`,
          );
          return {
            name: tableId,
            columns: (td.schema?.fields ?? []).map((f) => ({ name: String(f["name"]), type: String(f["type"]) })),
            pkColumns: [],
          };
        } catch {
          return { name: tableId, columns: [], pkColumns: [] };
        }
      }),
    );

    return metas;
  }

  async getStorageAccessToken(): Promise<string> {
    return this.token();
  }

  async uploadStorageObject(
    bucket: string,
    key: string,
    file: File,
    onProgress?: (pct: number) => void,
  ): Promise<void> {
    const tok = await this.token();
    const url = `https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(bucket)}/o?uploadType=media&name=${encodeURIComponent(key)}`;
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", url);
      xhr.setRequestHeader("Authorization", `Bearer ${tok}`);
      xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");
      if (onProgress) {
        xhr.upload.addEventListener("progress", (e) => {
          if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
        });
      }
      xhr.addEventListener("load", () => {
        if (xhr.status >= 200 && xhr.status < 300) resolve();
        else reject(new Error(`Upload failed: ${xhr.status} ${xhr.responseText.slice(0, 200)}`));
      });
      xhr.addEventListener("error", () => reject(new Error("Upload network error")));
      xhr.send(file);
    });
  }

  async deleteStorageObject(bucket: string, key: string): Promise<void> {
    const tok = await this.token();

    if (key.endsWith("/")) {
      // Folder — list all objects with this prefix (flat, no delimiter) and delete each
      const allKeys: string[] = [];
      let pageToken: string | undefined;
      do {
        const url = new URL(
          `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o`,
        );
        url.searchParams.set("prefix", key);
        url.searchParams.set("maxResults", "1000");
        if (pageToken) url.searchParams.set("pageToken", pageToken);
        const page = await this.get<{ items?: Array<{ name: string }>; nextPageToken?: string }>(
          url.toString(),
        );
        for (const item of page.items ?? []) allKeys.push(item.name);
        pageToken = page.nextPageToken;
      } while (pageToken);

      await Promise.all(
        allKeys.map((k) =>
          fetch(
            `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(k)}`,
            { method: "DELETE", headers: { Authorization: `Bearer ${tok}` } },
          ),
        ),
      );
      return;
    }

    const res = await fetch(
      `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(key)}`,
      { method: "DELETE", headers: { Authorization: `Bearer ${tok}` } },
    );
    if (!res.ok && res.status !== 404) {
      throw new Error(`Delete failed: ${res.status}`);
    }
  }

  async makeStorageFolder(bucket: string, key: string): Promise<void> {
    const tok = await this.token();
    const folderKey = key.endsWith("/") ? key : `${key}/`;
    const url = `https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(bucket)}/o?uploadType=media&name=${encodeURIComponent(folderKey)}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/x-www-form-urlencoded" },
    });
    if (!res.ok) throw new Error(`Make folder failed: ${res.status}`);
  }

  async listStorageObjects(bucket: string, prefix: string): Promise<StorageObject[]> {
    const url = new URL(`https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o`);
    url.searchParams.set("delimiter", "/");
    url.searchParams.set("maxResults", "1000");
    if (prefix) url.searchParams.set("prefix", prefix);

    const results: StorageObject[] = [];
    let pageToken: string | undefined;

    do {
      if (pageToken) url.searchParams.set("pageToken", pageToken);
      const page = await this.get<{
        items?: Array<{ name: string; size: string; updated: string; contentType?: string }>;
        prefixes?: string[];
        nextPageToken?: string;
      }>(url.toString());

      // Directories (common prefixes)
      for (const p of page.prefixes ?? []) {
        const name = p.slice(prefix.length).replace(/\/$/, "");
        results.push({ key: p, name, size: 0, lastModified: "", isDirectory: true });
      }

      // Objects
      for (const obj of page.items ?? []) {
        if (obj.name === prefix) continue; // skip the "folder" placeholder object
        const name = obj.name.slice(prefix.length);
        results.push({
          key: obj.name,
          name,
          size: Number(obj.size ?? 0),
          lastModified: obj.updated ?? "",
          isDirectory: false,
          ...(obj.contentType ? { contentType: obj.contentType } : {}),
        });
      }

      pageToken = page.nextPageToken;
    } while (pageToken);

    return results;
  }

  async fetchStorageStats(bucketName: string): Promise<{ count: number; size: string }> {
    const url = new URL(`https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucketName)}/o`);
    url.searchParams.set("maxResults", "1000");
    url.searchParams.set("fields", "nextPageToken,items/size");

    let count = 0;
    let totalBytes = 0;
    let pageToken: string | undefined;

    do {
      if (pageToken) url.searchParams.set("pageToken", pageToken);
      const page = await this.get<{ items?: Array<{ size?: string }>; nextPageToken?: string }>(url.toString());
      for (const item of page.items ?? []) {
        count++;
        totalBytes += Number(item.size ?? 0);
      }
      pageToken = page.nextPageToken;
    } while (pageToken);

    return { count, size: formatBytes(totalBytes) };
  }

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    const statusVal = String(resource.fields["status"] ?? resource.fields["state"] ?? "");
    return {
      id: resource.id,
      label: resource.displayName,
      status: { kind: "status-dot", status: gcpStatus(statusVal) },
    };
  }

  // ─── Private list helpers ─────────────────────────────────────────────────

  private id(accountId: string, typeId: string, externalId: string): string {
    return `${accountId}:${typeId}:${externalId}`;
  }

  private now(): string {
    return new Date().toISOString();
  }

}
