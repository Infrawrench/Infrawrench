import { describe, expect, it, vi } from "vitest";
import type { CloudFetch } from "../fetch";
import type { PostureFinding } from "../posture";
import {
  fetchResourceSpend,
  postureFindingsByResource,
  resourceStatusFromFields,
} from "../resource-insight";
import { filterServices } from "../search";
import type { Service } from "../services";

describe("fetchResourceSpend", () => {
  it("queries the trailing window by resource and sums per currency", async () => {
    const org = vi.fn().mockResolvedValue({
      series: [
        {
          key: "i-1",
          label: "i-1",
          currency: "USD",
          points: [
            { bucket: "2026-09-01", amount: 10 },
            { bucket: "2026-10-01", amount: 5.5 },
          ],
        },
        {
          key: "__other__",
          label: "Other",
          currency: "USD",
          points: [{ bucket: "2026-10-01", amount: 99 }],
        },
      ],
    });
    const api = { org } as unknown as CloudFetch;
    const out = await fetchResourceSpend(api, "o", [{ externalId: "i-1", accountId: "a" }], {
      now: Date.UTC(2026, 9, 12),
    });
    expect(out.get("i-1")).toEqual([{ amount: 15.5, currency: "USD" }]);
    expect(out.has("__other__")).toBe(false);
    const body = JSON.parse(org.mock.calls[0]![2].body as string);
    expect(body).toMatchObject({ from: "2026-09-13", to: "2026-10-12", groupBy: "resource" });
    expect(body.filters[0]).toEqual({ dimension: "resource", op: "in", values: ["i-1"] });
  });

  it("chunks past the topN ceiling and skips the request when empty", async () => {
    const org = vi.fn().mockResolvedValue({ series: [] });
    const api = { org } as unknown as CloudFetch;
    await fetchResourceSpend(api, "o", []);
    expect(org).not.toHaveBeenCalled();
    const refs = Array.from({ length: 20 }, (_, i) => ({ externalId: `x${i}`, accountId: "a" }));
    await fetchResourceSpend(api, "o", refs);
    expect(org).toHaveBeenCalledTimes(2);
  });
});

describe("postureFindingsByResource", () => {
  it("groups worst first", () => {
    const f = (resourceId: string, severity: PostureFinding["severity"]) =>
      ({ resourceId, severity, ruleId: severity }) as PostureFinding;
    const map = postureFindingsByResource({
      findings: [f("r", "low"), f("r", "critical"), f("s", "high")],
    });
    expect(map.get("r")!.map((x) => x.severity)).toEqual(["critical", "low"]);
    expect(map.get("s")).toHaveLength(1);
  });
});

describe("resourceStatusFromFields", () => {
  it("reads the first status-like field", () => {
    expect(resourceStatusFromFields({ state: "running" })).toBe("running");
    expect(resourceStatusFromFields({ status: "", phase: "Bound" })).toBe("Bound");
    expect(resourceStatusFromFields({ size: 3 })).toBeNull();
    expect(resourceStatusFromFields(null)).toBeNull();
  });
});

describe("filterServices", () => {
  it("matches name, slug, team and description", () => {
    const s = (name: string, extra: Partial<Service> = {}) =>
      ({ name, slug: name.toLowerCase(), ownerTeam: null, description: null, ...extra }) as Service;
    const list = [
      s("Checkout", { ownerTeam: "Payments" }),
      s("Search", { description: "query api" }),
    ];
    expect(filterServices(list, "pay").map((x) => x.name)).toEqual(["Checkout"]);
    expect(filterServices(list, "QUERY").map((x) => x.name)).toEqual(["Search"]);
    expect(filterServices(list, " ")).toHaveLength(2);
  });
});
