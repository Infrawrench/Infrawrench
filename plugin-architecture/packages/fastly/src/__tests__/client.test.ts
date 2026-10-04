import { describe, expect, it } from "vitest";
import { FastlyClient, parseKeys, purgePathFor } from "../client.js";
import { evaluate, scopesOf } from "../preflight.js";
import { parseStatusFeed } from "../status-feed.js";
import { serviceSeriesFrom, totalsOf } from "../metrics.js";
import { makeHttp } from "./helpers.js";

const ACCOUNT = "acc1";

const DETAIL = {
  id: "SU1",
  name: "www",
  type: "vcl",
  versions: [
    { number: 1, active: false, locked: true },
    { number: 2, active: true, locked: true },
    { number: 3, active: false },
  ],
  active_version: {
    number: 2,
    domains: [{ name: "www.example.com", version: 2 }],
    backends: [
      {
        name: "origin",
        address: "origin.example.com",
        port: 443,
        use_ssl: true,
        ssl_check_cert: false,
      },
    ],
  },
};

function route(url: URL, method: string) {
  const p = url.pathname;
  if (p === "/service" && method === "GET") {
    return {
      body: url.searchParams.get("page") === "1" ? [{ id: "SU1", name: "www", version: 2 }] : [],
    };
  }
  if (p === "/service/SU1/details") return { body: DETAIL };
  if (p.startsWith("/enabled-products/v1/")) {
    return p.includes("image_optimizer")
      ? { body: { services: ["SU1"] } }
      : { status: 400, body: {} };
  }
  if (p === "/service/SU1/version/2/logging/s3") {
    return { body: [{ name: "archive", bucket_name: "logs", path: "/fastly/", format: "%h" }] };
  }
  if (p.startsWith("/service/SU1/version/2/logging/")) return { body: [] };
  if (p === "/purge/www.example.com/a") return { body: { status: "ok", id: "p1" } };
  if (p === "/service/SU1/purge_all") return { body: { status: "ok" } };
  if (p === "/service/SU1/purge") return { body: {} };
  if (p === "/service/SU1/version/3/activate") return { body: { number: 3, active: true } };
  if (p === "/tokens/self") return { body: { id: "tok-self", scope: "global" } };
  if (p === "/tokens/tok-self" || p === "/tokens/tok-other") return { status: 204 };
  if (p === "/resources/stores/config/cs1/items") {
    return { body: [{ item_key: "b" }, { item_key: "a" }, { item_key: "other" }] };
  }
  if (p === "/resources/stores/config/cs1/item/a") return { body: { item_value: "1" } };
  return { status: 404, body: { msg: "Not found" } };
}

function client() {
  const { http, calls } = makeHttp(route);
  return { c: new FastlyClient({ apiToken: "test-token" }, { http } as never), calls };
}

describe("listing", () => {
  it("maps services with products, versions, domains, backends and logging", async () => {
    const { c } = client();
    const [svc] = await c.listResources("service", ACCOUNT);
    expect(svc?.fields).toMatchObject({
      activeVersion: 2,
      latestVersion: 3,
      domains: "www.example.com",
      products: "Image Optimizer",
    });
    const versions = await c.listResources("service-version", ACCOUNT);
    expect(versions.map((v) => v.externalId)).toEqual(["SU1/1", "SU1/2", "SU1/3"]);
    expect(versions[0]?.parentResourceId).toBe(`${ACCOUNT}:service:SU1`);
    const [backend] = await c.listResources("backend", ACCOUNT);
    expect(backend?.fields).toMatchObject({ useSsl: true, sslCheckCert: false });
    const logging = await c.listResources("logging-endpoint", ACCOUNT);
    expect(logging).toHaveLength(1);
    expect(logging[0]?.fields).toMatchObject({
      kind: "Amazon S3",
      destination: "logs/fastly/",
    });
  });

  it("pages config store items client-side by prefix", async () => {
    const { c } = client();
    const page = await c.listKvKeys("config-store", `${ACCOUNT}:config-store:cs1`, ACCOUNT, {
      limit: 1,
    });
    expect(page).toEqual({ items: [{ name: "a" }], nextCursor: "1" });
    expect(await c.getKvValue("config-store", `${ACCOUNT}:config-store:cs1`, ACCOUNT, "a")).toBe(
      "1",
    );
  });
});

describe("purges and versions", () => {
  it("purges a URL without its scheme, softly when asked", async () => {
    const { c, calls } = client();
    await c.executeNoSqlCommand("service", `${ACCOUNT}:service:SU1`, ACCOUNT, "purge-url", [
      JSON.stringify({ url: "https://www.example.com/a", soft: "soft" }),
    ]);
    const call = calls.find((x) => x.url.pathname.startsWith("/purge/"));
    expect(call?.method).toBe("POST");
    expect(call?.headers["Fastly-Soft-Purge"]).toBe("1");
  });

  it("batches several surrogate keys into one request", async () => {
    const { c, calls } = client();
    await c.executeNoSqlCommand("service", `${ACCOUNT}:service:SU1`, ACCOUNT, "purge-keys", [
      JSON.stringify({ keys: "product-1, product-2,product-1" }),
    ]);
    const call = calls.find((x) => x.url.pathname === "/service/SU1/purge");
    expect(JSON.parse(call?.body ?? "{}")).toEqual({ surrogate_keys: ["product-1", "product-2"] });
  });

  it("purges everything and activates a version", async () => {
    const { c, calls } = client();
    await c.invokeAction("service", `${ACCOUNT}:service:SU1`, "purge-all", ACCOUNT);
    await c.executeNoSqlCommand("service", `${ACCOUNT}:service:SU1`, ACCOUNT, "activate-version", [
      JSON.stringify({ version: "3" }),
    ]);
    expect(calls.map((x) => `${x.method} ${x.url.pathname}`)).toEqual([
      "POST /service/SU1/purge_all",
      "PUT /service/SU1/version/3/activate",
    ]);
  });

  it("refuses to revoke the account's own token", async () => {
    const { c } = client();
    await expect(
      c.invokeAction("api-token", `${ACCOUNT}:api-token:tok-self`, "revoke", ACCOUNT),
    ).rejects.toThrow(/this account uses/);
    await expect(
      c.invokeAction("api-token", `${ACCOUNT}:api-token:tok-other`, "revoke", ACCOUNT),
    ).resolves.toBeUndefined();
  });

  it("normalises purge input", () => {
    expect(purgePathFor("www.example.com/a?b=1")).toBe("www.example.com/a?b=1");
    expect(() => purgePathFor(" ")).toThrow();
    expect(parseKeys("a b,,c a")).toEqual(["a", "b", "c"]);
  });
});

describe("preflight", () => {
  it("reads scope and role together", () => {
    const byId = (checks: ReturnType<typeof evaluate>) =>
      Object.fromEntries(checks.map((c) => [c.capabilityId, c.status]));
    expect(byId(evaluate(scopesOf("global:read"), "billing"))).toEqual({
      inventory: "ok",
      costs: "ok",
      purge: "missing",
      manage: "missing",
    });
    expect(byId(evaluate(scopesOf("purge_select"), "engineer"))).toEqual({
      inventory: "missing",
      costs: "missing",
      purge: "missing",
      manage: "missing",
    });
    expect(byId(evaluate(scopesOf("global"), "superuser"))).toEqual({
      inventory: "ok",
      costs: "ok",
      purge: "ok",
      manage: "ok",
    });
  });
});

describe("metrics", () => {
  it("computes hit ratio from hits and misses and adds product series only when used", () => {
    const rows = [
      { start_time: 1, requests: 10, hits: 3, miss: 1, status_5xx: 2, bandwidth: 100 },
      { start_time: 2, requests: 20, hits: 1, miss: 3, bandwidth: 50 },
    ];
    const totals = totalsOf(rows);
    expect(totals).toMatchObject({ requests: 30, bandwidth: 150, hitRatio: 50, status5xx: 2 });
    const labels = serviceSeriesFrom(rows).map((s) => s.label);
    expect(labels).toContain("Cache hit ratio");
    expect(labels).not.toContain("Compute requests");
    expect(serviceSeriesFrom(rows)[2]?.points[0]).toEqual({ timestamp: 1000, value: 75 });
  });
});

describe("status feed", () => {
  const now = new Date();
  const ago = (h: number) => new Date(now.getTime() - h * 3600_000).toUTCString();
  const item = (guid: string, title: string, description: string, hoursAgo: number) =>
    `<item><title>${title}</title><description>${description}</description><link>https://www.fastlystatus.com/incident/${guid.split("/")[1]}</link><guid isPermaLink="false">${guid}</guid><pubDate>${ago(hoursAgo)}</pubDate></item>`;

  it("groups posts by incident and keeps only unfinished ones", () => {
    const body = `<?xml version="1.0"?><rss version="2.0"><channel>${[
      item("/1/12", "Elevated Errors for Compute", "Engineering has deployed a fix.", 1),
      item("/1/11", "Elevated Errors for Compute", "We are investigating.", 3),
      item(
        "/2/22",
        "Ashburn (IAD) Maintenance",
        "The scheduled maintenance has been completed.",
        2,
      ),
      item("/2/21", "Ashburn (IAD) Maintenance", "Fastly will be performing maintenance.", 5),
      item(
        "/3/31",
        "Retrospective: Impacted Performance in Miami (MIA)",
        "During this incident",
        1,
      ),
      item(
        "/4/41",
        "Data Center Capacity Expansion for Miami (MIA)",
        "Fastly will be adding capacity.",
        1,
      ),
    ].join("")}</channel></rss>`;
    const incidents = parseStatusFeed(body);
    expect(incidents.map((i) => i.externalId).sort()).toEqual(["1", "4"]);
    const compute = incidents.find((i) => i.externalId === "1");
    expect(compute).toMatchObject({ state: "identified", services: ["Compute"] });
    const mia = incidents.find((i) => i.externalId === "4");
    expect(mia).toMatchObject({ impact: "maintenance", services: ["POP MIA"] });
    expect(mia?.providerWide).toBeUndefined();
  });

  it("rejects a non-RSS body", () => {
    expect(() => parseStatusFeed("<html></html>")).toThrow();
  });
});
