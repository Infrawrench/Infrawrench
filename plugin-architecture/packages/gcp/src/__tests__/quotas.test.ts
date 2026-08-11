import { describe, expect, it, vi } from "vitest";
import { QuotaAccessError } from "@infrawrench/plugin-base";
import { fetchGcpQuotas, quotaMetricLabel, toQuotaReading } from "../quotas.js";

/**
 * The `quotas[]` fragments are verbatim from documented `gcloud compute
 * regions describe` output; the enclosing `Region` fields match the
 * `compute#region` schema in the live discovery document
 * (https://www.googleapis.com/discovery/v1/apis/compute/v1/rest), where
 * `Quota` has exactly four output-only fields: metric, limit, usage, owner.
 */
const REGION_FIXTURE = {
  kind: "compute#region",
  id: "1220",
  name: "us-central1",
  status: "UP",
  quotas: [
    { metric: "CPUS", limit: 72.0, usage: 8.0 },
    { metric: "DISKS_TOTAL_GB", limit: 5120.0, usage: 650.0 },
    { metric: "IN_USE_ADDRESSES", limit: 8.0, usage: 2.0 },
    // Enabled but untouched — the overwhelming majority of every region's array.
    { metric: "SSD_TOTAL_GB", limit: 500.0, usage: 0.0 },
    // GCP's "unlimited".
    { metric: "PREEMPTIBLE_CPUS", limit: -1.0, usage: 12.0 },
  ],
};

const PROJECT_FIXTURE = {
  name: "my-project",
  quotas: [
    { metric: "NETWORKS", limit: 5.0, usage: 3.0 },
    { metric: "FIREWALLS", limit: 100.0, usage: 12.0 },
    { metric: "SNAPSHOTS", limit: 1000.0, usage: 0.0 },
  ],
};

function makeCtx(over: { regions?: unknown[]; project?: unknown; pages?: unknown[] } = {}) {
  const pages = over.pages ?? [{ items: over.regions ?? [REGION_FIXTURE] }];
  let page = 0;
  const listRegions = vi.fn(async () => pages[page++] as never);
  return {
    ctx: {
      project: "my-project",
      getProject: vi.fn(async () => (over.project ?? PROJECT_FIXTURE) as never),
      listRegions,
    },
    listRegions,
  };
}

describe("quotaMetricLabel", () => {
  it("uses the curated label where there is one", () => {
    expect(quotaMetricLabel("DISKS_TOTAL_GB")).toBe("Persistent disk total");
    expect(quotaMetricLabel("IN_USE_ADDRESSES")).toBe("In-use IP addresses");
  });

  // Dropping the unmapped would make the radar silently narrower with every
  // GCP release; the ~160-value enum grows and the table does not. The
  // fallback deliberately does not case-fold — `NVIDIA` must not become
  // `Nvidia`, and the raw metric is what `gcloud` prints, so it stays
  // searchable.
  it("titles an unmapped metric from its own name rather than dropping it", () => {
    expect(quotaMetricLabel("N2D_CPUS")).toBe("N2D CPUS");
    expect(quotaMetricLabel("NVIDIA_T4_GPUS")).toBe("NVIDIA T4 GPUS");
  });
});

describe("toQuotaReading", () => {
  it("carries both halves and derives the unit from the metric name", () => {
    expect(
      toQuotaReading({ metric: "CPUS", limit: 72, usage: 8 }, { region: "us-central1" }),
    ).toEqual({
      id: "compute/CPUS/us-central1",
      service: "compute",
      name: "CPUs",
      region: "us-central1",
      limit: 72,
      used: 8,
      unit: "vCPUs",
      adjustable: true,
      docsUrl: "https://console.cloud.google.com/iam-admin/quotas",
    });
  });

  it("omits the region entirely for a project-scoped quota", () => {
    const reading = toQuotaReading({ metric: "NETWORKS", limit: 5, usage: 3 }, {});
    expect(reading?.id).toBe("compute/NETWORKS");
    expect(reading?.region).toBeUndefined();
  });

  // -1 divided into a utilisation is negative, and a negative sorts above
  // 100% in every worst-first ordering.
  it("drops GCP's -1 unlimited sentinel", () => {
    expect(toQuotaReading({ metric: "PREEMPTIBLE_CPUS", limit: -1, usage: 12 }, {})).toBeNull();
  });

  it("drops an unused quota", () => {
    expect(toQuotaReading({ metric: "SSD_TOTAL_GB", limit: 500, usage: 0 }, {})).toBeNull();
  });

  it("drops a quota missing either half", () => {
    expect(toQuotaReading({ metric: "CPUS", limit: 72 }, {})).toBeNull();
    expect(toQuotaReading({ limit: 72, usage: 8 }, {})).toBeNull();
  });

  it("labels GB metrics in GB", () => {
    const reading = toQuotaReading({ metric: "DISKS_TOTAL_GB", limit: 5120, usage: 650 }, {});
    expect(reading?.unit).toBe("GB");
  });
});

describe("fetchGcpQuotas", () => {
  it("reads global and regional quotas in two calls", async () => {
    const { ctx } = makeCtx();
    const readings = await fetchGcpQuotas(ctx as never);
    const ids = readings.map((r) => r.id);

    expect(ids).toEqual([
      "compute/NETWORKS",
      "compute/FIREWALLS",
      "compute/CPUS/us-central1",
      "compute/DISKS_TOTAL_GB/us-central1",
      "compute/IN_USE_ADDRESSES/us-central1",
    ]);
    expect(ctx.getProject).toHaveBeenCalledOnce();
    expect(ctx.listRegions).toHaveBeenCalledOnce();
  });

  it("follows the region pagination token", async () => {
    const { ctx, listRegions } = makeCtx({
      pages: [
        { items: [REGION_FIXTURE], nextPageToken: "page-2" },
        { items: [{ ...REGION_FIXTURE, name: "europe-west1" }] },
      ],
    });
    const readings = await fetchGcpQuotas(ctx as never);
    expect(listRegions).toHaveBeenCalledTimes(2);
    expect(readings.map((r) => r.region)).toContain("europe-west1");
  });

  // A region the project has been cut off from reports stale quotas nobody
  // can act on. `UP` is the only status that means "you can provision here".
  it("skips a region that is not UP", async () => {
    const { ctx } = makeCtx({
      regions: [{ ...REGION_FIXTURE, name: "asia-east1", status: "DOWN" }],
    });
    const readings = await fetchGcpQuotas(ctx as never);
    expect(readings.every((r) => r.region === undefined)).toBe(true);
  });

  // An empty project `quotas[]` means the Compute Engine API is off or the
  // service account cannot see it. Both are fixable, and both are a different
  // fact from "you are nowhere near a limit".
  it("raises a fixable access error when the project reports no quotas at all", async () => {
    const { ctx } = makeCtx({ project: { name: "my-project", quotas: [] }, regions: [] });
    await expect(fetchGcpQuotas(ctx as never)).rejects.toBeInstanceOf(QuotaAccessError);
  });

  // A project that genuinely uses nothing regionally still has global quotas,
  // so the emptiness check must not fire on a healthy quiet project.
  it("does not raise when the project has quotas but none are in use regionally", async () => {
    const { ctx } = makeCtx({ regions: [] });
    await expect(fetchGcpQuotas(ctx as never)).resolves.toHaveLength(2);
  });
});
