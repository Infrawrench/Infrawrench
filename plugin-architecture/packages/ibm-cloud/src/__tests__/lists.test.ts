import { afterEach, describe, expect, it, vi } from "vitest";
import { hostClient } from "@infrawrench/plugin-base/effect";
import { IbmCloudClient } from "../client.js";
import { TEST_TOKEN, makeClient, type Recorded } from "./helpers.js";

const VPC = { regionHint: "us-south" };
const RANGE = { fromDate: "2026-09-01", toDate: "2026-09-30" } as never;
const COS = "crn:v1:bluemix:public:cloud-object-storage:global:a/acct123:cosguid::";

const count = (calls: Recorded[], path: string) =>
  calls.filter((c) => c.url.pathname === path).length;

const NEXT_VPC = { href: "https://us-south.iaas.cloud.ibm.com/v1/vpcs?start=more" };

describe("VPC lists", () => {
  it("stops at 500 pages of 100 with an error, not a short list", async () => {
    const { client, calls } = makeClient(() => ({
      body: { vpcs: [{ id: "v", name: "n" }], next: NEXT_VPC },
    }));
    await expect(client.listResources("vpc", "a", VPC)).rejects.toThrow(
      "has more than Infrawrench reads",
    );
    expect(count(calls, "/v1/vpcs")).toBe(500);
    expect(calls[0]!.url.searchParams.get("limit")).toBe("100");
  });

  it("refuses a page with its key renamed, first or later", async () => {
    const first = makeClient(() => ({ body: { items: [] } }));
    await expect(first.client.listResources("vpc", "a", VPC)).rejects.toThrow("is not a list");
    const later = makeClient((req) =>
      req.url.searchParams.get("start")
        ? { body: { items: [] } }
        : { body: { vpcs: [{ id: "v", name: "n" }], next: NEXT_VPC } },
    );
    await expect(later.client.listResources("vpc", "a", VPC)).rejects.toThrow("is not a list");
  });

  it("refuses a next link it cannot read a token from", async () => {
    const { client } = makeClient(() => ({
      body: { vpcs: [{ id: "v", name: "n" }], next: { href: "https://x.example/v1/vpcs" } },
    }));
    await expect(client.listResources("vpc", "a", VPC)).rejects.toThrow("is not a list");
  });

  it("never sends the token where a next link points", async () => {
    const { client, calls } = makeClient((req) =>
      req.url.searchParams.get("start")
        ? { body: { vpcs: [] } }
        : {
            body: {
              vpcs: [{ id: "v", name: "n" }],
              next: { href: "https://evil.example/v1/vpcs?start=t" },
            },
          },
    );
    await client.listResources("vpc", "a", VPC);
    expect(calls.every((c) => c.url.host === "us-south.iaas.cloud.ibm.com")).toBe(true);
  });
});

describe("floating IPs behind the server list", () => {
  const instances = { body: { instances: [] } };

  it("reads a refusal as none", async () => {
    const { client } = makeClient((req) =>
      req.url.pathname === "/v1/floating_ips" ? { status: 403, body: {} } : instances,
    );
    await expect(client.listResources("instance", "a", VPC)).resolves.toEqual([]);
  });

  it.each([
    ["a bad page", { body: { items: [] } }, "is not a list"],
    ["a failure", { status: 500, body: { message: "down" } }, "down"],
  ])("does not read %s as none", async (_what, reply, message) => {
    const { client } = makeClient((req) =>
      req.url.pathname === "/v1/floating_ips" ? reply : instances,
    );
    await expect(client.listResources("instance", "a", VPC)).rejects.toThrow(message);
  });
});

describe("the region list", () => {
  const regions = (reply: object) =>
    makeClient(
      (req) => (req.url.pathname === "/v1/regions" ? { body: reply } : { body: { vpcs: [] } }),
      { regions: "" },
    );

  it("does not read a bad page as the home region alone", async () => {
    await expect(regions({ items: [] }).client.listResources("vpc", "a")).rejects.toThrow(
      "is not a list",
    );
    await expect(regions({ items: [] }).client.listResources("account", "a")).rejects.toThrow(
      "is not a list",
    );
  });

  it("scans the whole table when the list is empty", async () => {
    const { client, calls } = regions({ regions: [] });
    await client.listResources("vpc", "a");
    expect(calls.some((c) => c.url.host === "eu-de.iaas.cloud.ibm.com")).toBe(true);
  });
});

describe("Code Engine lists", () => {
  it("stops at 500 pages with an error", async () => {
    const { client, calls } = makeClient(() => ({
      body: { limit: 100, projects: [{ id: "p", name: "n" }], next: { start: "more" } },
    }));
    await expect(client.listResources("code-engine-project", "a", VPC)).rejects.toThrow(
      "has more than Infrawrench reads",
    );
    expect(count(calls, "/v2/projects")).toBe(500);
  });

  it("refuses a page with its key renamed, for projects and for apps", async () => {
    const first = makeClient(() => ({ body: { items: [] } }));
    await expect(first.client.listResources("code-engine-project", "a", VPC)).rejects.toThrow(
      "is not a list",
    );
    const apps = makeClient((req) =>
      req.url.pathname === "/v2/projects"
        ? { body: { projects: [{ id: "p", name: "n" }] } }
        : { body: { items: [] } },
    );
    await expect(apps.client.listResources("code-engine-app", "a", VPC)).rejects.toThrow(
      "is not a list",
    );
  });

  it("reads the token from next.href when next has no start", async () => {
    const { client, calls } = makeClient((req) =>
      req.url.searchParams.get("start")
        ? { body: { projects: [{ id: "q", name: "m" }] } }
        : {
            body: {
              projects: [{ id: "p", name: "n" }],
              next: { href: "https://x.example/v2/projects?limit=100&start=tok" },
            },
          },
    );
    const list = await client.listResources("code-engine-project", "a", VPC);
    expect(list).toHaveLength(2);
    expect(calls[1]!.url.searchParams.get("start")).toBe("tok");
    expect(calls[1]!.url.host).toBe("api.us-south.codeengine.cloud.ibm.com");
  });
});

describe("Resource Controller lists", () => {
  it("stops at 500 pages with an error", async () => {
    const { client, calls } = makeClient(() => ({
      body: { resources: [], next_url: "/v2/resource_instances?start=more" },
    }));
    await expect(client.listResources("service-instance", "a")).rejects.toThrow(
      "has more than Infrawrench reads",
    );
    expect(count(calls, "/v2/resource_instances")).toBe(500);
  });

  it("refuses a page with its key renamed, first or later", async () => {
    const first = makeClient(() => ({ body: { items: [], next_url: null } }));
    await expect(first.client.listResources("service-instance", "a")).rejects.toThrow(
      "is not a list",
    );
    const later = makeClient((req) =>
      req.url.searchParams.get("start")
        ? { body: { items: [] } }
        : { body: { resources: [], next_url: "/v2/resource_instances?start=2" } },
    );
    await expect(later.client.listResources("service-instance", "a")).rejects.toThrow(
      "is not a list",
    );
  });

  it("follows a next link on its own host, written either way", async () => {
    const { client, calls } = makeClient((req) => {
      const start = req.url.searchParams.get("start");
      if (!start) return { body: { resources: [], next_url: "/v2/resource_instances?start=2" } };
      if (start === "2") {
        return {
          body: {
            resources: [],
            next_url: "https://resource-controller.cloud.ibm.com/v2/resource_instances?start=3",
          },
        };
      }
      return { body: { resources: [], next_url: null } };
    });
    await client.listResources("service-instance", "a");
    expect(calls.map((c) => c.url.searchParams.get("start"))).toEqual([null, "2", "3"]);
  });

  it("refuses a next link to another host, through every list that reads it", async () => {
    for (const typeId of ["service-instance", "database", "cos-bucket"]) {
      const { client, calls } = makeClient((req) =>
        req.url.host === "evil.example"
          ? { body: { resources: [] } }
          : { body: { resources: [], next_url: "https://evil.example/steal" } },
      );
      await expect(client.listResources(typeId, "a")).rejects.toThrow(
        "Refusing to send the account's credentials there",
      );
      expect(calls.some((c) => c.url.host === "evil.example")).toBe(false);
    }
  });
});

describe("resource groups", () => {
  it("refuses a page with its key renamed", async () => {
    const { client } = makeClient(() => ({ body: { items: [] } }));
    await expect(client.listResources("resource-group", "a")).rejects.toThrow("is not a list");
  });
});

describe("Kubernetes Service lists", () => {
  it("refuses an answer that is not an array, for clusters and for pools", async () => {
    const clusters = makeClient(() => ({ body: { message: "wrapped" } }));
    await expect(clusters.client.listResources("kubernetes-cluster", "a")).rejects.toThrow(
      "is not a list",
    );
    const classic = makeClient((req) =>
      req.url.pathname.includes("/classic/") ? { body: { message: "wrapped" } } : { body: [] },
    );
    await expect(classic.client.listResources("kubernetes-cluster", "a")).rejects.toThrow(
      "is not a list",
    );
    const pools = makeClient((req) =>
      req.url.pathname.includes("getWorkerPools")
        ? { body: { message: "wrapped" } }
        : req.url.pathname.includes("/vpc/")
          ? { body: [{ id: "c", name: "n" }] }
          : { body: [] },
    );
    await expect(pools.client.listResources("worker-pool", "a")).rejects.toThrow("is not a list");
  });

  it("still reads null as no clusters", async () => {
    const { client } = makeClient(() => ({ raw: "null" }));
    await expect(client.listResources("kubernetes-cluster", "a")).resolves.toEqual([]);
  });
});

describe("usage reports", () => {
  it("stops at 250 pages of 200 with an error", async () => {
    const { client, calls } = makeClient(() => ({
      body: { resources: [], next: { offset: "more" } },
    }));
    await expect(client.fetchCostData("a", RANGE)).rejects.toThrow(
      "has more than Infrawrench reads",
    );
    expect(calls).toHaveLength(250);
    expect(calls[0]!.url.searchParams.get("_limit")).toBe("200");
  });

  it("refuses a page with its key renamed, first or later", async () => {
    const first = makeClient(() => ({ body: { items: [] } }));
    await expect(first.client.fetchCostData("a", RANGE)).rejects.toThrow("is not a list");
    const later = makeClient((req) =>
      req.url.searchParams.get("_start")
        ? { body: { items: [], count: 3 } }
        : { body: { resources: [], next: { offset: "2" } } },
    );
    await expect(later.client.fetchCostData("a", RANGE)).rejects.toThrow("is not a list");
  });

  it("reads a month that says it has no records as empty", async () => {
    const { client } = makeClient(() => ({ body: { limit: 200, count: 0 } }));
    await expect(client.fetchCostData("a", RANGE)).resolves.toEqual([]);
  });

  it("reads the offset from next.href when next has no offset", async () => {
    const { client, calls } = makeClient((req) =>
      req.url.searchParams.get("_start")
        ? { body: { resources: [] } }
        : { body: { resources: [], next: { href: "/v4/accounts/x?_limit=200&_start=tok" } } },
    );
    await client.fetchCostData("a", RANGE);
    expect(calls[1]!.url.searchParams.get("_start")).toBe("tok");
  });
});

describe("Object Storage bucket listing", () => {
  const withListing = (raw: string) =>
    makeClient((req) =>
      req.url.pathname === "/v2/resource_instances"
        ? { body: { resources: [{ id: COS, crn: COS, guid: "cosguid", name: "cos" }] } }
        : req.url.host.startsWith("s3.")
          ? { raw }
          : { body: {} },
    );

  it("refuses an answer that is not a listing", async () => {
    const { client } = withListing("<html>sign in</html>");
    await expect(client.listResources("cos-bucket", "a")).rejects.toThrow("is not a list");
  });

  it("refuses a listing that says it is cut short", async () => {
    const { client } = withListing(
      "<ListAllMyBucketsResult><IsTruncated>true</IsTruncated><Buckets></Buckets></ListAllMyBucketsResult>",
    );
    await expect(client.listResources("cos-bucket", "a")).rejects.toThrow(
      "has more than Infrawrench reads",
    );
  });

  it("reads a listing that says it is complete", async () => {
    const { client } = withListing(
      "<ListAllMyBucketsResult><IsTruncated>false</IsTruncated><Buckets><Bucket><Name>b</Name><LocationConstraint>us-south-smart</LocationConstraint></Bucket></Buckets></ListAllMyBucketsResult>",
    );
    await expect(client.listResources("cos-bucket", "a")).resolves.toHaveLength(1);
  });
});

describe("Object Storage objects", () => {
  const page = (keys: string[], token: string) =>
    `<ListBucketResult><IsTruncated>${token ? "true" : "false"}</IsTruncated>${token ? `<NextContinuationToken>${token}</NextContinuationToken>` : ""}${keys
      .map((k) => `<Contents><Key>${k}</Key><Size>1</Size></Contents>`)
      .join("")}</ListBucketResult>`;

  it("stops a browse at 50 pages of 1,000 with an error", async () => {
    const { client, calls } = makeClient(() => ({ raw: page(["k"], "more") }));
    await expect(client.listStorageObjects!("us-south/b", "")).rejects.toThrow(
      "has more than Infrawrench reads",
    );
    expect(calls).toHaveLength(50);
    expect(calls[0]!.url.searchParams.get("max-keys")).toBe("1000");
  });

  it("refuses to read an answer that is not a listing as an empty folder", async () => {
    const { client } = makeClient(() => ({ raw: "<html>sign in</html>" }));
    await expect(client.listStorageObjects!("us-south/b", "")).rejects.toThrow("is not a list");
  });

  it("refuses a page that says there is more and gives no token", async () => {
    const { client } = makeClient(() => ({
      raw: "<ListBucketResult><IsTruncated>true</IsTruncated></ListBucketResult>",
    }));
    await expect(client.listStorageObjects!("us-south/b", "")).rejects.toThrow("is not a list");
  });

  it("sends the next token as it means, not as XML wrote it", async () => {
    const { client, calls } = makeClient((req) =>
      req.url.searchParams.get("continuation-token")
        ? { raw: page([], "") }
        : { raw: page(["k"], "a&amp;b") },
    );
    await client.listStorageObjects!("us-south/b", "");
    expect(calls[1]!.url.searchParams.get("continuation-token")).toBe("a&b");
  });

  it("deletes nothing from a folder it cannot read to the end", async () => {
    const { client, calls } = makeClient((req) =>
      req.method === "GET" ? { raw: page(["dir/k"], "more") } : { body: {} },
    );
    await expect(client.deleteStorageObject!("us-south/b", "dir/")).rejects.toThrow(
      "has more than Infrawrench reads",
    );
    expect(calls.filter((c) => c.method === "GET")).toHaveLength(100);
    expect(calls.filter((c) => c.method === "DELETE")).toHaveLength(0);
  });

  it("does not report a folder deleted on an answer that is not a listing", async () => {
    const { client, calls } = makeClient((req) =>
      req.method === "GET" ? { raw: "<html>sign in</html>" } : { body: {} },
    );
    await expect(client.deleteStorageObject!("us-south/b", "dir/")).rejects.toThrow(
      "is not a list",
    );
    expect(calls.filter((c) => c.method === "DELETE")).toHaveLength(0);
  });

  it("deletes every key of a folder across pages", async () => {
    const { client, calls } = makeClient((req) => {
      if (req.method !== "GET") return { body: {} };
      return req.url.searchParams.get("continuation-token")
        ? { raw: page(["dir/b"], "") }
        : { raw: page(["dir/a"], "more") };
    });
    await client.deleteStorageObject!("us-south/b", "dir/");
    expect(
      calls
        .filter((c) => c.method === "DELETE")
        .map((c) => c.url.pathname)
        .sort(),
    ).toEqual(["/b/dir/", "/b/dir/a", "/b/dir/b"]);
  });
});

describe("host HTTP", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends everything through the host, with no CA unless one is set", async () => {
    const fetchStub = vi.fn(() => {
      throw new Error("fetch must not be called");
    });
    vi.stubGlobal("fetch", fetchStub);
    const request = vi.fn(async (req: { url: string }) => ({
      status: 200,
      headers: {},
      body: req.url.includes("/identity/token")
        ? JSON.stringify({ access_token: TEST_TOKEN, expires_in: 3600 })
        : JSON.stringify({ vpcs: [] }),
    }));
    const client = hostClient(
      new IbmCloudClient({ apiKey: "k", region: "us-south", regions: "us-south" }, {
        http: { request },
      } as never),
    );
    await client.listResources("vpc", "a");
    expect(request).toHaveBeenCalledTimes(2);
    for (const [req] of request.mock.calls) expect(req).not.toHaveProperty("caCert");
    expect(fetchStub).not.toHaveBeenCalled();
  });
});
