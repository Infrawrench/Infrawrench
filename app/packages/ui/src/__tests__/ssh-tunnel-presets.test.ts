import { describe, expect, it } from "vitest";
import { SSH_TUNNEL_PRESETS, buildSshTunnelCredentials } from "../ssh-tunnel-presets";

describe("SSH_TUNNEL_PRESETS", () => {
  it("maps known services to ports", () => {
    expect(SSH_TUNNEL_PRESETS.docker.port).toBe(2375);
    expect(SSH_TUNNEL_PRESETS.postgres.port).toBe(5432);
    expect(SSH_TUNNEL_PRESETS.mysql.port).toBe(3306);
    expect(SSH_TUNNEL_PRESETS.redis.port).toBe(6379);
    expect(SSH_TUNNEL_PRESETS.memcached.port).toBe(11211);
  });
  it("custom has a null pluginId", () => {
    expect(SSH_TUNNEL_PRESETS.custom.pluginId).toBeNull();
  });
});

describe("buildSshTunnelCredentials", () => {
  it("docker uses dockerHost tcp url", () => {
    expect(buildSshTunnelCredentials("docker", 2375)).toEqual({
      dockerHost: "tcp://localhost:2375",
    });
  });
  it("postgres uses a connection string", () => {
    expect(buildSshTunnelCredentials("postgres", 5432)).toEqual({
      connectionString: "postgresql://localhost:5432/postgres",
    });
  });
  it("mysql uses a connection string", () => {
    expect(buildSshTunnelCredentials("mysql", 3306)).toEqual({
      connectionString: "mysql://localhost:3306/mysql",
    });
  });
  it("redis uses a connection string", () => {
    expect(buildSshTunnelCredentials("redis", 6379)).toEqual({
      connectionString: "redis://localhost:6379",
    });
  });
  it("memcached uses a connection string", () => {
    expect(buildSshTunnelCredentials("memcached", 11211)).toEqual({
      connectionString: "memcached://localhost:11211",
    });
  });
  it("unknown plugin falls back to host", () => {
    expect(buildSshTunnelCredentials("whatever", 8080)).toEqual({ host: "localhost:8080" });
  });
});
