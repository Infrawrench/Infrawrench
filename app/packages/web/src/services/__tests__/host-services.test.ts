import { describe, it, expect, vi } from "vitest";

vi.mock("../drivers", () => {
  const mockSqlQuery = vi.fn();
  const mockSqlExecute = vi.fn();
  const mockKvCommand = vi.fn();
  const mockDockerCommand = vi.fn();

  return {
    sqlDrivers: new Map([
      ["postgres", { id: "postgres", query: mockSqlQuery, execute: mockSqlExecute }],
    ]),
    kvDrivers: new Map([["redis", { id: "redis", command: mockKvCommand }]]),
    dockerDrivers: new Map([["docker", { id: "docker", command: mockDockerCommand }]]),
  };
});

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
  it("builds SQL-based host services from manifest", () => {
    const manifest = {
      sqlDriver: { driver: "postgres", credentialKey: "connStr" },
    } as unknown as PluginManifest;
    const services = buildPluginHostServices(manifest, { connStr: "postgres://localhost/db" });
    expect(services).toBeDefined();
    expect(services!.sql).toBeDefined();
    expect(services!.http).toBeDefined();
  });

  it("builds KV-based host services from manifest", () => {
    const manifest = {
      kvDriver: { driver: "redis", credentialKey: "redisUrl" },
    } as unknown as PluginManifest;
    const services = buildPluginHostServices(manifest, { redisUrl: "redis://localhost" });
    expect(services).toBeDefined();
    expect(services!.kv).toBeDefined();
    expect(services!.http).toBeDefined();
  });

  it("builds Docker-based host services from manifest", () => {
    const manifest = {
      dockerDriver: { driver: "docker", credentialKey: "dockerHost" },
    } as unknown as PluginManifest;
    const services = buildPluginHostServices(manifest, {
      dockerHost: "unix:///var/run/docker.sock",
    });
    expect(services).toBeDefined();
    expect(services!.docker).toBeDefined();
    expect(services!.http).toBeDefined();
  });

  it("returns http-only services when no driver specified", () => {
    const manifest = {} as unknown as PluginManifest;
    const services = buildPluginHostServices(manifest, {});
    expect(services).toBeDefined();
    expect(services!.http).toBeDefined();
  });
});
