/**
 * GCP quota readings — Compute Engine's own region and project resources.
 *
 * GCP is the easy one, and it is worth saying why: `compute.regions.list` and
 * `compute.projects.get` each return a `quotas[]` array in which every entry
 * carries **both** `limit` and `usage`. One request per scope, both halves
 * from the provider, no second service to join against. AWS needs two calls
 * per quota and a CloudWatch namespace; this needs two calls in total.
 *
 * **Wire shape verified against the live discovery document, August 2026**
 * (https://www.googleapis.com/discovery/v1/apis/compute/v1/rest): the `Quota`
 * schema has exactly four output-only fields — `metric` (string, from a ~160
 * value enum), `limit` (double), `usage` (double) and `owner` (string, usually
 * omitted on these two payloads). `Region.quotas` is "quotas assigned to this
 * region"; `Project.quotas` is "quotas assigned to this project", which is
 * where the global metrics (`NETWORKS`, `FIREWALLS`, `CPUS_ALL_REGIONS`) live.
 *
 * Deliberately **not** the Cloud Quotas API (`cloudquotas.googleapis.com`).
 * It is newer and covers more services, but `QuotaInfo` carries limits and
 * increase-eligibility and **no current usage** — so it cannot answer the only
 * question this feature asks. It would be an addition, never a replacement.
 */

import { QuotaAccessError, type QuotaUsage } from "@infrawrench/plugin-base";

/** One entry of a `Region.quotas` / `Project.quotas` array. */
export interface GcpQuota {
  metric?: string;
  limit?: number;
  usage?: number;
  owner?: string;
}

export interface GcpRegion {
  name?: string;
  status?: string;
  quotas?: GcpQuota[];
}

export interface GcpRegionList {
  items?: GcpRegion[];
  nextPageToken?: string;
}

export interface GcpProject {
  name?: string;
  quotas?: GcpQuota[];
}

/**
 * What this module needs from the network, injected so the assembly is
 * testable against recorded fixtures. The `DoCostFetchContext` shape.
 */
export interface GcpQuotaContext {
  project: string;
  /** `compute.regions.list`, paginated by `pageToken`. */
  listRegions(pageToken?: string): Promise<GcpRegionList>;
  /** `compute.projects.get`. */
  getProject(): Promise<GcpProject>;
}

/**
 * Human labels for the metrics worth naming. `CPUS` is not a self-explanatory
 * string in a list beside `IN_USE_ADDRESSES`, and the provider does not send a
 * display name on this API — the newer Cloud Quotas API does, but it does not
 * send usage, which is the trade this module already declined.
 *
 * An unmapped metric is **not dropped**: it is titled from its own name, so a
 * quota GCP adds after this table was written still appears. Dropping the
 * unknown would make the radar silently narrower with every provider release.
 */
const METRIC_LABELS: Record<string, string> = {
  CPUS: "CPUs",
  CPUS_ALL_REGIONS: "CPUs (all regions)",
  DISKS_TOTAL_GB: "Persistent disk total",
  SSD_TOTAL_GB: "SSD persistent disk total",
  LOCAL_SSD_TOTAL_GB: "Local SSD total",
  IN_USE_ADDRESSES: "In-use IP addresses",
  STATIC_ADDRESSES: "Static IP addresses",
  INSTANCES: "VM instances",
  INSTANCE_GROUPS: "Instance groups",
  INSTANCE_TEMPLATES: "Instance templates",
  SUBNETWORKS: "Subnetworks",
  NETWORKS: "VPC networks",
  FIREWALLS: "Firewall rules",
  ROUTES: "Routes",
  IMAGES: "Images",
  SNAPSHOTS: "Snapshots",
  FORWARDING_RULES: "Forwarding rules",
  BACKEND_SERVICES: "Backend services",
  HEALTH_CHECKS: "Health checks",
  URL_MAPS: "URL maps",
  SSL_CERTIFICATES: "SSL certificates",
  PREEMPTIBLE_CPUS: "Preemptible CPUs",
  GPUS_ALL_REGIONS: "GPUs (all regions)",
};

/**
 * `DISKS_TOTAL_GB` → "Persistent disk total"; `NVIDIA_T4_GPUS` → "NVIDIA T4
 * GPUS".
 *
 * The unmapped fallback only swaps underscores for spaces — it deliberately
 * does not try to title-case. Every case-guessing rule mangles something:
 * lowercasing long words turns `NVIDIA` into `Nvidia`, and any acronym
 * allow-list is a table that goes stale exactly as fast as `METRIC_LABELS`
 * does. The raw metric is also the string `gcloud compute regions describe`
 * prints, so leaving it alone is what makes the row searchable.
 */
export function quotaMetricLabel(metric: string): string {
  const mapped = METRIC_LABELS[metric];
  if (mapped) return mapped;
  return metric.split("_").join(" ");
}

/** Metrics whose numbers are gigabytes rather than a count of objects. */
function unitForMetric(metric: string): string | undefined {
  if (metric.endsWith("_GB")) return "GB";
  if (metric === "CPUS" || metric.endsWith("_CPUS")) return "vCPUs";
  if (metric.endsWith("_GPUS")) return "GPUs";
  return undefined;
}

const INCREASE_URL = "https://console.cloud.google.com/iam-admin/quotas";

/**
 * Turn one `quotas[]` entry into a reading, or null when it says nothing.
 *
 * Two GCP-specific drops, both of which would otherwise become the loudest
 * rows on the page:
 *
 * - **`limit: -1` is GCP for unlimited.** Divided into a utilisation it is
 *   negative, and a negative sorts above 100% in every "worst first" ordering.
 * - **`usage: 0` is not a finding.** A project with 40 regions enabled reports
 *   a full quota array for every one of them, almost all at zero; a radar
 *   listing two thousand quotas at 0% buries the four that matter. Nothing
 *   actionable is lost — a quota nobody is using cannot be the thing that
 *   breaks the next deploy.
 */
export function toQuotaReading(quota: GcpQuota, scope: { region?: string }): QuotaUsage | null {
  const metric = quota.metric;
  if (!metric) return null;
  const limit = quota.limit;
  const usage = quota.usage;
  if (typeof limit !== "number" || typeof usage !== "number") return null;
  if (!Number.isFinite(limit) || limit <= 0) return null;
  if (usage <= 0) return null;

  const unit = unitForMetric(metric);
  return {
    id: scope.region ? `compute/${metric}/${scope.region}` : `compute/${metric}`,
    service: "compute",
    name: quotaMetricLabel(metric),
    ...(scope.region ? { region: scope.region } : {}),
    limit,
    used: usage,
    ...(unit ? { unit } : {}),
    // Every Compute Engine quota can be raised through a quota-increase
    // request, which is one of the few places a blanket `true` is honest
    // rather than a guess — the console offers the button on all of them.
    adjustable: true,
    docsUrl: INCREASE_URL,
  };
}

/** Guard against a runaway page loop if the API ever returns a stable token. */
const MAX_REGION_PAGES = 10;

/**
 * Read the project's global quotas and every region's.
 *
 * The regions are read with `regions.list` rather than a `regions.get` per
 * region, which is the difference between one request and forty: the list
 * response carries each region's full `quotas[]` array, so a single paginated
 * call covers the whole project.
 *
 * A failure propagates — the host replaces its stored readings with what this
 * returns, so a partial list would read as quotas having disappeared.
 */
export async function fetchGcpQuotas(ctx: GcpQuotaContext): Promise<QuotaUsage[]> {
  const readings: QuotaUsage[] = [];

  const project = await ctx.getProject();
  for (const quota of project.quotas ?? []) {
    const reading = toQuotaReading(quota, {});
    if (reading) readings.push(reading);
  }

  let pageToken: string | undefined;
  for (let page = 0; page < MAX_REGION_PAGES; page++) {
    const response: GcpRegionList = await ctx.listRegions(pageToken);
    for (const region of response.items ?? []) {
      const name = region.name;
      if (!name) continue;
      // A region the project has been cut off from reports stale quotas that
      // nobody can act on. `UP` is the only status that means "you can
      // provision here".
      if (region.status && region.status !== "UP") continue;
      for (const quota of region.quotas ?? []) {
        const reading = toQuotaReading(quota, { region: name });
        if (reading) readings.push(reading);
      }
    }
    pageToken = response.nextPageToken;
    if (!pageToken) break;
  }

  if (readings.length === 0 && (project.quotas ?? []).length === 0) {
    // An empty `quotas[]` on `projects.get` means the Compute Engine API is
    // not enabled on the project, or the service account cannot see it. Both
    // are fixable, and both are different from "you are nowhere near a limit".
    throw new QuotaAccessError(
      `The Compute Engine API returned no quotas for project "${ctx.project}". Enable ` +
        `compute.googleapis.com on the project and grant the service account ` +
        `roles/compute.viewer.`,
      {
        label: "Enable the Compute Engine API",
        url: `https://console.cloud.google.com/apis/library/compute.googleapis.com?project=${encodeURIComponent(
          ctx.project,
        )}`,
      },
    );
  }

  return readings;
}
