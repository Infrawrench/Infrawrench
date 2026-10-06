import type { HostServices } from "@infrawrench/plugin-base";
import { evaluateOrphanRule, exportResourcesToTerraform } from "@infrawrench/plugin-base";
import { describe, expect, it, vi } from "vitest";
import { executeCommand, firewallRuleBody } from "../actions.js";
import { VultrApiError, createVultrApi, statusOf } from "../api.js";
import { planMonthly, sizePricing } from "../catalog.js";
import { connectionString, pemOf, VultrClient } from "../client.js";
import { fetchVultrCostData, itemDays } from "../cost-data.js";
import { bootSource, recordBody } from "../create.js";
import { creditsFromAccount } from "../credits.js";
import { mapBlock, mapInstance, mapReservedIp, openToWorld } from "../listers.js";
import { bandwidthSeries } from "../metrics.js";
import { plugin } from "../plugin.js";
import { parseStatusFeed } from "../status-feed.js";
import { applyUpdate } from "../update.js";

type Call = { url: string; method: string; headers: Record<string, string>; body?: string };

function host(responder: (call: Call) => { status?: number; body: unknown }): {
  services: HostServices;
  calls: Call[];
} {
  const calls: Call[] = [];
  const services: HostServices = {
    http: {
      request: vi.fn(async (req) => {
        const call: Call = {
          url: req.url,
          method: req.method,
          headers: req.headers,
          ...(typeof req.body === "string" ? { body: req.body } : {}),
        };
        calls.push(call);
        const res = responder(call);
        return {
          status: res.status ?? 200,
          headers: {},
          body: typeof res.body === "string" ? res.body : JSON.stringify(res.body),
        };
      }),
    },
  };
  return { services, calls };
}

const type = (id: string) => plugin.resourceTypes.find((t) => t.id === id)!;

describe("api", () => {
  it("sends the key as a bearer token and follows meta.links.next cursors", async () => {
    const { services, calls } = host((c) => {
      const cursor = new URL(c.url).searchParams.get("cursor");
      return cursor
        ? { body: { instances: [{ id: "b" }], meta: { links: { next: "" } } } }
        : { body: { instances: [{ id: "a" }], meta: { links: { next: "abc" } } } };
    });
    const api = createVultrApi({ apiKey: "KEY", services });
    const all = await api.all<{ id: string }>("/instances", "instances");
    expect(all.map((i) => i.id)).toEqual(["a", "b"]);
    expect(calls[0]!.headers["Authorization"]).toBe("Bearer KEY");
    expect(calls[0]!.url).toContain("per_page=500");
    expect(calls[1]!.url).toContain("cursor=abc");
  });

  it("keeps the HTTP status and Vultr's error text on thrown errors", async () => {
    const { services } = host(() => ({
      status: 403,
      body: { error: "Unauthorized IP address", status: 403 },
    }));
    const api = createVultrApi({ apiKey: "KEY", services });
    const err = await api.get("/account").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VultrApiError);
    expect(statusOf(err)).toBe(403);
    expect((err as Error).message).toContain("Unauthorized IP address");
  });
});

describe("mappers", () => {
  it("maps an instance, reading backups/ddos/ipv6 from features", () => {
    const r = mapInstance(
      {
        id: "i1",
        label: "web",
        plan: "vc2-1c-1gb",
        region: "ewr",
        main_ip: "203.0.113.5",
        internal_ip: "10.1.96.3",
        v6_main_ip: "2001:db8::1",
        power_status: "stopped",
        features: ["auto_backups", "ipv6"],
        firewall_group_id: "",
        tags: ["a", "b"],
      },
      "acct",
    );
    expect(r.id).toBe("acct:instance:i1");
    expect(r.fields["backupsEnabled"]).toBe(true);
    expect(r.fields["ddosProtection"]).toBe(false);
    expect(r.fields["tags"]).toBe("a, b");
    expect(r.resolvedOutputs["ipv4Private"]).toBe("10.1.96.3");
    expect(evaluateOrphanRule(type("instance").orphanRule, r.fields)).toMatch(/stopped/);
  });

  it("flags detached volumes and unattached reserved IPs as orphans", () => {
    const vol = mapBlock(
      { id: "v1", size_gb: 50, region: "ewr", attached_to_instance: "" },
      "acct",
    );
    expect(evaluateOrphanRule(type("block-storage").orphanRule, vol.fields)).not.toBeNull();
    const ip = mapReservedIp(
      { id: "r1", region: "ewr", ip_type: "v4", subnet: "198.51.100.7", instance_id: "" },
      "acct",
    );
    expect(ip.resolvedOutputs["ip"]).toBe("198.51.100.7");
    expect(evaluateOrphanRule(type("reserved-ip").orphanRule, ip.fields)).not.toBeNull();
  });

  it("finds firewall ports open to the world other than the web ports", () => {
    expect(
      openToWorld([
        { id: 1, protocol: "tcp", port: "22", subnet: "0.0.0.0", subnet_size: 0 },
        { id: 2, protocol: "tcp", port: "443", subnet: "::", subnet_size: 0 },
        { id: 3, protocol: "icmp", subnet: "0.0.0.0", subnet_size: 0 },
        { id: 4, protocol: "tcp", port: "5432", subnet: "10.0.0.0", subnet_size: 8 },
        {
          id: 5,
          protocol: "tcp",
          port: "80",
          subnet: "0.0.0.0",
          subnet_size: 0,
          source: "cloudflare",
        },
      ]),
    ).toBe("tcp/22");
  });
});

describe("create helpers", () => {
  it("turns image-picker values into the right boot source", () => {
    expect(bootSource("os:2284")).toEqual({ os_id: 2284 });
    expect(bootSource("app:58")).toEqual({ app_id: 58 });
    expect(bootSource("image:wordpress")).toEqual({ image_id: "wordpress" });
    expect(bootSource("snapshot:abc")).toEqual({ snapshot_id: "abc" });
    expect(() => bootSource("")).toThrow();
  });

  it("builds DNS record bodies with the apex as an empty name", () => {
    expect(
      recordBody({ type: "MX", name: "@", data: "mail.example.com", priority: "5", ttl: "300" }),
    ).toEqual({
      type: "MX",
      name: "",
      data: "mail.example.com",
      ttl: 300,
      priority: 5,
    });
  });

  it("builds firewall rules from the prompt", () => {
    expect(
      firewallRuleBody({
        ipType: "v4",
        protocol: "tcp",
        port: "22",
        source: "cidr",
        cidr: "203.0.113.4",
      }),
    ).toEqual({
      ip_type: "v4",
      protocol: "tcp",
      subnet: "203.0.113.4",
      subnet_size: 32,
      port: "22",
    });
    expect(
      firewallRuleBody({ ipType: "v6", protocol: "icmp", source: "cloudflare" }),
    ).toMatchObject({
      subnet: "::",
      source: "cloudflare",
    });
  });
});

describe("client", () => {
  it("uploads an SSH key once and passes its id when creating an instance", async () => {
    const { services, calls } = host((c) => {
      if (c.url.includes("/ssh-keys") && c.method === "GET")
        return {
          body: {
            ssh_keys: [{ id: "k-old", ssh_key: "ssh-ed25519 AAAA other" }],
            meta: { links: { next: "" } },
          },
        };
      if (c.url.endsWith("/ssh-keys")) return { body: { ssh_key: { id: "k-new" } } };
      if (c.url.endsWith("/instances"))
        return { status: 202, body: { instance: { id: "i9", label: "x" } } };
      return { body: {} };
    });
    const client = new VultrClient({ apiKey: "K" }, plugin.resourceTypes, services);
    const created = await client.createResource("instance", "acct", {
      label: "x",
      region: "ewr",
      plan: "vc2-1c-1gb",
      image: "os:2284",
      sshPublicKey: "ssh-ed25519 BBBB me@laptop",
      tags: "a, b",
    });
    expect(created.id).toBe("acct:instance:i9");
    const create = calls.find((c) => c.url.endsWith("/instances") && c.method === "POST")!;
    const body = JSON.parse(create.body!);
    expect(body).toMatchObject({
      os_id: 2284,
      sshkey_id: ["k-new"],
      tags: ["a", "b"],
      backups: "disabled",
    });
  });

  it("decodes the base64 kubeconfig and reads the API server from it", async () => {
    const yaml =
      "apiVersion: v1\nclusters:\n- cluster:\n    server: https://abc.vultr-k8s.com:6443\n";
    const { services } = host(() => ({ body: { kube_config: btoa(yaml) } }));
    const client = new VultrClient({ apiKey: "K" }, plugin.resourceTypes, services);
    expect(
      await client.resolveOutput(
        "kubernetes-cluster",
        "a:kubernetes-cluster:c1",
        "kubeconfig",
        "a",
      ),
    ).toBe(yaml);
    expect(
      await client.resolveOutput(
        "kubernetes-cluster",
        "a:kubernetes-cluster:c1",
        "apiEndpoint",
        "a",
      ),
    ).toBe("https://abc.vultr-k8s.com:6443");
  });

  it("sends only changed fields on update", async () => {
    const { services, calls } = host(() => ({ body: {} }));
    const api = createVultrApi({ apiKey: "K", services });
    await applyUpdate(api, "instance", "a:instance:i1", {
      plan: "vc2-2c-4gb",
      backupsEnabled: "true",
    });
    expect(calls[0]!.method).toBe("PATCH");
    expect(JSON.parse(calls[0]!.body!)).toEqual({ plan: "vc2-2c-4gb", backups: "enabled" });
    await applyUpdate(api, "dns-record", "a:dns-record:example.com/r1", { name: "@" });
    expect(calls[1]!.url).toContain("/domains/example.com/records/r1");
    expect(JSON.parse(calls[1]!.body!)).toEqual({ name: "" });
  });

  it("restores from a backup or snapshot picked in the prompt", async () => {
    const { services, calls } = host(() => ({ body: {} }));
    const api = createVultrApi({ apiKey: "K", services });
    await executeCommand(api, "instance", "a:instance:i1", "restore", [
      JSON.stringify({ source: "backup:b-1" }),
    ]);
    expect(calls[0]!.url).toContain("/instances/i1/restore");
    expect(JSON.parse(calls[0]!.body!)).toEqual({ backup_id: "b-1" });
  });
});

describe("databases", () => {
  it("builds connection strings per engine", () => {
    const base = {
      id: "d",
      user: "vultradmin",
      password: "p@ss",
      host: "h",
      port: "16751",
      dbname: "defaultdb",
    };
    expect(connectionString({ ...base, database_engine: "pg" })).toBe(
      "postgresql://vultradmin:p%40ss@h:16751/defaultdb?sslmode=require",
    );
    expect(connectionString({ ...base, database_engine: "valkey" })).toBe(
      "rediss://vultradmin:p%40ss@h:16751",
    );
    expect(connectionString({ ...base, database_engine: "kafka", sasl_port: "16752" })).toMatch(
      /^kafka:\/\/vultradmin:p%40ss@h:16752\?sasl=scram-sha-256&ssl=true/,
    );
  });

  it("accepts a CA certificate as PEM or base64 PEM", () => {
    const pem = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----";
    expect(pemOf(pem)).toBe(pem);
    expect(pemOf(btoa(pem))).toBe(pem);
  });
});

describe("pricing", () => {
  const plans = [
    {
      id: "vc2-1c-1gb",
      monthly_cost: 5,
      location_cost: { sao: { monthly_cost: 7.5 } },
      locations: ["ewr", "sao"],
    },
  ];
  it("honours regional overrides", () => {
    expect(planMonthly(plans[0]!, "sao")).toBe(7.5);
    expect(planMonthly(plans[0]!, "ewr")).toBe(5);
    expect(sizePricing(plans, "sao", ["vc2-1c-1gb", "nope"])).toEqual({ "vc2-1c-1gb": 7.5 });
  });
});

describe("costs", () => {
  it("spreads invoice items over their days and the open month up to today", async () => {
    const { services } = host((c) => {
      if (c.url.includes("/billing/invoices/7/items"))
        return {
          body: {
            invoice_items: [
              {
                product: "Cloud Compute",
                start_date: "2026-08-01T00:00:00+00:00",
                end_date: "2026-08-31T23:59:59+00:00",
                total: 31,
              },
              {
                product: "Credit",
                description: "Promotional credit",
                start_date: "2026-08-01",
                end_date: "2026-08-01",
                total: -10,
              },
            ],
            meta: { links: { next: "" } },
          },
        };
      if (c.url.includes("/billing/invoices"))
        return {
          body: {
            billing_invoices: [{ id: 7, date: "2026-09-01T00:00:00+00:00" }],
            meta: { links: { next: "" } },
          },
        };
      if (c.url.includes("/billing/pending-charges"))
        return {
          body: {
            pending_charges: [
              {
                product: "Block Storage",
                start_date: "2026-09-01T00:00:00+00:00",
                end_date: "2026-09-30T23:59:59+00:00",
                total: 10,
              },
            ],
          },
        };
      return { body: {} };
    });
    const api = createVultrApi({ apiKey: "K", services });
    const rows = await fetchVultrCostData(
      api,
      { fromDate: "2026-08-01", toDate: "2026-09-10" },
      Date.parse("2026-09-10T12:00:00Z"),
    );
    const compute = rows.filter((r) => r.service === "Cloud Compute");
    expect(compute).toHaveLength(31);
    expect(compute[0]!.amount).toBeCloseTo(1);
    expect(rows.find((r) => r.chargeType === "credit")?.amount).toBe(-10);
    const storage = rows.filter((r) => r.service === "Block Storage");
    expect(storage).toHaveLength(10);
    expect(storage[0]!.amount).toBeCloseTo(1);
  });

  it("treats an end stamped at midnight as the previous day", () => {
    expect(
      itemDays({ start_date: "2026-08-01T00:00:00Z", end_date: "2026-08-03T00:00:00Z" }),
    ).toEqual(["2026-08-01", "2026-08-02"]);
  });
});

describe("credits", () => {
  it("reports a negative balance net of pending charges as credit", () => {
    expect(creditsFromAccount({ balance: -100, pending_charges: 25 })[0]!.remaining).toBe(75);
    expect(creditsFromAccount({ balance: 12, pending_charges: 3 })[0]!.remaining).toBe(0);
  });
});

describe("metrics", () => {
  it("turns daily bandwidth into GB series inside the window", () => {
    const series = bandwidthSeries(
      {
        "2026-10-01": { incoming_bytes: 2e9, outgoing_bytes: 5e8 },
        "2026-09-01": { incoming_bytes: 1 },
      },
      { startMs: Date.parse("2026-09-20T00:00:00Z"), endMs: Date.parse("2026-10-06T00:00:00Z") },
    );
    expect(series.map((s) => s.label)).toEqual(["Inbound Transfer", "Outbound Transfer"]);
    expect(series[0]!.points).toEqual([
      { timestamp: Date.parse("2026-10-01T00:00:00Z"), value: 2 },
    ]);
  });
});

describe("status feed", () => {
  it("maps region alerts to region ids and dedupes service alerts", () => {
    const body = JSON.stringify({
      service_alerts: [
        {
          id: "x",
          region: "sgp",
          subject: "Singapore Network Outage",
          status: "ongoing",
          start_date: "2026-09-24T14:31:00+00:00",
          entries: [{ updated_at: "2026-09-24T14:31:00+00:00", message: "Cable cut." }],
        },
        {
          id: "g",
          subject: "Scheduled Maintenance",
          status: "ongoing",
          start_date: "2026-10-01T00:00:00+00:00",
        },
      ],
      regions: {
        sgp: {
          alerts: [
            {
              id: "x",
              subject: "Singapore Network Outage",
              status: "ongoing",
              start_date: "2026-09-24T14:31:00+00:00",
            },
          ],
        },
        atl: {
          alerts: [
            {
              id: "y",
              subject: "Partial Outage",
              status: "ongoing",
              start_date: "2026-09-18T18:07:00+00:00",
            },
          ],
        },
      },
    });
    const incidents = parseStatusFeed(body);
    expect(incidents).toHaveLength(3);
    expect(incidents.find((i) => i.externalId === "x")).toMatchObject({
      regions: ["sgp"],
      impact: "major",
    });
    expect(incidents.find((i) => i.externalId === "y")).toMatchObject({
      regions: ["atl"],
      impact: "minor",
    });
    expect(incidents.find((i) => i.externalId === "g")).toMatchObject({
      providerWide: true,
      impact: "maintenance",
    });
  });
});

describe("terraform", () => {
  it("exports instances and DNS records with provider import ids", () => {
    const inst = mapInstance(
      { id: "i1", label: "web", plan: "vc2-1c-1gb", region: "ewr", features: [] },
      "a",
    );
    const out = exportResourcesToTerraform([inst], () => plugin.terraformExport);
    expect(out.hcl).toContain('resource "vultr_instance"');
    expect(out.hcl).toContain("vultr/vultr");
  });
});
