import type { HostServices } from "@infrawrench/plugin-base";
import { evaluateOrphanRule, exportResourcesToTerraform } from "@infrawrench/plugin-base";
import { describe, expect, it, vi } from "vitest";
import { firewallRuleBody } from "../actions.js";
import {
  UpCloudApiError,
  authHeader,
  createUpCloudApi,
  labelsFromText,
  labelsText,
  statusOf,
} from "../api.js";
import { UpCloudClient } from "../client.js";
import { summaryRows } from "../cost-data.js";
import {
  type Catalog,
  planMonthly,
  serverInterfaces,
  simpleBackupValue,
  splitPlan,
} from "../create.js";
import { mapServer, mapStorage } from "../listers.js";
import { databaseSeries, periodFor } from "../metrics.js";
import { plugin } from "../plugin.js";
import { mapComponent, zoneOf } from "../status-feed.js";
import { applyUpdate } from "../update.js";

type Call = { url: string; method: string; headers: Record<string, string>; body?: string };

function host(responder: (call: Call) => { status?: number; body: unknown }) {
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
  it("uses a bearer token, or basic auth for an API user", () => {
    expect(authHeader({ apiToken: "ucat_x" })).toBe("Bearer ucat_x");
    expect(authHeader({ username: "u", password: "p" })).toBe(`Basic ${btoa("u:p")}`);
    expect(() => authHeader({})).toThrow();
  });

  it("pages managed collections with limit and offset", async () => {
    const { services, calls } = host((c) => {
      const offset = Number(new URL(c.url).searchParams.get("offset"));
      return {
        body:
          offset === 0
            ? Array.from({ length: 100 }, (_, i) => ({ uuid: `d${i}` }))
            : [{ uuid: "last" }],
      };
    });
    const all = await createUpCloudApi({ apiToken: "t", services }).paged<{ uuid: string }>(
      "/database",
    );
    expect(all).toHaveLength(101);
    expect(calls[1]!.url).toContain("limit=100&offset=100");
  });

  it("reads both error formats and keeps the status", async () => {
    const legacy = host(() => ({
      status: 404,
      body: {
        error: { error_code: "SERVER_NOT_FOUND", error_message: "The server does not exist." },
      },
    }));
    const err = await createUpCloudApi({ apiToken: "t", services: legacy.services })
      .get("/server/x")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UpCloudApiError);
    expect(statusOf(err)).toBe(404);
    expect((err as UpCloudApiError).code).toBe("SERVER_NOT_FOUND");
    const problem = host(() => ({
      status: 400,
      body: {
        type: "https://developers.upcloud.com/1.3/errors#ERROR_INVALID_REQUEST",
        title: "Validation error.",
        status: 400,
        invalid_params: [{ name: "plan", reason: "unknown" }],
      },
    }));
    const err2 = await createUpCloudApi({ apiToken: "t", services: problem.services })
      .get("/database")
      .catch((e: unknown) => e);
    expect((err2 as Error).message).toContain("plan: unknown");
    expect((err2 as UpCloudApiError).code).toBe("INVALID_REQUEST");
  });

  it("round-trips labels", () => {
    expect(
      labelsText({
        label: [
          { key: "env", value: "prod" },
          { key: "team", value: "" },
        ],
      }),
    ).toBe("env=prod, team");
    expect(labelsFromText("env=prod, team")).toEqual([
      { key: "env", value: "prod" },
      { key: "team", value: "" },
    ]);
  });
});

describe("mappers", () => {
  it("maps a legacy server with wrapped addresses and string numbers", () => {
    const r = mapServer(
      {
        uuid: "s1",
        title: "web",
        hostname: "web.example.com",
        state: "stopped",
        plan: "1xCPU-2GB",
        zone: "fi-hel1",
        core_number: "1",
        memory_amount: "2048",
        firewall: "off",
        simple_backup: "0400,dailies",
        created: 1666609570,
        ip_addresses: {
          ip_address: [
            { access: "utility", address: "10.6.6.188", family: "IPv4" },
            { access: "public", address: "94.237.12.182", family: "IPv4" },
            { access: "public", address: "2a04::1", family: "IPv6" },
          ],
        },
        labels: { label: [{ key: "env", value: "prod" }] },
      },
      "acct",
    );
    expect(r.fields).toMatchObject({
      cores: 1,
      memoryMb: 2048,
      firewall: false,
      simpleBackup: "dailies",
      backupsOn: true,
      region: "fi-hel1",
      labels: "env=prod",
    });
    expect(r.resolvedOutputs).toMatchObject({
      ipv4: "94.237.12.182",
      ipv4Private: "10.6.6.188",
      ipv6: "2a04::1",
    });
    expect(evaluateOrphanRule(type("server").orphanRule, r.fields)).not.toBeNull();
  });

  it("flags detached storage and reads its backup rule", () => {
    const st = mapStorage(
      {
        uuid: "st1",
        title: "data",
        size: 50,
        servers: { server: [] },
        backup_rule: { interval: "daily", time: "0430", retention: "7" },
      },
      "acct",
    );
    expect(st.fields["backupRule"]).toBe("daily,0430,7");
    expect(evaluateOrphanRule(type("storage").orphanRule, st.fields)).not.toBeNull();
  });
});

describe("create helpers", () => {
  const catalog: Catalog = {
    zones: [{ id: "fi-hel1", description: "Helsinki #1" }],
    plans: [{ name: "1xCPU-1GB", core_number: 1, memory_amount: 1024, storage_size: 25 }],
    prices: { "fi-hel1": { "server_plan_1xCPU-1GB": { amount: 1, price: 0.744 } } },
  };
  it("prices plans from cents per hour over 672 hours", () => {
    expect(planMonthly(catalog, "1xCPU-1GB", "fi-hel1")).toBe(5);
  });
  it("builds wrapped network interfaces and backup values", () => {
    expect(serverInterfaces({ ipv6: "false", networkId: "n1" })).toEqual({
      interfaces: {
        interface: [
          { ip_addresses: { ip_address: [{ family: "IPv4" }] }, type: "public" },
          { ip_addresses: { ip_address: [{ family: "IPv4" }] }, type: "utility" },
          { ip_addresses: { ip_address: [{ family: "IPv4" }] }, type: "private", network: "n1" },
        ],
      },
    });
    expect(simpleBackupValue("weeklies")).toBe("0400,weeklies");
    expect(simpleBackupValue("no")).toBe("no");
    expect(splitPlan("pg:1x1xCPU-2GB-25GB")).toEqual(["pg", "1x1xCPU-2GB-25GB"]);
  });
  it("builds firewall rule bodies", () => {
    expect(firewallRuleBody({ protocol: "tcp", port: "22", source: "203.0.113.4" })).toEqual({
      firewall_rule: {
        direction: "in",
        action: "accept",
        family: "IPv4",
        protocol: "tcp",
        source_address_start: "203.0.113.4",
        source_address_end: "203.0.113.4",
        destination_port_start: "22",
        destination_port_end: "22",
      },
    });
  });
});

describe("client", () => {
  it("creates a server with an SSH key and a cloned template disk", async () => {
    const { services, calls } = host((c) => {
      if (c.url.endsWith("/plan"))
        return { body: { plans: { plan: [{ name: "1xCPU-2GB", storage_size: 50 }] } } };
      if (c.url.endsWith("/server") && c.method === "POST")
        return {
          status: 202,
          body: { server: { uuid: "s9", title: "web", state: "maintenance", zone: "fi-hel1" } },
        };
      return { body: {} };
    });
    const client = new UpCloudClient({ apiToken: "t" }, plugin.resourceTypes, services);
    const created = await client.createResource("server", "acct", {
      hostname: "web",
      zone: "fi-hel1",
      plan: "1xCPU-2GB",
      template: "tpl-1",
      sshPublicKey: "ssh-ed25519 AAAA me",
    });
    expect(created.id).toBe("acct:server:s9");
    const body = JSON.parse(calls.find((c) => c.method === "POST")!.body!).server;
    expect(body.storage_devices.storage_device[0]).toMatchObject({
      action: "clone",
      storage: "tpl-1",
      size: 50,
    });
    expect(body.login_user.ssh_keys.ssh_key).toEqual(["ssh-ed25519 AAAA me"]);
  });

  it("updates servers with a wrapped PUT and databases with a bare PATCH", async () => {
    const { services, calls } = host(() => ({ body: {} }));
    const api = createUpCloudApi({ apiToken: "t", services });
    await applyUpdate(api, "server", "a:server:s1", { firewall: "true", simpleBackup: "dailies" });
    expect(calls[0]!.method).toBe("PUT");
    expect(JSON.parse(calls[0]!.body!)).toEqual({
      server: { firewall: "on", simple_backup: "0400,dailies" },
    });
    await applyUpdate(api, "database", "a:database:d1", {
      ipFilter: "10.0.0.0/8",
      publicAccess: "false",
    });
    expect(calls[1]!.method).toBe("PATCH");
    expect(JSON.parse(calls[1]!.body!)).toEqual({
      properties: { ip_filter: ["10.0.0.0/8"], public_access: false },
    });
  });
});

describe("costs", () => {
  it("turns a billing summary into month rows per resource with zone and labels", () => {
    const rows = summaryRows("2026-09", {
      currency: "EUR",
      servers: {
        server: {
          resources: [
            {
              resource_id: "s1",
              amount: 16.18,
              details: [{ zone: "fi-hel2", labels: [{ key: "env", value: "prod" }] }],
            },
          ],
          total_amount: 16.18,
        },
        total_amount: 16.18,
      },
      storages: {
        storage: {
          resources: [{ resource_id: "st1", amount: 3.4 }],
          backup: [{ resource_id: "b1", amount: 0.1 }],
          total_amount: 3.5,
        },
        total_amount: 3.5,
      },
      total_amount: 19.68,
    });
    expect(rows).toEqual([
      {
        date: "2026-09-01",
        service: "Servers",
        region: "fi-hel2",
        resourceId: "s1",
        tags: { env: "prod" },
        currency: "EUR",
        amount: 16.18,
      },
      { date: "2026-09-01", service: "Storage", resourceId: "st1", currency: "EUR", amount: 3.4 },
      {
        date: "2026-09-01",
        service: "Storage (backups)",
        resourceId: "b1",
        currency: "EUR",
        amount: 0.1,
      },
    ]);
  });
});

describe("metrics", () => {
  it("reads the primary node's column from database charts", () => {
    const series = databaseSeries({
      cpu_usage: {
        data: {
          cols: [{ label: "time" }, { label: "db-2 (standby)" }, { label: "db-1 (master)" }],
          rows: [["2024-01-31T21:01:30Z", 50, 12.5]],
        },
      },
    });
    expect(series).toEqual([
      {
        label: "CPU Utilization",
        unit: "%",
        points: [{ timestamp: Date.parse("2024-01-31T21:01:30Z"), value: 12.5 }],
      },
    ]);
    expect(periodFor({ startMs: 0, endMs: 86_400_000 })).toBe("day");
  });
});

describe("status feed", () => {
  it("maps components to zones and products", () => {
    expect(zoneOf("US:CHI1: Cloud Servers")).toBe("us-chi1");
    expect(zoneOf("FI_HEL1: File Storage")).toBe("fi-hel1");
    expect(mapComponent("DE-FRA1: Managed Databases")).toMatchObject({
      regions: ["de-fra1"],
      resourceTypes: ["database", "database-user", "database-db"],
    });
    expect(mapComponent("SG-SIN1 - Singapore - APAC-1: Managed Object Storage")).toMatchObject({
      regions: ["apac-1"],
    });
    expect(mapComponent("API")).toMatchObject({ providerWide: true });
    expect(mapComponent("UpCloud Website")).toBeNull();
  });
});

describe("terraform", () => {
  it("exports storage with its uuid as the import id", () => {
    const st = mapStorage(
      { uuid: "st1", title: "data", size: 50, zone: "fi-hel1", tier: "maxiops" },
      "a",
    );
    const out = exportResourcesToTerraform([st], () => plugin.terraformExport);
    expect(out.hcl).toContain('resource "upcloud_storage"');
    expect(out.hcl).toContain("st1");
  });
});
