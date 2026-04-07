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
import { fetchAccessToken, type ServiceAccountKey } from "./auth.js";

// ─── Token cache ─────────────────────────────────────────────────────────────

interface TokenCache {
  token: string;
  expiresAt: number; // ms
}

interface CloudBillingSku {
  description?: string;
  serviceRegions?: string[];
  category?: {
    resourceFamily?: string;
    usageType?: string;
  };
  pricingInfo?: Array<{
    pricingExpression?: {
      tieredRates?: Array<{
        unitPrice?: {
          units?: string;
          nanos?: number;
        };
      }>;
    };
  }>;
}

// ─── GCP status → UI status ──────────────────────────────────────────────────

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1_073_741_824) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  return `${(bytes / 1_073_741_824).toFixed(2)} GB`;
}

function gcpStatus(
  s: string | undefined,
): "healthy" | "degraded" | "error" | "unknown" | "provisioning" {
  switch ((s ?? "").toUpperCase()) {
    case "RUNNING":
    case "ACTIVE":
    case "READY":
    case "SERVING":
    case "DEPLOYED":
    case "SUCCEEDED":
      return "healthy";
    case "SUSPENDED":
    case "MAINTENANCE":
    case "FAILED_TO_START":
    case "DEGRADED":
      return "degraded";
    case "FAILED":
    case "STOPPING":
    case "TERMINATED":
    case "DELETED":
      return "error";
    case "CREATING":
    case "UPDATING":
    case "DEPLOYING":
    case "PROVISIONING":
    case "PENDING":
    case "STAGING":
      return "provisioning";
    default:
      return "unknown";
  }
}

// ─── Client ──────────────────────────────────────────────────────────────────

export class GcpClient implements PluginClient {
  private readonly key: ServiceAccountKey;
  private readonly project: string;
  private tokenCache: TokenCache | null = null;
  private machineTypeFamilyRateCache = new Map<
    string,
    {
      expiresAt: number;
      machineRates: Record<string, { corePerHourUsd: number; ramPerGiBHourUsd: number }>;
      pdBalancedGbMonthUsd: number | null;
    }
  >();
  private pricingRatesInFlightByGeo = new Map<
    string,
    Promise<{
      machineRates: Record<string, { corePerHourUsd: number; ramPerGiBHourUsd: number }>;
      pdBalancedGbMonthUsd: number | null;
    }>
  >();

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

  async listResources(typeId: string, accountId: string): Promise<ResourceInstance[]> {
    const p = this.project;
    switch (typeId) {
      case "gce-instance":       return this.listGceInstances(accountId, p);
      case "gce-disk":           return this.listGceDisks(accountId, p);
      case "gke-cluster":        return this.listGkeClusters(accountId, p);
      case "cloudsql-instance":  return this.listCloudSqlInstances(accountId, p);
      case "spanner-instance":   return this.listSpannerInstances(accountId, p);
      case "bigtable-instance":  return this.listBigtableInstances(accountId, p);
      case "firestore-database": return this.listFirestoreDatabases(accountId, p);
      case "memorystore-redis":  return this.listMemorystoreRedis(accountId, p);
      case "alloydb-cluster":    return this.listAlloyDbClusters(accountId, p);
      case "gcs-bucket":         return this.listGcsBuckets(accountId, p);
      case "pubsub-topic":       return this.listPubSubTopics(accountId, p);
      case "pubsub-subscription":return this.listPubSubSubscriptions(accountId, p);
      case "cloud-run-service":  return this.listCloudRunServices(accountId, p);
      case "cloud-function":     return this.listCloudFunctions(accountId, p);
      case "vpc-network":        return this.listVpcNetworks(accountId, p);
      case "bigquery-dataset":   return this.listBigQueryDatasets(accountId, p);
      case "artifact-registry-repo": return this.listArtifactRegistryRepos(accountId, p);
      case "gcp-service-account":return this.listServiceAccounts(accountId, p);
      case "cloud-armor-policy": return this.listCloudArmorPolicies(accountId, p);
      case "secret-manager-secret": return this.listSecretManagerSecrets(accountId, p);
      case "dataflow-job":       return this.listDataflowJobs(accountId, p);
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

  private static readonly COMPUTE_BILLING_SERVICE_ID = "6F81-5844-456A";
  private static readonly HOURS_PER_MONTH = 730;

  private regionFromZone(zone: string): string {
    return zone.replace(/-[a-z]$/, "");
  }

  private geoFromRegion(region: string): "Americas" | "EMEA" | "APAC" {
    if (
      region.startsWith("us-") ||
      region.startsWith("northamerica-") ||
      region.startsWith("southamerica-")
    ) return "Americas";
    if (region.startsWith("asia-") || region.startsWith("australia-")) return "APAC";
    return "EMEA";
  }

  private unitPriceToUsd(unitPrice?: { units?: string; nanos?: number }): number {
    if (!unitPrice) return 0;
    const units = Number(unitPrice.units ?? "0");
    const nanos = Number(unitPrice.nanos ?? 0);
    return units + nanos / 1_000_000_000;
  }

  private familyFromMachineType(machineType: string): string {
    const lowered = machineType.toLowerCase();
    if (lowered.startsWith("n2d-")) return "n2d";
    const [family = ""] = lowered.split("-");
    return family;
  }

  private async getCreatePricingRatesForGeo(
    geo: "Americas" | "EMEA" | "APAC",
  ): Promise<{
    machineRates: Record<string, { corePerHourUsd: number; ramPerGiBHourUsd: number }>;
    pdBalancedGbMonthUsd: number | null;
  }> {
    const cached = this.machineTypeFamilyRateCache.get(geo);
    if (cached && cached.expiresAt > Date.now()) return {
      machineRates: cached.machineRates,
      pdBalancedGbMonthUsd: cached.pdBalancedGbMonthUsd,
    };
    const inFlight = this.pricingRatesInFlightByGeo.get(geo);
    if (inFlight) return inFlight;

    const fetchPromise = (async () => {
      let pageToken = "";
      const allSkus: CloudBillingSku[] = [];
      do {
        const params = new URLSearchParams({
          currencyCode: "USD",
          pageSize: "5000",
        });
        if (pageToken) params.set("pageToken", pageToken);
        const page = await this.get<{ skus?: CloudBillingSku[]; nextPageToken?: string }>(
          `https://cloudbilling.googleapis.com/v1/services/${GcpClient.COMPUTE_BILLING_SERVICE_ID}/skus?${params.toString()}`,
        );
        allSkus.push(...(page.skus ?? []));
        pageToken = page.nextPageToken ?? "";
      } while (pageToken);

      const machineRates: Record<string, { corePerHourUsd: number; ramPerGiBHourUsd: number }> = {};
      let pdBalancedGbMonthUsd: number | null = null;
      for (const sku of allSkus) {
        const family = sku.category?.resourceFamily;
        const usageType = sku.category?.usageType;
        const description = sku.description ?? "";
        if (usageType !== "OnDemand") continue;

        // Disk SKUs use serviceRegions instead of geo in description
        if (
          pdBalancedGbMonthUsd == null &&
          family === "Storage" &&
          description.includes("Balanced PD Capacity") &&
          !description.includes("Regional")
        ) {
          const regions = sku.serviceRegions ?? [];
          const geoRegionPrefixes: Record<string, string[]> = {
            Americas: ["us-", "northamerica-", "southamerica-"],
            EMEA: ["europe-", "me-", "africa-"],
            APAC: ["asia-", "australia-"],
          };
          const prefixes = geoRegionPrefixes[geo] ?? [];
          const matchesGeo = regions.some((r) => prefixes.some((p) => r.startsWith(p)));
          if (matchesGeo) {
            const pdRate = this.unitPriceToUsd(
              sku.pricingInfo?.[0]?.pricingExpression?.tieredRates?.[0]?.unitPrice,
            );
            if (pdRate > 0) pdBalancedGbMonthUsd = pdRate;
          }
        }

        const inTargetGeo =
          description.includes(`running in ${geo}`) ||
          description.includes(`in ${geo}`);
        if (!inTargetGeo) continue;

        if (family !== "Compute") continue;

        const isCoreSku = description.includes("Instance Core");
        const isRamSku = description.includes("Instance Ram");
        if (!isCoreSku && !isRamSku) continue;

        const familyMatch = description.match(/^([A-Z0-9]+)\b/);
        const machineFamily = familyMatch?.[1]?.toLowerCase();
        if (!machineFamily) continue;

        const hourly = this.unitPriceToUsd(
          sku.pricingInfo?.[0]?.pricingExpression?.tieredRates?.[0]?.unitPrice,
        );
        if (!hourly) continue;

        if (!machineRates[machineFamily]) {
          machineRates[machineFamily] = { corePerHourUsd: 0, ramPerGiBHourUsd: 0 };
        }
        if (isCoreSku) machineRates[machineFamily]!.corePerHourUsd = hourly;
        if (isRamSku) machineRates[machineFamily]!.ramPerGiBHourUsd = hourly;
      }

      this.machineTypeFamilyRateCache.set(geo, {
        machineRates,
        pdBalancedGbMonthUsd,
        expiresAt: Date.now() + 6 * 60 * 60 * 1000,
      });
      return { machineRates, pdBalancedGbMonthUsd };
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
    const region = this.regionFromZone(zone);
    const geo = this.geoFromRegion(region);
    const pricingRates = await this.getCreatePricingRatesForGeo(geo);
    const ratesByFamily = pricingRates.machineRates;
    const estimated: Record<string, number> = {};

    for (const m of machineTypes) {
      const family = this.familyFromMachineType(m.id);
      const rates = ratesByFamily[family];
      if (!rates) continue;
      const memoryGiB = m.memoryMb / 1024;
      const hourly = (m.vcpus * rates.corePerHourUsd) + (memoryGiB * rates.ramPerGiBHourUsd);
      if (!hourly) continue;
      estimated[m.id] = Number((hourly * GcpClient.HOURS_PER_MONTH).toFixed(2));
    }
    return estimated;
  }

  private async getBalancedDiskMonthlyRate(zone: string): Promise<number | null> {
    const region = this.regionFromZone(zone);
    const geo = this.geoFromRegion(region);
    const pricingRates = await this.getCreatePricingRatesForGeo(geo);
    return pricingRates.pdBalancedGbMonthUsd;
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
    if (typeId !== "gce-instance") return {};
    const zone = request.regionId ?? "us-central1-a";
    return this.estimateMachineTypeMonthlyPrices(request.sizes, zone);
  }

  async getCreateCostEstimate(typeId: string, fields: Record<string, string>): Promise<number | null> {
    if (typeId !== "gce-instance") return null;
    const zone = fields["zone"] ?? "us-central1-a";
    const machineType = fields["machineType"] ?? "";
    if (!machineType) return null;

    const machineTypeData = await this.get<{ guestCpus: number; memoryMb: number }>(
      `https://compute.googleapis.com/compute/v1/projects/${this.project}/zones/${zone}/machineTypes/${machineType}`,
    ).catch(() => null);
    if (!machineTypeData) return null;

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
        id: `${accountId}:gce-instance:${name}`,
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

  private async listGceInstances(accountId: string, p: string): Promise<ResourceInstance[]> {
    const data = await this.get<{ items?: Record<string, { instances?: unknown[] }> }>(
      `https://compute.googleapis.com/compute/v1/projects/${p}/aggregated/instances`,
    );
    const results: ResourceInstance[] = [];
    for (const zone of Object.values(data.items ?? {})) {
      for (const inst of (zone.instances ?? []) as Record<string, unknown>[]) {
        const name = String(inst["name"]);
        const zone_ = String(inst["zone"]).split("/").pop() ?? "";
        const machineType = String(inst["machineType"]).split("/").pop() ?? "";
        const status = String(inst["status"] ?? "");
        const nets = inst["networkInterfaces"] as Array<Record<string, unknown>> | undefined;
        const externalIp =
          ((nets?.[0]?.["accessConfigs"] as Array<Record<string, unknown>> | undefined)?.[0]?.["natIP"] as string) ?? "";
        const internalIp = (nets?.[0]?.["networkIP"] as string) ?? "";
        results.push({
          id: this.id(accountId, "gce-instance", `${p}/${zone_}/${name}`),
          pluginId: "gcp",
          resourceTypeId: "gce-instance",
          accountId,
          displayName: name,
          fields: { name, zone: zone_, machineType, status },
          resolvedOutputs: { externalIp, internalIp },
          secretStates: [],
          externalId: `${p}/${zone_}/${name}`,
          createdAt: String(inst["creationTimestamp"] ?? this.now()),
          updatedAt: this.now(),
        });
      }
    }
    return results;
  }

  private async listGceDisks(accountId: string, p: string): Promise<ResourceInstance[]> {
    const data = await this.get<{ items?: Record<string, { disks?: unknown[] }> }>(
      `https://compute.googleapis.com/compute/v1/projects/${p}/aggregated/disks`,
    );
    const results: ResourceInstance[] = [];
    for (const zone of Object.values(data.items ?? {})) {
      for (const disk of (zone.disks ?? []) as Record<string, unknown>[]) {
        const name = String(disk["name"]);
        const zone_ = String(disk["zone"]).split("/").pop() ?? "";
        const type = String(disk["type"]).split("/").pop() ?? "";
        results.push({
          id: this.id(accountId, "gce-disk", `${p}/${zone_}/${name}`),
          pluginId: "gcp",
          resourceTypeId: "gce-disk",
          accountId,
          displayName: name,
          fields: {
            name,
            zone: zone_,
            sizeGb: Number(disk["sizeGb"] ?? 0),
            type,
            status: String(disk["status"] ?? ""),
          },
          resolvedOutputs: {},
          secretStates: [],
          externalId: `${p}/${zone_}/${name}`,
          createdAt: String(disk["creationTimestamp"] ?? this.now()),
          updatedAt: this.now(),
        });
      }
    }
    return results;
  }

  private async listGkeClusters(accountId: string, p: string): Promise<ResourceInstance[]> {
    const data = await this.get<{ clusters?: Record<string, unknown>[] }>(
      `https://container.googleapis.com/v1/projects/${p}/locations/-/clusters`,
    );
    return (data.clusters ?? []).map((c) => {
      const name = String(c["name"]);
      const location = String(c["location"] ?? "");
      const nodePool = (c["nodePools"] as Array<Record<string, unknown>> | undefined)?.[0];
      const nodeConfig = (nodePool?.["config"] as Record<string, unknown> | undefined) ?? {};
      const nodeCount = Number(
        (nodePool?.["initialNodeCount"] as number | undefined) ?? 0,
      );
      return {
        id: this.id(accountId, "gke-cluster", `${p}/${location}/${name}`),
        pluginId: "gcp",
        resourceTypeId: "gke-cluster",
        accountId,
        displayName: name,
        fields: {
          name,
          location,
          version: String(c["currentMasterVersion"] ?? ""),
          machineType: String(nodeConfig["machineType"] ?? ""),
          diskSizeGb: Number(nodeConfig["diskSizeGb"] ?? 0),
          nodeCount,
          status: String(c["status"] ?? ""),
        },
        resolvedOutputs: {
          clusterEndpoint: String(c["endpoint"] ?? ""),
        },
        secretStates: [],
        externalId: name,
        createdAt: String(c["createTime"] ?? this.now()),
        updatedAt: String(c["updateTime"] ?? this.now()),
      };
    });
  }

  private async listCloudSqlInstances(accountId: string, p: string): Promise<ResourceInstance[]> {
    const items = await this.paginate<Record<string, unknown>>(
      `https://sqladmin.googleapis.com/v1/projects/${p}/instances`,
      "items",
    );
    return items.map((db) => {
      const ip = (db["ipAddresses"] as Array<Record<string, unknown>> | undefined)?.find(
        (a) => a["type"] === "PRIMARY",
      );
      return {
        id: this.id(accountId, "cloudsql-instance", String(db["name"])),
        pluginId: "gcp",
        resourceTypeId: "cloudsql-instance",
        accountId,
        displayName: String(db["name"]),
        fields: {
          name: String(db["name"]),
          databaseVersion: String(db["databaseVersion"] ?? ""),
          region: String(db["region"] ?? ""),
          tier: String(
            (db["settings"] as Record<string, unknown> | undefined)?.["tier"] ?? "",
          ),
          state: String(db["state"] ?? ""),
          availabilityType: String(
            (db["settings"] as Record<string, unknown> | undefined)?.["availabilityType"] ?? "",
          ),
        },
        resolvedOutputs: {
          connectionName: String(db["connectionName"] ?? ""),
          ipAddress: String(ip?.["ipAddress"] ?? ""),
        },
        secretStates: [],
        externalId: String(db["name"]),
        createdAt: this.now(),
        updatedAt: this.now(),
      };
    });
  }

  private async listSpannerInstances(accountId: string, p: string): Promise<ResourceInstance[]> {
    const items = await this.paginate<Record<string, unknown>>(
      `https://spanner.googleapis.com/v1/projects/${p}/instances`,
      "instances",
    );
    return items.map((inst) => {
      const name = String(inst["name"]).split("/").pop() ?? "";
      return {
        id: this.id(accountId, "spanner-instance", name),
        pluginId: "gcp",
        resourceTypeId: "spanner-instance",
        accountId,
        displayName: String(inst["displayName"] ?? name),
        fields: {
          name,
          displayName: String(inst["displayName"] ?? ""),
          config: String(inst["config"] ?? "").split("/").pop() ?? "",
          nodeCount: Number(inst["nodeCount"] ?? 0),
          processingUnits: Number(inst["processingUnits"] ?? 0),
          state: String(inst["state"] ?? ""),
        },
        resolvedOutputs: {},
        secretStates: [],
        externalId: name,
        createdAt: this.now(),
        updatedAt: this.now(),
      };
    });
  }

  private async listBigtableInstances(accountId: string, p: string): Promise<ResourceInstance[]> {
    const data = await this.get<{ instances?: Record<string, unknown>[] }>(
      `https://bigtableadmin.googleapis.com/v2/projects/${p}/instances`,
    );
    return (data.instances ?? []).map((inst) => {
      const name = String(inst["name"]).split("/").pop() ?? "";
      return {
        id: this.id(accountId, "bigtable-instance", name),
        pluginId: "gcp",
        resourceTypeId: "bigtable-instance",
        accountId,
        displayName: String(inst["displayName"] ?? name),
        fields: {
          name,
          displayName: String(inst["displayName"] ?? ""),
          type: String(inst["type"] ?? ""),
          state: String(inst["state"] ?? ""),
        },
        resolvedOutputs: {},
        secretStates: [],
        externalId: name,
        createdAt: this.now(),
        updatedAt: this.now(),
      };
    });
  }

  private async listFirestoreDatabases(accountId: string, p: string): Promise<ResourceInstance[]> {
    const data = await this.get<{ databases?: Record<string, unknown>[] }>(
      `https://firestore.googleapis.com/v1/projects/${p}/databases`,
    );
    return (data.databases ?? []).map((db) => {
      const name = String(db["name"]).split("/").pop() ?? "";
      return {
        id: this.id(accountId, "firestore-database", `${p}/${name}`),
        pluginId: "gcp",
        resourceTypeId: "firestore-database",
        accountId,
        displayName: name === "(default)" ? `${p} (default)` : name,
        fields: {
          name,
          locationId: String(db["locationId"] ?? ""),
          type: String(db["type"] ?? ""),
          concurrencyMode: String(db["concurrencyMode"] ?? ""),
          state: String(db["state"] ?? ""),
        },
        resolvedOutputs: {},
        secretStates: [],
        externalId: name,
        createdAt: String(db["createTime"] ?? this.now()),
        updatedAt: String(db["updateTime"] ?? this.now()),
      };
    });
  }

  private async listMemorystoreRedis(accountId: string, p: string): Promise<ResourceInstance[]> {
    const items = await this.paginate<Record<string, unknown>>(
      `https://redis.googleapis.com/v1/projects/${p}/locations/-/instances`,
      "instances",
    );
    return items.map((inst) => {
      const fullName = String(inst["name"]);
      const name = fullName.split("/").pop() ?? "";
      const region = fullName.split("/")[3] ?? "";
      return {
        id: this.id(accountId, "memorystore-redis", fullName),
        pluginId: "gcp",
        resourceTypeId: "memorystore-redis",
        accountId,
        displayName: name,
        fields: {
          name,
          region,
          tier: String(inst["tier"] ?? ""),
          memorySizeGb: Number(inst["memorySizeGb"] ?? 0),
          redisVersion: String(inst["redisVersion"] ?? ""),
          state: String(inst["state"] ?? ""),
        },
        resolvedOutputs: {
          host: String(inst["host"] ?? ""),
          port: String(inst["port"] ?? "6379"),
        },
        secretStates: [],
        externalId: fullName,
        createdAt: String(inst["createTime"] ?? this.now()),
        updatedAt: this.now(),
      };
    });
  }

  private async listAlloyDbClusters(accountId: string, p: string): Promise<ResourceInstance[]> {
    const items = await this.paginate<Record<string, unknown>>(
      `https://alloydb.googleapis.com/v1/projects/${p}/locations/-/clusters`,
      "clusters",
    );
    return items.map((c) => {
      const fullName = String(c["name"]);
      const name = fullName.split("/").pop() ?? "";
      const location = fullName.split("/")[3] ?? "";
      const primary = c["primaryConfig"] as Record<string, unknown> | undefined;
      const endpoint = String(
        (primary?.["nodes"] as Array<Record<string, unknown>> | undefined)?.[0]?.["ipAddress"] ?? "",
      );
      return {
        id: this.id(accountId, "alloydb-cluster", fullName),
        pluginId: "gcp",
        resourceTypeId: "alloydb-cluster",
        accountId,
        displayName: String(c["displayName"] ?? name),
        fields: {
          name,
          location,
          databaseVersion: String(c["databaseVersion"] ?? ""),
          state: String(c["state"] ?? ""),
          clusterType: String(c["clusterType"] ?? ""),
        },
        resolvedOutputs: { primaryEndpoint: endpoint },
        secretStates: [],
        externalId: fullName,
        createdAt: String(c["createTime"] ?? this.now()),
        updatedAt: String(c["updateTime"] ?? this.now()),
      };
    });
  }

  private async listGcsBuckets(accountId: string, p: string): Promise<ResourceInstance[]> {
    const items = await this.paginate<Record<string, unknown>>(
      `https://storage.googleapis.com/storage/v1/b`,
      "items",
      { project: p },
    );
    return items.map((b) => {
      const name = String(b["name"]);
      const versioning = !!(b["versioning"] as Record<string, unknown> | undefined)?.["enabled"];
      return {
        id: this.id(accountId, "gcs-bucket", name),
        pluginId: "gcp",
        resourceTypeId: "gcs-bucket",
        accountId,
        displayName: name,
        fields: {
          name,
          location: String(b["location"] ?? ""),
          storageClass: String(b["storageClass"] ?? ""),
          publicAccessPrevention: String(
            (b["iamConfiguration"] as Record<string, unknown> | undefined)?.["publicAccessPrevention"] ?? "",
          ),
          versioning,
        },
        resolvedOutputs: { endpoint: `https://storage.googleapis.com/${name}` },
        secretStates: [],
        externalId: name,
        createdAt: String(b["timeCreated"] ?? this.now()),
        updatedAt: String(b["updated"] ?? this.now()),
      };
    });
  }

  private async listPubSubTopics(accountId: string, p: string): Promise<ResourceInstance[]> {
    const items = await this.paginate<Record<string, unknown>>(
      `https://pubsub.googleapis.com/v1/projects/${p}/topics`,
      "topics",
    );
    return items.map((t) => {
      const fullName = String(t["name"]);
      const name = fullName.split("/").pop() ?? "";
      return {
        id: this.id(accountId, "pubsub-topic", fullName),
        pluginId: "gcp",
        resourceTypeId: "pubsub-topic",
        accountId,
        displayName: name,
        fields: {
          name,
          kmsKeyName: String(t["kmsKeyName"] ?? ""),
          messageRetentionDuration: String(t["messageRetentionDuration"] ?? ""),
        },
        resolvedOutputs: {},
        secretStates: [],
        externalId: fullName,
        createdAt: this.now(),
        updatedAt: this.now(),
      };
    });
  }

  private async listPubSubSubscriptions(accountId: string, p: string): Promise<ResourceInstance[]> {
    const items = await this.paginate<Record<string, unknown>>(
      `https://pubsub.googleapis.com/v1/projects/${p}/subscriptions`,
      "subscriptions",
    );
    return items.map((s) => {
      const fullName = String(s["name"]);
      const name = fullName.split("/").pop() ?? "";
      const topicFull = String(s["topic"] ?? "");
      const topic = topicFull.split("/").pop() ?? topicFull;
      return {
        id: this.id(accountId, "pubsub-subscription", fullName),
        pluginId: "gcp",
        resourceTypeId: "pubsub-subscription",
        accountId,
        displayName: name,
        fields: {
          name,
          topic,
          ackDeadlineSeconds: Number(s["ackDeadlineSeconds"] ?? 10),
          messageRetentionDuration: String(s["messageRetentionDuration"] ?? ""),
          filter: String(s["filter"] ?? ""),
        },
        resolvedOutputs: {},
        secretStates: [],
        externalId: fullName,
        createdAt: this.now(),
        updatedAt: this.now(),
      };
    });
  }

  private async listCloudRunServices(accountId: string, p: string): Promise<ResourceInstance[]> {
    const items = await this.paginate<Record<string, unknown>>(
      `https://run.googleapis.com/v2/projects/${p}/locations/-/services`,
      "services",
    );
    return items.map((svc) => {
      const fullName = String(svc["name"]);
      const name = fullName.split("/").pop() ?? "";
      const region = fullName.split("/")[3] ?? "";
      const cond = (svc["conditions"] as Array<Record<string, unknown>> | undefined)?.find(
        (c) => c["type"] === "Ready",
      );
      const state = cond ? String(cond["state"] ?? "") : "UNKNOWN";
      return {
        id: this.id(accountId, "cloud-run-service", fullName),
        pluginId: "gcp",
        resourceTypeId: "cloud-run-service",
        accountId,
        displayName: name,
        fields: {
          name,
          region,
          latestRevision: String(svc["latestReadyRevision"] ?? "").split("/").pop() ?? "",
          state,
          ingress: String(svc["ingress"] ?? ""),
        },
        resolvedOutputs: { url: String(svc["uri"] ?? "") },
        secretStates: [],
        externalId: fullName,
        createdAt: String(svc["createTime"] ?? this.now()),
        updatedAt: String(svc["updateTime"] ?? this.now()),
      };
    });
  }

  private async listCloudFunctions(accountId: string, p: string): Promise<ResourceInstance[]> {
    const items = await this.paginate<Record<string, unknown>>(
      `https://cloudfunctions.googleapis.com/v2/projects/${p}/locations/-/functions`,
      "functions",
    );
    return items.map((fn) => {
      const fullName = String(fn["name"]);
      const name = fullName.split("/").pop() ?? "";
      const region = fullName.split("/")[3] ?? "";
      const serviceConfig = fn["serviceConfig"] as Record<string, unknown> | undefined;
      const buildConfig = fn["buildConfig"] as Record<string, unknown> | undefined;
      return {
        id: this.id(accountId, "cloud-function", fullName),
        pluginId: "gcp",
        resourceTypeId: "cloud-function",
        accountId,
        displayName: name,
        fields: {
          name,
          region,
          runtime: String(buildConfig?.["runtime"] ?? ""),
          state: String(fn["state"] ?? ""),
          availableMemory: String(serviceConfig?.["availableMemory"] ?? ""),
          timeout: String(serviceConfig?.["timeoutSeconds"] ?? ""),
        },
        resolvedOutputs: {
          url: String(serviceConfig?.["uri"] ?? ""),
        },
        secretStates: [],
        externalId: fullName,
        createdAt: String(fn["createTime"] ?? this.now()),
        updatedAt: String(fn["updateTime"] ?? this.now()),
      };
    });
  }

  private async listVpcNetworks(accountId: string, p: string): Promise<ResourceInstance[]> {
    const items = await this.paginate<Record<string, unknown>>(
      `https://compute.googleapis.com/compute/v1/projects/${p}/global/networks`,
      "items",
    );
    return items.map((net) => {
      const name = String(net["name"]);
      const subnetCount = (net["subnetworks"] as unknown[] | undefined)?.length ?? 0;
      return {
        id: this.id(accountId, "vpc-network", `${p}/${name}`),
        pluginId: "gcp",
        resourceTypeId: "vpc-network",
        accountId,
        displayName: name,
        fields: {
          name,
          description: String(net["description"] ?? ""),
          autoCreateSubnetworks: Boolean(net["autoCreateSubnetworks"]),
          mtu: Number(net["mtu"] ?? 1460),
          subnetCount,
        },
        resolvedOutputs: {},
        secretStates: [],
        externalId: `${p}/${name}`,
        createdAt: String(net["creationTimestamp"] ?? this.now()),
        updatedAt: this.now(),
      };
    });
  }

  private async listBigQueryDatasets(accountId: string, p: string): Promise<ResourceInstance[]> {
    const items = await this.paginate<Record<string, unknown>>(
      `https://bigquery.googleapis.com/bigquery/v2/projects/${p}/datasets`,
      "datasets",
    );
    return items.map((ds) => {
      const ref = ds["datasetReference"] as Record<string, string> | undefined;
      const datasetId = ref?.["datasetId"] ?? String(ds["id"]).split(":").pop() ?? "";
      const meta = ds["friendlyName"] as string | undefined;
      return {
        id: this.id(accountId, "bigquery-dataset", `${p}:${datasetId}`),
        pluginId: "gcp",
        resourceTypeId: "bigquery-dataset",
        accountId,
        displayName: meta ?? datasetId,
        fields: {
          name: datasetId,
          location: String(ds["location"] ?? ""),
          description: String(ds["description"] ?? ""),
        },
        resolvedOutputs: {},
        secretStates: [],
        externalId: `${p}:${datasetId}`,
        createdAt: this.now(),
        updatedAt: this.now(),
      };
    });
  }

  private async listArtifactRegistryRepos(accountId: string, p: string): Promise<ResourceInstance[]> {
    const items = await this.paginate<Record<string, unknown>>(
      `https://artifactregistry.googleapis.com/v1/projects/${p}/locations/-/repositories`,
      "repositories",
    );
    return items.map((repo) => {
      const fullName = String(repo["name"]);
      const name = fullName.split("/").pop() ?? "";
      const location = fullName.split("/")[3] ?? "";
      const sizeBytes = Number(repo["sizeBytes"] ?? 0);
      const sizeLabel =
        sizeBytes > 1_073_741_824
          ? `${(sizeBytes / 1_073_741_824).toFixed(1)} GB`
          : sizeBytes > 1_048_576
          ? `${(sizeBytes / 1_048_576).toFixed(1)} MB`
          : `${Math.round(sizeBytes / 1024)} KB`;
      return {
        id: this.id(accountId, "artifact-registry-repo", fullName),
        pluginId: "gcp",
        resourceTypeId: "artifact-registry-repo",
        accountId,
        displayName: name,
        fields: {
          name,
          location,
          format: String(repo["format"] ?? ""),
          description: String(repo["description"] ?? ""),
          sizeBytes: sizeLabel,
        },
        resolvedOutputs: {},
        secretStates: [],
        externalId: fullName,
        createdAt: String(repo["createTime"] ?? this.now()),
        updatedAt: String(repo["updateTime"] ?? this.now()),
      };
    });
  }

  private async listServiceAccounts(accountId: string, p: string): Promise<ResourceInstance[]> {
    const items = await this.paginate<Record<string, unknown>>(
      `https://iam.googleapis.com/v1/projects/${p}/serviceAccounts`,
      "accounts",
    );
    return items.map((sa) => {
      const email = String(sa["email"]);
      return {
        id: this.id(accountId, "gcp-service-account", email),
        pluginId: "gcp",
        resourceTypeId: "gcp-service-account",
        accountId,
        displayName: String(sa["displayName"] ?? email.split("@")[0] ?? email),
        fields: {
          name: String(sa["name"]).split("/").pop() ?? "",
          email,
          displayName: String(sa["displayName"] ?? ""),
          disabled: Boolean(sa["disabled"]),
          description: String(sa["description"] ?? ""),
        },
        resolvedOutputs: {},
        secretStates: [],
        externalId: email,
        createdAt: this.now(),
        updatedAt: this.now(),
      };
    });
  }

  private async listCloudArmorPolicies(accountId: string, p: string): Promise<ResourceInstance[]> {
    const items = await this.paginate<Record<string, unknown>>(
      `https://compute.googleapis.com/compute/v1/projects/${p}/global/securityPolicies`,
      "items",
    );
    return items.map((policy) => {
      const name = String(policy["name"]);
      const rules = policy["rules"] as unknown[] | undefined;
      return {
        id: this.id(accountId, "cloud-armor-policy", `${p}/${name}`),
        pluginId: "gcp",
        resourceTypeId: "cloud-armor-policy",
        accountId,
        displayName: name,
        fields: {
          name,
          description: String(policy["description"] ?? ""),
          type: String(policy["type"] ?? "CLOUD_ARMOR"),
          ruleCount: rules?.length ?? 0,
        },
        resolvedOutputs: {},
        secretStates: [],
        externalId: `${p}/${name}`,
        createdAt: String(policy["creationTimestamp"] ?? this.now()),
        updatedAt: this.now(),
      };
    });
  }

  private async listSecretManagerSecrets(accountId: string, p: string): Promise<ResourceInstance[]> {
    const items = await this.paginate<Record<string, unknown>>(
      `https://secretmanager.googleapis.com/v1/projects/${p}/secrets`,
      "secrets",
    );
    return items.map((secret) => {
      const fullName = String(secret["name"]);
      const name = fullName.split("/").pop() ?? "";
      const replication = secret["replication"] as Record<string, unknown> | undefined;
      const replicationType = replication?.["automatic"]
        ? "automatic"
        : replication?.["userManaged"]
        ? "user-managed"
        : "unknown";
      return {
        id: this.id(accountId, "secret-manager-secret", fullName),
        pluginId: "gcp",
        resourceTypeId: "secret-manager-secret",
        accountId,
        displayName: name,
        fields: {
          name,
          replicationType,
        },
        resolvedOutputs: {},
        secretStates: [],
        externalId: fullName,
        createdAt: String(secret["createTime"] ?? this.now()),
        updatedAt: this.now(),
      };
    });
  }

  private async listDataflowJobs(accountId: string, p: string): Promise<ResourceInstance[]> {
    const items = await this.paginate<Record<string, unknown>>(
      `https://dataflow.googleapis.com/v1b3/projects/${p}/jobs`,
      "jobs",
      { filter: "ACTIVE" },
    );
    return items.map((job) => {
      const name = String(job["name"]);
      const region = String(job["location"] ?? "");
      const sdkVersion = (job["jobMetadata"] as Record<string, unknown> | undefined)?.["sdkVersion"] as
        | Record<string, string>
        | undefined;
      return {
        id: this.id(accountId, "dataflow-job", String(job["id"])),
        pluginId: "gcp",
        resourceTypeId: "dataflow-job",
        accountId,
        displayName: name,
        fields: {
          name,
          region,
          type: String(job["type"] ?? ""),
          state: String(job["currentState"] ?? ""),
          sdkVersion: sdkVersion?.["version"] ?? "",
        },
        resolvedOutputs: {},
        secretStates: [],
        externalId: String(job["id"]),
        createdAt: String(job["createTime"] ?? this.now()),
        updatedAt: String(job["currentStateTime"] ?? this.now()),
      };
    });
  }
}
