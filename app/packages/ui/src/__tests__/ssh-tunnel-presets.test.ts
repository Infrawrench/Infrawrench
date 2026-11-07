import { describe, expect, it } from "vitest";
import {
  CUSTOM_SSH_TUNNEL_PRESET,
  buildSshTunnelCredentials,
  sshTunnelPresets,
} from "../ssh-tunnel-presets";

const docker = {
  id: "docker",
  sshTunnel: {
    label: "Docker",
    defaultPort: 2375,
    credentials: { dockerHost: "tcp://localhost:{port}" },
  },
};
const postgres = {
  id: "postgres",
  sshTunnel: {
    label: "PostgreSQL",
    defaultPort: 5432,
    credentials: { connectionString: "postgresql://localhost:{port}/postgres" },
  },
};

describe("sshTunnelPresets", () => {
  it("derives a preset from each plugin that declares a tunnel", () => {
    const [preset] = sshTunnelPresets([{ id: "aws" }, docker], { custom: false });
    expect(preset).toEqual({
      key: "docker",
      label: "Docker",
      pluginId: "docker",
      port: 2375,
      credentials: { dockerHost: "tcp://localhost:{port}" },
    });
  });

  it("orders by port whatever order the plugins came in", () => {
    const keys = sshTunnelPresets([postgres, docker], { custom: false }).map((p) => p.key);
    expect(keys).toEqual(["docker", "postgres"]);
  });

  it("ends with the host's custom entry, which has no plugin, where the host offers it", () => {
    const keys = sshTunnelPresets([postgres, docker], { custom: true }).map((p) => p.key);
    expect(keys).toEqual(["docker", "postgres", "custom"]);
    expect(sshTunnelPresets([], { custom: true })).toEqual([CUSTOM_SSH_TUNNEL_PRESET]);
    expect(CUSTOM_SSH_TUNNEL_PRESET.pluginId).toBeNull();
  });

  it("leaves it out where a plain tunnel would be no use", () => {
    expect(sshTunnelPresets([], { custom: false })).toEqual([]);
  });
});

describe("buildSshTunnelCredentials", () => {
  it("fills {port} in what the plugin declared", () => {
    const [dockerPreset, postgresPreset] = sshTunnelPresets([docker, postgres], { custom: false });
    expect(buildSshTunnelCredentials(dockerPreset!, 2375)).toEqual({
      dockerHost: "tcp://localhost:2375",
    });
    expect(buildSshTunnelCredentials(postgresPreset!, 15432)).toEqual({
      connectionString: "postgresql://localhost:15432/postgres",
    });
  });

  it("defaults a preset without credentials to a host", () => {
    expect(buildSshTunnelCredentials(CUSTOM_SSH_TUNNEL_PRESET, 8080)).toEqual({
      host: "localhost:8080",
    });
  });
});
