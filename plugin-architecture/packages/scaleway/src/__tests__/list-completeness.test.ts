import { hostClient } from "@infrawrench/plugin-base/effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ScalewayClient } from "../client.js";
import { plugin } from "../plugin.js";

// The real Scaleway SDK over a fake host transport, so `.all()`, the `x-total-count`
// fix and the SDK's own error classes are the ones production runs.

const ACCOUNT = "acct1";
const CREDS = {
  accessKey: "SCWXXXXXXXXXXXXXXXXX",
  secretKey: "00000000-0000-0000-0000-000000000000",
  defaultProjectId: "00000000-0000-0000-0000-000000000001",
};

interface Answer {
  status?: number;
  headers?: Record<string, string>;
  body?: unknown;
}
type Route = (url: URL, method: string) => Answer | undefined;

const seen: string[] = [];
let route: Route = () => undefined;

const request = vi.fn(async (call: { url: string; method: string; body?: string | Uint8Array }) => {
  seen.push(call.url);
  const answer = route(new URL(call.url), call.method);
  if (!answer) throw new Error(`Unexpected request: ${call.method} ${call.url}`);
  const { status = 200, headers = {}, body = {} } = answer;
  return {
    status,
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  };
});

function client(creds: Record<string, string> = CREDS) {
  return hostClient(new ScalewayClient(creds, plugin.resourceTypes, { http: { request } }));
}

function numbered(prefix: string, from: number, count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: `${prefix}${from + i}`,
    name: `${prefix}${from + i}`,
  }));
}

/** One location's rows, paged as asked, with the total in the body or a header. */
function paged(
  url: URL,
  key: string,
  rows: Array<Record<string, unknown>>,
  totalIn: "body" | "header" = "body",
): Answer {
  const page = Number(url.searchParams.get("page") ?? 1);
  const size = Number(url.searchParams.get("per_page") ?? url.searchParams.get("page_size") ?? 20);
  const slice = rows.slice((page - 1) * size, page * size);
  return totalIn === "body"
    ? { body: { [key]: slice, total_count: rows.length } }
    : { headers: { "x-total-count": String(rows.length) }, body: { [key]: slice } };
}

/** A type read over one route per location, and how to find that route's location. */
interface ListedType {
  typeId: string;
  key: string;
  /** Matches a list route, capturing the zone or region. */
  pattern: RegExp;
  /** Where the rows in these tests live. */
  home: string;
  /** A location that is not `home`. */
  elsewhere: string;
  totalIn?: "header";
}

const FAN_OUTS: ListedType[] = [
  {
    typeId: "instance",
    key: "servers",
    pattern: /^\/instance\/v1\/zones\/([^/]+)\/servers$/,
    home: "fr-par-1",
    elsewhere: "nl-ams-1",
    totalIn: "header",
  },
  {
    typeId: "flexible-ip",
    key: "ips",
    pattern: /^\/instance\/v1\/zones\/([^/]+)\/ips$/,
    home: "fr-par-1",
    elsewhere: "nl-ams-1",
    totalIn: "header",
  },
  {
    typeId: "block-volume",
    key: "volumes",
    pattern: /^\/block\/v1\/zones\/([^/]+)\/volumes$/,
    home: "fr-par-1",
    elsewhere: "nl-ams-1",
  },
  {
    typeId: "kapsule-cluster",
    key: "clusters",
    pattern: /^\/k8s\/v1\/regions\/([^/]+)\/clusters$/,
    home: "fr-par",
    elsewhere: "nl-ams",
  },
  {
    typeId: "rdb-instance",
    key: "instances",
    pattern: /^\/rdb\/v1\/regions\/([^/]+)\/instances$/,
    home: "fr-par",
    elsewhere: "nl-ams",
  },
  {
    typeId: "load-balancer",
    key: "lbs",
    pattern: /^\/lb\/v1\/zones\/([^/]+)\/lbs$/,
    home: "fr-par-1",
    elsewhere: "nl-ams-1",
  },
  {
    typeId: "private-network",
    key: "private_networks",
    pattern: /^\/vpc\/v2\/regions\/([^/]+)\/private-networks$/,
    home: "fr-par",
    elsewhere: "nl-ams",
  },
  {
    typeId: "serverless-container",
    key: "containers",
    pattern: /^\/containers\/v1\/regions\/([^/]+)\/containers$/,
    home: "fr-par",
    elsewhere: "nl-ams",
  },
  {
    typeId: "serverless-function",
    key: "functions",
    pattern: /^\/functions\/v1beta1\/regions\/([^/]+)\/functions$/,
    home: "fr-par",
    elsewhere: "nl-ams",
  },
  {
    typeId: "registry-namespace",
    key: "namespaces",
    pattern: /^\/registry\/v1\/regions\/([^/]+)\/namespaces$/,
    home: "fr-par",
    elsewhere: "nl-ams",
  },
  {
    typeId: "secret",
    key: "secrets",
    pattern: /^\/secret-manager\/v1beta1\/regions\/([^/]+)\/secrets$/,
    home: "fr-par",
    elsewhere: "nl-ams",
  },
];

const SDK_BACKED = FAN_OUTS.slice(0, 5);

/** Rows in `home`, nothing elsewhere, except what `other` answers for `elsewhere`. */
function routeFanOut(type: ListedType, rows: number, other?: Answer | "network"): void {
  const all = numbered("r", 0, rows);
  route = (url) => {
    if (/\/pools$/.test(url.pathname)) return { body: { pools: [], total_count: 0 } };
    const match = type.pattern.exec(url.pathname);
    if (!match) return undefined;
    if (match[1] === type.elsewhere && other) {
      if (other === "network") throw new Error("connect ECONNREFUSED");
      return other;
    }
    return paged(url, type.key, match[1] === type.home ? all : [], type.totalIn);
  };
}

beforeEach(() => {
  seen.length = 0;
  route = () => undefined;
  request.mockClear();
  vi.stubGlobal("fetch", () => {
    throw new Error("reached the global fetch");
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("a list past its first page (#712)", () => {
  it.each(SDK_BACKED)("$typeId reads every page, 100 at a time", async (type) => {
    routeFanOut(type, 250);
    const rows = await client().listResources(type.typeId, ACCOUNT);
    expect(rows).toHaveLength(250);
    const home = seen.filter(
      (u) => u.includes(`/${type.home}/`) && type.pattern.test(new URL(u).pathname),
    );
    expect(home).toHaveLength(3);
    for (const url of home) expect(url).toMatch(/(per_page|page_size)=100/);
  });

  it("refuses a full SDK page with no total, which the SDK reads as the last", async () => {
    route = (url) =>
      url.pathname.endsWith("/servers")
        ? { body: { servers: numbered("s", 0, url.pathname.includes("fr-par-1") ? 100 : 0) } }
        : undefined;
    await expect(client().listResources("instance", ACCOUNT)).rejects.toThrow("is not a list");
  });

  it("refuses an SDK page that counts rows and holds none, a renamed key", async () => {
    route = (url) =>
      url.pathname.endsWith("/volumes")
        ? { body: { items: [{ id: "v" }], total_count: 1 } }
        : undefined;
    await expect(client().listResources("block-volume", ACCOUNT)).rejects.toThrow(
      "that says there is more",
    );
  });

  it("stops a list too long for one poll before reading it", async () => {
    route = (url) =>
      url.pathname.endsWith("/clusters")
        ? { body: { clusters: numbered("c", 0, 100), total_count: 100_001 } }
        : undefined;
    await expect(client().listResources("kapsule-cluster", ACCOUNT)).rejects.toThrow(
      "has more than Infrawrench reads",
    );
    expect(seen.filter((u) => u.includes("page=2"))).toEqual([]);
  });

  it("counts every pool of a cluster", async () => {
    const pools = Array.from({ length: 150 }, (_, i) => ({ id: `p${i}`, name: `p${i}`, size: 2 }));
    route = (url) => {
      if (url.pathname.endsWith("/pools")) return paged(url, "pools", pools);
      if (url.pathname.endsWith("/clusters")) {
        return paged(url, "clusters", url.pathname.includes("fr-par") ? numbered("c", 0, 1) : []);
      }
      return undefined;
    };
    const [cluster] = await client().listResources("kapsule-cluster", ACCOUNT);
    expect(cluster!.fields["nodeCount"]).toBe(300);
  });

  it("resizes against every pool, not the first page's", async () => {
    const pools = Array.from({ length: 150 }, (_, i) => ({ id: `p${i}`, name: `p${i}`, size: 1 }));
    const patched: string[] = [];
    route = (url, method) => {
      if (method === "PATCH") {
        patched.push(url.pathname);
        return { body: { id: "p0", size: 1 } };
      }
      if (url.pathname.endsWith("/pools")) return paged(url, "pools", pools);
      if (url.pathname.endsWith("/clusters")) {
        return paged(url, "clusters", url.pathname.includes("fr-par") ? numbered("c", 0, 1) : []);
      }
      return undefined;
    };
    const updated = request.getMockImplementation()!;
    let body = "";
    request.mockImplementation(async (call) => {
      if (call.method === "PATCH") body = String(call.body);
      return updated(call);
    });
    await client().updateResource(
      "kapsule-cluster",
      `${ACCOUNT}:kapsule-cluster:fr-par/c0`,
      ACCOUNT,
      {
        nodeCount: "200",
      },
    );
    request.mockImplementation(updated);
    expect(patched).toEqual(["/k8s/v1/regions/fr-par/pools/p0"]);
    // 149 nodes in the other pools leave 51 for the first. Only the first page's
    // 99 others would have left 101.
    expect(JSON.parse(body)).toMatchObject({ size: 51 });
  });
});

describe("a location that fails (#712)", () => {
  describe.each(FAN_OUTS)("$typeId", (type) => {
    it.each([500, 503, 429, 401])("a %i in one location fails the type", async (status) => {
      routeFanOut(type, 2, { status, body: { message: "no" } });
      await expect(client().listResources(type.typeId, ACCOUNT)).rejects.toThrow();
    });

    it("a network failure in one location fails the type", async () => {
      routeFanOut(type, 2, "network");
      await expect(client().listResources(type.typeId, ACCOUNT)).rejects.toThrow("ECONNREFUSED");
    });

    it.each([400, 403, 404, 501])("a %i in one location reads as none there", async (status) => {
      routeFanOut(type, 2, { status, body: { message: "not here" } });
      expect(await client().listResources(type.typeId, ACCOUNT)).toHaveLength(2);
    });

    it("every location refusing says so", async () => {
      route = (url) =>
        type.pattern.test(url.pathname)
          ? { status: 403, body: { type: "permissions_denied", message: "denied" } }
          : undefined;
      await expect(client().listResources(type.typeId, ACCOUNT)).rejects.toThrow("refused");
    });
  });

  it("a cluster whose pools fail fails the type rather than read as no nodes", async () => {
    route = (url) => {
      if (url.pathname.endsWith("/pools")) return { status: 503, body: { message: "busy" } };
      if (url.pathname.endsWith("/clusters")) {
        return paged(url, "clusters", url.pathname.includes("fr-par") ? numbered("c", 0, 1) : []);
      }
      return undefined;
    };
    await expect(client().listResources("kapsule-cluster", ACCOUNT)).rejects.toThrow();
  });

  it("a cluster gone between the two reads keeps the rest", async () => {
    route = (url) => {
      if (url.pathname.endsWith("/pools")) return { status: 404, body: { message: "gone" } };
      if (url.pathname.endsWith("/clusters")) {
        return paged(url, "clusters", url.pathname.includes("fr-par") ? numbered("c", 0, 1) : []);
      }
      return undefined;
    };
    expect(await client().listResources("kapsule-cluster", ACCOUNT)).toHaveLength(1);
  });
});

describe("DNS records fan out over zones (#712)", () => {
  const zones = {
    dns_zones: [
      { domain: "a.example", subdomain: "" },
      { domain: "b.example", subdomain: "" },
    ],
    total_count: 2,
  };

  it("a failed zone fails the type", async () => {
    route = (url) => {
      if (url.pathname.endsWith("/dns-zones")) return { body: zones };
      if (url.pathname.includes("b.example")) return { status: 500, body: { message: "no" } };
      return {
        body: { records: [{ id: "r", name: "", type: "A", data: "1.1.1.1" }], total_count: 1 },
      };
    };
    await expect(client().listResources("dns-record", ACCOUNT)).rejects.toThrow("API error 500");
  });

  it("a zone gone between the two reads keeps the rest", async () => {
    route = (url) => {
      if (url.pathname.endsWith("/dns-zones")) return { body: zones };
      if (url.pathname.includes("b.example")) return { status: 404, body: { message: "gone" } };
      return {
        body: { records: [{ id: "r", name: "", type: "A", data: "1.1.1.1" }], total_count: 1 },
      };
    };
    expect(await client().listResources("dns-record", ACCOUNT)).toHaveLength(1);
  });
});

describe("the REST list reader (#712)", () => {
  const LBS = /^\/lb\/v1\/zones\/[^/]+\/lbs$/;

  it("stops at its cap rather than read for ever", async () => {
    route = (url) =>
      LBS.test(url.pathname)
        ? url.pathname.includes("fr-par-1")
          ? { body: { lbs: numbered("l", 0, 100) } }
          : { body: { lbs: [], total_count: 0 } }
        : undefined;
    await expect(client().listResources("load-balancer", ACCOUNT)).rejects.toThrow(
      "has more than Infrawrench reads",
    );
    expect(seen.filter((u) => u.includes("/fr-par-1/"))).toHaveLength(1000);
  });

  it("refuses a renamed key on the first page", async () => {
    route = (url) => (LBS.test(url.pathname) ? { body: { items: [], total_count: 1 } } : undefined);
    await expect(client().listResources("load-balancer", ACCOUNT)).rejects.toThrow("is not a list");
  });

  it("refuses a renamed key on a later page", async () => {
    route = (url) => {
      if (!LBS.test(url.pathname)) return undefined;
      if (!url.pathname.includes("fr-par-1")) return { body: { lbs: [], total_count: 0 } };
      return url.searchParams.get("page") === "1"
        ? { body: { lbs: numbered("l", 0, 100), total_count: 150 } }
        : { body: { items: [] } };
    };
    await expect(client().listResources("load-balancer", ACCOUNT)).rejects.toThrow("is not a list");
  });

  it("reads an empty answer that leaves the key out but counts none", async () => {
    route = (url) => (LBS.test(url.pathname) ? { body: { total_count: 0 } } : undefined);
    expect(await client().listResources("load-balancer", ACCOUNT)).toEqual([]);
  });

  it("keeps reading a server that pages smaller than asked while the total says more", async () => {
    const rows = numbered("l", 0, 120);
    route = (url) => {
      if (!LBS.test(url.pathname)) return undefined;
      if (!url.pathname.includes("fr-par-1")) return { body: { lbs: [], total_count: 0 } };
      const page = Number(url.searchParams.get("page"));
      return { body: { lbs: rows.slice((page - 1) * 50, page * 50), total_count: rows.length } };
    };
    expect(await client().listResources("load-balancer", ACCOUNT)).toHaveLength(120);
  });
});

describe("Object Storage buckets (#712)", () => {
  const listing = (name?: string) =>
    `<ListAllMyBucketsResult><Buckets>${
      name
        ? `<Bucket><Name>${name}</Name><CreationDate>2024-01-01T00:00:00Z</CreationDate></Bucket>`
        : ""
    }</Buckets></ListAllMyBucketsResult>`;

  function routeBuckets(other: Answer) {
    route = (url) => {
      if (url.hostname === "s3.fr-par.scw.cloud") return { body: listing("kept") };
      if (url.hostname === "s3.nl-ams.scw.cloud") return other;
      return { body: listing() };
    };
  }

  it.each([500, 503])("a %i in one region fails the type", async (status) => {
    routeBuckets({ status, body: "no" });
    await expect(client().listResources("object-storage-bucket", ACCOUNT)).rejects.toThrow(
      `S3 error ${status}`,
    );
  });

  it("a 403 in one region reads as none there", async () => {
    routeBuckets({ status: 403, body: "<Error><Code>AccessDenied</Code></Error>" });
    expect(await client().listResources("object-storage-bucket", ACCOUNT)).toHaveLength(1);
  });

  it("every region refusing says so", async () => {
    route = () => ({ status: 403, body: "<Error><Code>InvalidAccessKeyId</Code></Error>" });
    await expect(client().listResources("object-storage-bucket", ACCOUNT)).rejects.toThrow(
      "refused",
    );
  });

  it("a 200 that is not a bucket listing does not read as no buckets", async () => {
    routeBuckets({ body: "<html>maintenance</html>" });
    await expect(client().listResources("object-storage-bucket", ACCOUNT)).rejects.toThrow(
      "is not a list",
    );
  });

  it("a missing access key says so rather than read as no buckets", async () => {
    await expect(
      client({ secretKey: CREDS.secretKey }).listResources("object-storage-bucket", ACCOUNT),
    ).rejects.toThrow("require an Access Key");
    expect(request).not.toHaveBeenCalled();
  });
});

describe("cost data (#712)", () => {
  const range = { fromDate: "2026-01-01", toDate: "2026-01-31" };

  it("stops at its cap rather than read for ever", async () => {
    route = () => ({
      body: {
        consumptions: Array.from({ length: 100 }, (_, i) => ({
          product_name: "p",
          resource_name: `r${i}`,
          value: { currency_code: "EUR", units: 1, nanos: 0 },
        })),
      },
    });
    await expect(client().fetchCostData(ACCOUNT, range)).rejects.toThrow(
      "has more than Infrawrench reads",
    );
    expect(seen).toHaveLength(1000);
  });

  it("refuses a renamed key rather than read a month as free", async () => {
    route = () => ({ body: { items: [], total_count: 3 } });
    await expect(client().fetchCostData(ACCOUNT, range)).rejects.toThrow("is not a list");
  });
});
