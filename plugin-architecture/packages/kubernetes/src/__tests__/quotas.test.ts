import { describe, expect, it, vi } from "vitest";
import { fetchK8sQuotas, quotaReadingsFor, resourceLabel, unitForResource } from "../quotas.js";

/**
 * A `ResourceQuotaList` in the shape `GET /api/v1/resourcequotas` returns.
 * `status.hard` and `status.used` are `resource.Quantity` strings — `8500m`
 * is 8.5 cores and `40Gi` is 42,949,672,960 bytes, which is the whole reason
 * `parseQuantity` sits between the API and the reading.
 */
const QUOTA_LIST = {
  kind: "ResourceQuotaList",
  apiVersion: "v1",
  items: [
    {
      metadata: { name: "compute", namespace: "team-a" },
      status: {
        hard: { "requests.cpu": "20", "limits.memory": "40Gi", pods: "50" },
        used: { "requests.cpu": "8500m", "limits.memory": "12Gi", pods: "31" },
      },
    },
    {
      metadata: { name: "compute", namespace: "team-b" },
      status: {
        hard: { "requests.cpu": "4" },
        used: { "requests.cpu": "3800m" },
      },
    },
  ],
};

describe("resourceLabel", () => {
  it("uses the curated label for the standard resource names", () => {
    expect(resourceLabel("requests.cpu")).toBe("CPU requests");
    expect(resourceLabel("services.loadbalancers")).toBe("LoadBalancer services");
  });

  // ResourceQuota covers arbitrary extended resources and CRD counts; a table
  // of known names would silently miss the scarce, contended things people
  // actually set quotas on.
  it("keeps an unmapped resource rather than dropping it", () => {
    expect(resourceLabel("requests.nvidia.com/gpu")).toBe("requests.nvidia.com/gpu");
    expect(resourceLabel("count/widgets.example.com")).toBe("widgets.example.com");
  });
});

describe("unitForResource", () => {
  // parseQuantity normalises to base units, so the unit describes the parsed
  // number and not the string it came from. "GB" next to a byte count is off
  // by nine orders of magnitude and the surface cannot notice.
  it("describes the parsed number, not the quantity string", () => {
    expect(unitForResource("limits.memory")).toBe("bytes");
    expect(unitForResource("requests.cpu")).toBe("cores");
    expect(unitForResource("pods")).toBeUndefined();
  });
});

describe("quotaReadingsFor", () => {
  it("parses Kubernetes quantities into base units", () => {
    const readings = quotaReadingsFor(QUOTA_LIST.items[0]!);
    const cpu = readings.find((r) => r.id.endsWith("requests.cpu"))!;
    expect(cpu.limit).toBe(20);
    expect(cpu.used).toBe(8.5);

    const memory = readings.find((r) => r.id.endsWith("limits.memory"))!;
    // Gi is 2^30, not 10^9. Treating them as equal under-counts by 7.4% here
    // and in the same direction every time, so it never looks like a bug.
    expect(memory.limit).toBe(40 * 1024 ** 3);
    expect(memory.used).toBe(12 * 1024 ** 3);
  });

  // Two namespaces routinely hold a ResourceQuota called `compute`; keying on
  // the object name alone would collapse every team's CPU quota into one
  // series that describes none of them.
  it("keys on namespace and object name as well as the resource", () => {
    const all = QUOTA_LIST.items.flatMap((item) => quotaReadingsFor(item));
    const cpuIds = all.filter((r) => r.id.endsWith("requests.cpu")).map((r) => r.id);
    expect(cpuIds).toEqual([
      "resourcequota/team-a/compute/requests.cpu",
      "resourcequota/team-b/compute/requests.cpu",
    ]);
  });

  it("groups by namespace, because that is what a reader asks about", () => {
    const readings = quotaReadingsFor(QUOTA_LIST.items[0]!);
    expect(readings.every((r) => r.service === "team-a")).toBe(true);
  });

  // The API server omits a `used` entry only when nothing consumes it — that
  // genuinely is zero, and dropping the row would hide a fresh namespace's
  // whole quota.
  it("reads a missing used entry as zero", () => {
    const readings = quotaReadingsFor({
      metadata: { name: "compute", namespace: "fresh" },
      status: { hard: { pods: "50" }, used: {} },
    });
    expect(readings).toHaveLength(1);
    expect(readings[0]!.used).toBe(0);
  });

  // Unparseable is a fact we do not have. Calling it zero would draw an empty
  // bar under a ceiling that may be full.
  it("drops a resource whose used value cannot be parsed", () => {
    const readings = quotaReadingsFor({
      metadata: { name: "compute", namespace: "team-a" },
      status: { hard: { pods: "50" }, used: { pods: "many" } },
    });
    expect(readings).toEqual([]);
  });

  // A key in `used` but not `hard` is consumption under no ceiling — it has no
  // utilisation and belongs on a usage screen, not a radar.
  it("iterates hard, not used", () => {
    const readings = quotaReadingsFor({
      metadata: { name: "compute", namespace: "team-a" },
      status: { hard: { pods: "50" }, used: { pods: "3", secrets: "20" } },
    });
    expect(readings.map((r) => r.id)).toEqual(["resourcequota/team-a/compute/pods"]);
  });

  it("drops an object with no namespace", () => {
    expect(quotaReadingsFor({ status: { hard: { pods: "50" } } })).toEqual([]);
  });
});

describe("fetchK8sQuotas", () => {
  it("lists every namespace's quotas in one unpaginated call", async () => {
    const fetch = vi.fn(async () => QUOTA_LIST as never);
    const readings = await fetchK8sQuotas({ fetch });
    expect(fetch).toHaveBeenCalledWith("/api/v1/resourcequotas");
    expect(readings).toHaveLength(4);
  });

  // Quotas are opt-in in Kubernetes and most small clusters have none. This is
  // the one provider here where an empty result is a true statement about the
  // cluster rather than a hint that something is misconfigured, so it must not
  // throw the way AWS and GCP do.
  it("returns nothing, without throwing, for a cluster with no ResourceQuotas", async () => {
    const fetch = vi.fn(async () => ({ items: [] }) as never);
    await expect(fetchK8sQuotas({ fetch })).resolves.toEqual([]);
  });
});
