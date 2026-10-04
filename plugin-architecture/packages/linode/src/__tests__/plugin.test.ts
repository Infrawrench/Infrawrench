import { evaluateOrphanRule, exportResourcesToTerraform } from "@infrawrench/plugin-base";
import { describe, expect, it, vi } from "vitest";
import type { LinodeApi } from "../api.js";
import { executeCommand } from "../actions.js";
import { firewallRulesFromForm, recordBody } from "../create.js";
import { creditsFromAccount } from "../credits.js";
import { estimateFromCatalog, sizePricing } from "../estimate.js";
import {
  mapDomainRecord,
  mapLinode,
  mapNodeBalancer,
  mapReservedIp,
  mapVolume,
} from "../listers.js";
import { fetchLinodeMetrics, monthsInWindow } from "../metrics.js";
import { plugin } from "../plugin.js";
import type { PriceCatalog } from "../pricing.js";
import { parseStatusFeed, regionFromComponent } from "../status-feed.js";
import { applyUpdate } from "../update.js";

const type = (id: string) => plugin.resourceTypes.find((t) => t.id === id)!;

const catalog: PriceCatalog = {
  linodeTypes: [
    {
      id: "g6-standard-2",
      label: "Linode 4GB",
      class: "standard",
      vcpus: 2,
      memory: 4096,
      disk: 81920,
      price: { hourly: 0.036, monthly: 24 },
      region_prices: [{ id: "id-cgk", hourly: 0.043, monthly: 28.8 }],
      addons: {
        backups: {
          price: { hourly: 0.008, monthly: 5 },
          region_prices: [{ id: "id-cgk", hourly: 0.009, monthly: 6 }],
        },
      },
    },
  ],
  volumeTypes: [
    {
      id: "volume",
      price: { hourly: 0.00015, monthly: 0.1 },
      region_prices: [{ id: "br-gru", hourly: 0.00021, monthly: 0.14 }],
    },
  ],
  nodeBalancerTypes: [{ id: "nodebalancer", price: { hourly: 0.015, monthly: 10 } }],
  lkeTypes: [{ id: "lke-ha", price: { hourly: 0.09, monthly: 60 } }],
  objectStorageTypes: [{ id: "objectstorage", price: { hourly: 0.0075, monthly: 5 } }],
  transferPrices: [],
  reservedIpTypes: [{ id: "reserved-ipv4", price: { hourly: 0.0068, monthly: null } }],
  databaseTypes: [
    {
      id: "g6-standard-2",
      engines: {
        mysql: [
          { quantity: 1, price: { hourly: 0.0975, monthly: 65 } },
          { quantity: 3, price: { hourly: 0.2925, monthly: 195 } },
        ],
        postgresql: [{ quantity: 3, price: { hourly: 0.3, monthly: 200 } }],
      },
    },
  ],
};

describe("estimateFromCatalog", () => {
  it("prices a Linode with backups at the regional rate", () => {
    const e = estimateFromCatalog(catalog, "linode", {
      type: "g6-standard-2",
      region: "id-cgk",
      backupsEnabled: "true",
    });
    expect(e?.monthlyAmount).toBeCloseTo(34.8);
    expect(e?.lineItems).toHaveLength(2);
  });
  it("prices volumes per GB, LKE nodes plus HA, and databases per cluster size", () => {
    expect(
      estimateFromCatalog(catalog, "volume", { sizeGb: "100", region: "br-gru" })?.monthlyAmount,
    ).toBeCloseTo(14);
    expect(
      estimateFromCatalog(catalog, "lke-cluster", {
        nodeType: "g6-standard-2",
        nodeCount: "3",
        highAvailability: "true",
      })?.monthlyAmount,
    ).toBeCloseTo(132);
    expect(
      estimateFromCatalog(catalog, "database", {
        type: "g6-standard-2",
        engineVersion: "postgresql/16",
        clusterSize: "3",
      })?.monthlyAmount,
    ).toBeCloseTo(200);
    expect(estimateFromCatalog(catalog, "reserved-ip", {})?.monthlyAmount).toBeCloseTo(
      0.0068 * 730,
      1,
    );
  });
  it("returns null, never $0, for something it cannot price", () => {
    expect(estimateFromCatalog(catalog, "linode", { type: "g9-unknown" })).toBeNull();
    expect(estimateFromCatalog(catalog, "firewall", {})).toBeNull();
  });
  it("quotes plan prices per region for the size picker", () => {
    expect(sizePricing(catalog, "id-cgk", ["g6-standard-2", "nope"])).toEqual({
      "g6-standard-2": 28.8,
    });
  });
});

describe("credits", () => {
  it("reports each promotion with its expiry, and a negative balance as account credit", () => {
    const pots = creditsFromAccount({
      balance: -20,
      active_promotions: [
        {
          summary: "$100 promotional credit",
          credit_remaining: "73.50",
          expire_dt: "2026-12-01T00:00:00",
        },
      ],
    });
    expect(pots).toEqual([
      {
        key: "promo:100-promotional-credit:2026-12-01",
        label: "$100 promotional credit",
        remaining: 73.5,
        currency: "USD",
        expiresAt: "2026-12-01T00:00:00Z",
      },
      { key: "account-credit", label: "Account credit", remaining: 20, currency: "USD" },
    ]);
  });
  it("reports nothing when there is no pot", () => {
    expect(creditsFromAccount({ balance: 12 })).toEqual([]);
  });
});

describe("orphan rules", () => {
  it("flags a powered-off Linode outside LKE, but not a worker node or a running one", () => {
    const rule = type("linode").orphanRule;
    const off = mapLinode(
      { id: 1, status: "offline", type: "g6-standard-2", region: "us-east" },
      "a",
      [],
    );
    const lkeOff = mapLinode({ id: 2, status: "offline", lke_cluster_id: 5 }, "a", []);
    const on = mapLinode({ id: 3, status: "running" }, "a", []);
    expect(evaluateOrphanRule(rule, off.fields)).not.toBeNull();
    expect(evaluateOrphanRule(rule, lkeOff.fields)).toBeNull();
    expect(evaluateOrphanRule(rule, on.fields)).toBeNull();
  });
  it("flags a detached volume", () => {
    const rule = type("volume").orphanRule;
    expect(
      evaluateOrphanRule(rule, mapVolume({ id: 1, linode_id: null }, "a").fields),
    ).not.toBeNull();
    expect(evaluateOrphanRule(rule, mapVolume({ id: 1, linode_id: 9 }, "a").fields)).toBeNull();
  });
  it("flags a NodeBalancer with no backends, and stays quiet when its configs could not be read", () => {
    const rule = type("nodebalancer").orphanRule;
    expect(evaluateOrphanRule(rule, mapNodeBalancer({ id: 1 }, "a", [], []).fields)).not.toBeNull();
    expect(
      evaluateOrphanRule(
        rule,
        mapNodeBalancer({ id: 1 }, "a", [{ id: 1, nodes_status: { up: 2, down: 0 } }], []).fields,
      ),
    ).toBeNull();
    expect(evaluateOrphanRule(rule, mapNodeBalancer({ id: 1 }, "a", null, null).fields)).toBeNull();
  });
  it("flags an unassigned reserved IP", () => {
    const rule = type("reserved-ip").orphanRule;
    expect(
      evaluateOrphanRule(
        rule,
        mapReservedIp({ address: "203.0.113.5", region: "us-east" }, "a").fields,
      ),
    ).not.toBeNull();
    expect(
      evaluateOrphanRule(
        rule,
        mapReservedIp({ address: "203.0.113.5", assigned_entity: { id: 4, type: "linode" } }, "a")
          .fields,
      ),
    ).toBeNull();
  });
});

describe("listers", () => {
  it("splits a Linode's public and private addresses and leaves firewallIds absent when the read failed", () => {
    const r = mapLinode(
      {
        id: 7,
        ipv4: ["192.168.130.4", "198.51.100.7"],
        ipv6: "2600:3c00::1/128",
        specs: { disk: 81920, vcpus: 2 },
      },
      "acct",
      null,
    );
    expect(r.resolvedOutputs).toMatchObject({
      ipv4: "198.51.100.7",
      ipv4Private: "192.168.130.4",
      ipv6: "2600:3c00::1",
    });
    expect(r.fields["diskGb"]).toBe(80);
    expect("firewallIds" in r.fields).toBe(false);
  });
  it("names the apex record @ and keys records by domain and record id", () => {
    const r = mapDomainRecord(
      { id: 9, type: "A", name: "", target: "198.51.100.7" },
      { id: 3, domain: "example.com" },
      "acct",
    );
    expect(r.externalId).toBe("3/9");
    expect(r.fields["name"]).toBe("@");
    expect(r.parentResourceId).toBe("acct:domain:3");
  });
});

describe("forms", () => {
  it("turns @ back into the empty apex name and only sends type-specific fields", () => {
    expect(recordBody({ type: "A", name: "@", target: "1.2.3.4", ttlSec: "300" })).toEqual({
      type: "A",
      name: "",
      target: "1.2.3.4",
      ttl_sec: 300,
    });
    expect(
      recordBody({ type: "MX", name: "", target: "mail.example.com", priority: "5" }),
    ).toMatchObject({ priority: 5 });
  });
  it("builds firewall rules from the create toggles", () => {
    const rules = firewallRulesFromForm({
      inboundPolicy: "DROP",
      outboundPolicy: "ACCEPT",
      allowSsh: "true",
      allowWeb: "true",
      allowPing: "false",
    });
    expect(rules.inbound.map((r) => r["ports"])).toEqual(["22", "80,443"]);
    expect(rules.inbound_policy).toBe("DROP");
  });
});

function recordingApi(responses: Record<string, unknown> = {}) {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  const api: LinodeApi = {
    async get<T>(path: string) {
      calls.push({ method: "GET", path });
      return (responses[path] ?? {}) as T;
    },
    async send<T>(method: "POST" | "PUT" | "DELETE", path: string, body?: unknown) {
      calls.push({ method, path, body });
      return {} as T;
    },
    async all<T>(path: string) {
      calls.push({ method: "GET", path });
      return ((responses[path] as T[]) ?? []) as T[];
    },
    async monitor<T>() {
      return {} as T;
    },
  };
  return { api, calls };
}

describe("updates and actions", () => {
  it("resizes through the resize action, and refuses for an LKE node", async () => {
    const { api, calls } = recordingApi({ "/linode/instances/5": { type: "g6-standard-4" } });
    await applyUpdate(api, "linode", "acct:linode:5", { type: "g6-standard-2" });
    expect(calls.at(-1)).toMatchObject({
      method: "POST",
      path: "/linode/instances/5/resize",
      body: { type: "g6-standard-2" },
    });
    const lke = recordingApi({
      "/linode/instances/6": { type: "g6-standard-4", lke_cluster_id: 3 },
    });
    await expect(
      applyUpdate(lke.api, "linode", "acct:linode:6", { type: "g6-standard-2" }),
    ).rejects.toThrow(/node pool/);
  });
  it("refuses to shrink a volume", async () => {
    const { api } = recordingApi({ "/volumes/1": { size: 100 } });
    await expect(applyUpdate(api, "volume", "acct:volume:1", { sizeGb: "50" })).rejects.toThrow(
      /only grow/,
    );
  });
  it("adds a firewall rule while keeping the existing ones and the policies", async () => {
    const existing = {
      inbound: [{ label: "ssh", action: "ACCEPT", protocol: "TCP", ports: "22" }],
      outbound: [],
      inbound_policy: "DROP",
      outbound_policy: "ACCEPT",
    };
    const { api, calls } = recordingApi({ "/networking/firewalls/8/rules": existing });
    await executeCommand(api, "firewall", "acct:firewall:8", "add-rule", [
      JSON.stringify({ direction: "inbound", protocol: "TCP", ports: "443" }),
    ]);
    const put = calls.find((c) => c.method === "PUT")!;
    expect(put.path).toBe("/networking/firewalls/8/rules");
    const body = put.body as { inbound: unknown[]; inbound_policy: string };
    expect(body.inbound).toHaveLength(2);
    expect(body.inbound_policy).toBe("DROP");
  });
});

describe("metrics", () => {
  it("divides per-core CPU by the vCPU count", async () => {
    const now = Date.now();
    const { api } = recordingApi({
      "/linode/instances/5/stats": {
        cpu: [[now - 60_000, 300]],
        netv4: { in: [[now - 60_000, 1000]] },
      },
      "/linode/instances/5": { specs: { vcpus: 4 } },
    });
    const series = await fetchLinodeMetrics(api, "5");
    expect(series.find((s) => s.label === "CPU Utilization")?.points[0]?.value).toBe(75);
    expect(series.find((s) => s.label === "Public In (IPv4)")).toBeDefined();
  });
  it("lists the months a long window touches", () => {
    expect(
      monthsInWindow(Date.parse("2026-08-20T00:00:00Z"), Date.parse("2026-10-02T00:00:00Z")),
    ).toEqual([
      { year: 2026, month: 8 },
      { year: 2026, month: 9 },
      { year: 2026, month: 10 },
    ]);
  });
  it("declares metrics exactly where it fetches them", () => {
    const withMetrics = plugin.resourceTypes.filter((t) => t.supportsMetrics).map((t) => t.id);
    expect(withMetrics.sort()).toEqual(["database", "linode", "nodebalancer"]);
  });
});

describe("status feed", () => {
  it.each([
    ["US-East (Newark) Block Storage", "us-east"],
    ["AP-Northeast-2 (Tokyo 2)", "ap-northeast"],
    ["IN-BOM-2 (Mumbai 2) NodeBalancers", "in-bom-2"],
    ["Cloud Manager and API", null],
  ])("reads the region out of %s", (name, region) => {
    expect(regionFromComponent(name)).toBe(region);
  });
  it("maps a product component onto its resource types and region", () => {
    const body = JSON.stringify({
      incidents: [
        {
          id: "i1",
          name: "Block Storage degraded",
          status: "investigating",
          impact: "minor",
          created_at: "2026-10-01T10:00:00Z",
          updated_at: "2026-10-01T10:05:00Z",
          shortlink: "https://stspg.io/x",
          components: [{ id: "c1", name: "US-East (Newark) Block Storage" }],
          incident_updates: [],
        },
      ],
    });
    const [incident] = parseStatusFeed(body);
    expect(JSON.stringify(incident)).toContain('"volume"');
    expect(JSON.stringify(incident)).toContain('"us-east"');
  });
});

describe("terraform export", () => {
  it("maps a Linode, a volume and a DNS record with import ids", () => {
    const linode = mapLinode(
      {
        id: 5,
        label: "web",
        type: "g6-standard-2",
        region: "us-east",
        image: "linode/ubuntu24.04",
        tags: ["prod"],
      },
      "a",
      [],
    );
    const volume = mapVolume(
      { id: 9, label: "data", size: 50, region: "us-east", linode_id: 5 },
      "a",
    );
    const record = mapDomainRecord(
      { id: 2, type: "A", name: "www", target: "198.51.100.7" },
      { id: 3, domain: "example.com" },
      "a",
    );
    const outcome = exportResourcesToTerraform(
      [linode, volume, record],
      () => plugin.terraformExport,
    );
    const hcl = outcome.hcl;
    expect(hcl).toContain('resource "linode_instance"');
    expect(hcl).toContain('resource "linode_volume"');
    expect(hcl).toContain('record_type = "A"');
    expect(hcl).toContain("var.linode_token");
    expect(outcome.unsupported).toHaveLength(0);
  });
});

vi.setConfig({ testTimeout: 10_000 });
