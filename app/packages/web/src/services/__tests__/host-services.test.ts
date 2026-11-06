import { afterEach, describe, it, expect, vi } from "vitest";

const { driversMock } = vi.hoisted(() => ({
  driversMock: {
    sqlDrivers: new Map([["postgres", { id: "postgres", query: vi.fn(), execute: vi.fn() }]]),
    kvDrivers: new Map([["redis", { id: "redis", command: vi.fn() }]]),
    dockerDrivers: new Map([["docker", { id: "docker", command: vi.fn() }]]),
    storageDrivers: new Map(),
  },
}));
vi.mock("../drivers", () => driversMock);
vi.mock("@infrawrench/server-core/drivers", () => driversMock);

vi.mock("@infrawrench/server-core/db/client", () => ({
  db: {},
}));

import {
  buildHostServices,
  buildKvHostServices,
  buildDockerHostServices,
  buildPluginHostServices,
} from "../host-services";
import type { PluginManifest } from "@infrawrench/plugin-base";

describe("buildHostServices", () => {
  it("returns sql host services for a known driver", () => {
    const services = buildHostServices("postgres", "postgres://localhost/db");
    expect(services.sql).toBeDefined();
    expect(services.sql!.query).toBeDefined();
    expect(services.sql!.execute).toBeDefined();
  });

  it("throws for unknown SQL driver", () => {
    expect(() => buildHostServices("unknown", "conn")).toThrow("Unknown SQL driver: unknown");
  });
});

describe("buildKvHostServices", () => {
  it("returns kv host services for a known driver", () => {
    const services = buildKvHostServices("redis", "redis://localhost");
    expect(services.kv).toBeDefined();
    expect(services.kv!.command).toBeDefined();
  });

  it("throws for unknown KV driver", () => {
    expect(() => buildKvHostServices("unknown", "conn")).toThrow("Unknown KV driver: unknown");
  });
});

describe("buildDockerHostServices", () => {
  it("returns docker host services for a known driver", () => {
    const services = buildDockerHostServices("docker", "unix:///var/run/docker.sock");
    expect(services.docker).toBeDefined();
    expect(services.docker!.command).toBeDefined();
  });

  it("throws for unknown Docker driver", () => {
    expect(() => buildDockerHostServices("unknown", "host")).toThrow(
      "Unknown Docker driver: unknown",
    );
  });
});

describe("buildPluginHostServices", () => {
  it("builds SQL-based host services from manifest", async () => {
    const manifest = {
      sqlDriver: { driver: "postgres", credentialKey: "connStr" },
    } as unknown as PluginManifest;
    const services = await buildPluginHostServices(manifest, {
      connStr: "postgres://localhost/db",
    });
    expect(services).toBeDefined();
    expect(services!.sql).toBeDefined();
    expect(services!.http).toBeDefined();
  });

  it("builds KV-based host services from manifest", async () => {
    const manifest = {
      kvDriver: { driver: "redis", credentialKey: "redisUrl" },
    } as unknown as PluginManifest;
    const services = await buildPluginHostServices(manifest, { redisUrl: "redis://localhost" });
    expect(services).toBeDefined();
    expect(services!.kv).toBeDefined();
    expect(services!.http).toBeDefined();
  });

  it("builds Docker-based host services from manifest", async () => {
    const manifest = {
      dockerDriver: { driver: "docker", credentialKey: "dockerHost" },
    } as unknown as PluginManifest;
    const services = await buildPluginHostServices(manifest, {
      dockerHost: "unix:///var/run/docker.sock",
    });
    expect(services).toBeDefined();
    expect(services!.docker).toBeDefined();
    expect(services!.http).toBeDefined();
  });

  it("returns http-only services when no driver specified", async () => {
    const manifest = {} as unknown as PluginManifest;
    const services = await buildPluginHostServices(manifest, {});
    expect(services).toBeDefined();
    expect(services!.http).toBeDefined();
  });
});

describe("buildPluginHostServices: instance pricing warehouse", () => {
  const manifest = { id: "aws" } as unknown as PluginManifest;

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("is absent without the read token, so plugins use their providers' price APIs", async () => {
    vi.stubEnv("PRICING_WAREHOUSE_READ_TOKEN", "");
    const services = await buildPluginHostServices(manifest, {}, { bastionId: null });
    expect(services?.instancePricing).toBeUndefined();
  });

  it("queries the warehouse directly with the read token", async () => {
    vi.stubEnv("PRICING_WAREHOUSE_READ_TOKEN", "read-only-test-token");
    vi.stubEnv("PRICING_WAREHOUSE_URL", "https://warehouse.test/");
    const fetchMock = vi.fn<typeof fetch>(
      async () => new Response('["x"]\n["UInt8"]\n[1]\n', { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const services = await buildPluginHostServices(manifest, {}, { bastionId: null });
    const result = await services!.instancePricing!.query("SELECT 1 AS x", 10);
    expect(result.rows).toEqual([[1]]);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("warehouse.test");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer read-only-test-token");
  });
});
