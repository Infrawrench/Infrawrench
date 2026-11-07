import { hostClient } from "@infrawrench/plugin-base/effect";
import type { HostServices } from "@infrawrench/plugin-base";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createConfluentContext } from "../api.js";
import { ConfluentCloudClient } from "../client.js";
import { fetchConfluentCostData } from "../cost-data.js";
import { makeHttp } from "./helpers.js";
import type { Recorded, Reply } from "./helpers.js";

const TRUNCATED = "has more than Infrawrench reads";
const NOT_A_LIST = "is not a list";
const FOREIGN = "Refusing to send the account's credentials there";

const ENV = { id: "env-1", display_name: "prod" };

type Route = (url: URL, method: string, body: unknown) => Reply | undefined;

function client(route: Route): {
  c: ReturnType<typeof hostClient<ConfluentCloudClient>>;
  calls: Recorded[];
} {
  const { http, calls } = makeHttp((url, method, body) => {
    const reply = route(url, method, body);
    if (reply) return reply;
    if (url.hostname === "api.telemetry.confluent.cloud") return { body: { data: [] } };
    if (url.pathname === "/org/v2/environments") return { body: { data: [ENV], metadata: {} } };
    throw new Error(`unexpected request: ${method} ${url.href}`);
  });
  const services: HostServices = { http };
  return {
    c: hostClient(new ConfluentCloudClient({ apiKey: "CLOUDKEY", apiSecret: "s3cr3t" }, services)),
    calls,
  };
}

/** A page of `/iam/v2/service-accounts` with a next link, whichever page it is. */
function serviceAccountPage(url: URL, next: string): Reply {
  return {
    body: {
      data: [{ id: `sa-${url.searchParams.get("page_token") ?? "first"}` }],
      metadata: { next },
    },
  };
}

beforeEach(() => {
  vi.stubGlobal("fetch", () => {
    throw new Error("the global fetch must not be reached");
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("list reads (#384)", () => {
  it("throws past the cap, after exactly the 100 pages that hold 10,000 rows", async () => {
    let n = 0;
    const { c, calls } = client((url) => {
      if (url.pathname !== "/iam/v2/service-accounts") return undefined;
      n++;
      return serviceAccountPage(url, `https://api.confluent.cloud${url.pathname}?page_token=t${n}`);
    });
    await expect(c.listResources("service-account", "acc")).rejects.toThrow(TRUNCATED);
    expect(calls.filter((x) => x.url.pathname === "/iam/v2/service-accounts")).toHaveLength(100);
  });

  it("reads a 99-page list to its end, asking for the largest page", async () => {
    let n = 0;
    const { c, calls } = client((url) => {
      if (url.pathname !== "/iam/v2/service-accounts") return undefined;
      n++;
      if (n === 99) return { body: { data: [{ id: "sa-last" }], metadata: {} } };
      return serviceAccountPage(url, `https://api.confluent.cloud${url.pathname}?page_token=t${n}`);
    });
    await expect(c.listResources("service-account", "acc")).resolves.toHaveLength(99);
    expect(calls[0]!.url.searchParams.get("page_size")).toBe("100");
  });

  it("keeps reading past an empty page that still has a next link", async () => {
    const { c } = client((url) => {
      if (url.pathname !== "/iam/v2/service-accounts") return undefined;
      const token = url.searchParams.get("page_token");
      if (!token) {
        return {
          body: {
            data: [],
            metadata: { next: "https://api.confluent.cloud/iam/v2/service-accounts?page_token=p2" },
          },
        };
      }
      return { body: { data: [{ id: "sa-after-empty" }], metadata: {} } };
    });
    const rows = await c.listResources("service-account", "acc");
    expect(rows.map((r) => r.externalId)).toEqual(["sa-after-empty"]);
  });

  it("refuses a first page with its list key renamed", async () => {
    const { c } = client((url) =>
      url.pathname === "/iam/v2/service-accounts"
        ? { body: { items: [{ id: "sa-1" }], metadata: {} } }
        : undefined,
    );
    await expect(c.listResources("service-account", "acc")).rejects.toThrow(NOT_A_LIST);
  });

  it("refuses a later page with its list key renamed", async () => {
    const { c } = client((url) => {
      if (url.pathname !== "/iam/v2/service-accounts") return undefined;
      if (url.searchParams.get("page_token")) return { body: { items: [], metadata: {} } };
      return serviceAccountPage(url, `https://api.confluent.cloud${url.pathname}?page_token=p2`);
    });
    await expect(c.listResources("service-account", "acc")).rejects.toThrow(NOT_A_LIST);
  });

  it("refuses a 2xx list page that is not JSON", async () => {
    const { http } = makeHttp(() => ({ body: undefined }));
    const c = hostClient(
      new ConfluentCloudClient(
        { apiKey: "CLOUDKEY", apiSecret: "s3cr3t" },
        { http: { request: async (req) => ({ ...(await http.request(req)), body: "<html>" }) } },
      ),
    );
    await expect(c.listResources("environment", "acc")).rejects.toThrow(NOT_A_LIST);
  });

  it("reads a null list as empty, the way a nil slice is serialised", async () => {
    const { c } = client((url) =>
      url.pathname === "/iam/v2/service-accounts"
        ? { body: { data: null, metadata: {} } }
        : undefined,
    );
    await expect(c.listResources("service-account", "acc")).resolves.toEqual([]);
  });

  it("asks the network lists for 1,000 a page where the document allows it", async () => {
    const { c, calls } = client((url) =>
      url.pathname.startsWith("/networking/v1/") ? { body: { data: [], metadata: {} } } : undefined,
    );
    await c.listResources("network", "acc");
    await c.listResources("network-connection", "acc");
    const asked = new Map(
      calls
        .filter((x) => x.url.pathname.startsWith("/networking/v1/"))
        .map((x) => [x.url.pathname, x.url.searchParams.get("page_size")]),
    );
    expect(Object.fromEntries(asked)).toEqual({
      "/networking/v1/networks": "1000",
      "/networking/v1/peerings": "1000",
      "/networking/v1/transit-gateway-attachments": "1000",
      "/networking/v1/private-link-accesses": "1000",
      "/networking/v1/private-link-attachments": "100",
    });
  });

  it("stops a 1,000-a-page network list at 50,000 rows", async () => {
    let n = 0;
    const { c, calls } = client((url) => {
      if (url.pathname !== "/networking/v1/networks") return undefined;
      n++;
      return {
        body: {
          data: [{ id: `n-${n}` }],
          metadata: { next: `https://api.confluent.cloud${url.pathname}?page_token=t${n}` },
        },
      };
    });
    await expect(c.listResources("network", "acc")).rejects.toThrow(TRUNCATED);
    expect(calls.filter((x) => x.url.pathname === "/networking/v1/networks")).toHaveLength(50);
  });

  it("fails the cost read rather than return part of a window", async () => {
    let n = 0;
    const { http, calls } = makeHttp((url) => {
      n++;
      return {
        body: {
          data: [{ start_date: "2026-09-01", product: "KAFKA", amount: 1 }],
          metadata: { next: `https://api.confluent.cloud${url.pathname}?page_token=t${n}` },
        },
      };
    });
    const ctx = createConfluentContext({ apiKey: "k", apiSecret: "s", http });
    await expect(
      fetchConfluentCostData(ctx, { fromDate: "2026-09-01", toDate: "2026-09-01" }),
    ).rejects.toThrow(TRUNCATED);
    // Never below the 100 pages of 5,000 this read used to allow.
    expect(calls).toHaveLength(1000);
    expect(calls[0]!.url.searchParams.get("page_size")).toBe("10000");
  });
});

describe("catches around list reads (#384)", () => {
  const brokenEnvironments: Route = (url) =>
    url.pathname === "/org/v2/environments" ? { body: { items: [ENV], metadata: {} } } : undefined;

  it("does not read a bad environment page as no environments for cluster names", async () => {
    const { c } = client(brokenEnvironments);
    await expect(c.listResources("kafka-cluster", "acc")).rejects.toThrow(NOT_A_LIST);
  });

  it("does not drop an incomplete service account list behind the API key names", async () => {
    let n = 0;
    const { c } = client((url) => {
      if (url.pathname === "/iam/v2/api-keys") return { body: { data: [], metadata: {} } };
      if (url.pathname !== "/iam/v2/service-accounts") return undefined;
      n++;
      return serviceAccountPage(url, `https://api.confluent.cloud${url.pathname}?page_token=t${n}`);
    });
    await expect(c.listResources("api-key", "acc")).rejects.toThrow(TRUNCATED);
  });

  it("does not hide an incomplete list behind the cost context", async () => {
    const { c } = client((url, method, body) => {
      if (url.pathname === "/billing/v1/costs") return { body: { data: [], metadata: {} } };
      return brokenEnvironments(url, method, body);
    });
    await expect(
      c.fetchCostData("acc", { fromDate: "2026-09-01", toDate: "2026-09-01" }),
    ).rejects.toThrow(NOT_A_LIST);
  });

  it("still fills regions on a best-effort basis when a context read just fails", async () => {
    const { c } = client((url) => {
      if (url.pathname === "/billing/v1/costs") {
        return {
          body: { data: [{ start_date: "2026-09-01", product: "KAFKA", amount: 1 }], metadata: {} },
        };
      }
      if (url.pathname === "/org/v2/environments") return { status: 500, body: {} };
      return undefined;
    });
    const rows = await c.fetchCostData("acc", { fromDate: "2026-09-01", toDate: "2026-09-01" });
    expect(rows).toHaveLength(1);
  });
});

describe("next links (#386)", () => {
  it("refuses a next link to another origin and sends it nothing", async () => {
    const { c, calls } = client((url) => {
      if (url.pathname !== "/iam/v2/service-accounts") return undefined;
      return serviceAccountPage(url, "https://evil.example/iam/v2/service-accounts?page_token=p2");
    });
    await expect(c.listResources("service-account", "acc")).rejects.toThrow(FOREIGN);
    expect(calls.some((x) => x.url.hostname === "evil.example")).toBe(false);
  });

  it("refuses a look-alike host and plain http", async () => {
    for (const next of [
      "https://api.confluent.cloud.evil.example/x",
      "http://api.confluent.cloud/iam/v2/service-accounts?page_token=p2",
      "//evil.example/x",
    ]) {
      const { c, calls } = client((url) =>
        url.pathname === "/iam/v2/service-accounts" ? serviceAccountPage(url, next) : undefined,
      );
      await expect(c.listResources("service-account", "acc")).rejects.toThrow(FOREIGN);
      expect(calls).toHaveLength(1);
    }
  });

  it("refuses through the catch that names API key owners", async () => {
    const { c, calls } = client((url) => {
      if (url.pathname === "/iam/v2/api-keys") return { body: { data: [], metadata: {} } };
      if (url.pathname !== "/iam/v2/service-accounts") return undefined;
      return serviceAccountPage(url, "https://evil.example/next");
    });
    await expect(c.listResources("api-key", "acc")).rejects.toThrow(FOREIGN);
    expect(calls.some((x) => x.url.hostname === "evil.example")).toBe(false);
  });

  it("refuses from the Billing Costs API too", async () => {
    const { http, calls } = makeHttp(() => ({
      body: {
        data: [{ start_date: "2026-09-01", product: "KAFKA", amount: 1 }],
        metadata: { next: "https://evil.example/billing/v1/costs?page_token=p2" },
      },
    }));
    const ctx = createConfluentContext({ apiKey: "k", apiSecret: "s", http });
    await expect(
      fetchConfluentCostData(ctx, { fromDate: "2026-09-01", toDate: "2026-09-01" }),
    ).rejects.toThrow(FOREIGN);
    expect(calls).toHaveLength(1);
  });

  it("follows a relative link against the host it came from", async () => {
    const { c, calls } = client((url) => {
      if (url.pathname !== "/iam/v2/service-accounts") return undefined;
      if (url.searchParams.get("page_token")) {
        return { body: { data: [{ id: "sa-2" }], metadata: {} } };
      }
      return serviceAccountPage(url, "/iam/v2/service-accounts?page_token=p2");
    });
    await expect(c.listResources("service-account", "acc")).resolves.toHaveLength(2);
    expect(calls[1]!.url.href).toBe(
      "https://api.confluent.cloud/iam/v2/service-accounts?page_token=p2",
    );
  });
});

describe("host HTTP", () => {
  it("sends a followed page through the host, with no CA unless one is set", async () => {
    const request = vi.fn(async (req: { url: string; caCert?: string }) => ({
      status: 200,
      headers: {},
      body: JSON.stringify(
        req.url.includes("page_token")
          ? { data: [{ id: "sa-2" }], metadata: {} }
          : {
              data: [{ id: "sa-1" }],
              metadata: {
                next: "https://api.confluent.cloud/iam/v2/service-accounts?page_token=p2",
              },
            },
      ),
    }));
    const c = hostClient(
      new ConfluentCloudClient({ apiKey: "CLOUDKEY", apiSecret: "s3cr3t" }, { http: { request } }),
    );
    await expect(c.listResources("service-account", "acc")).resolves.toHaveLength(2);
    expect(request).toHaveBeenCalledTimes(2);
    for (const [req] of request.mock.calls) expect(req).not.toHaveProperty("caCert");
  });
});
