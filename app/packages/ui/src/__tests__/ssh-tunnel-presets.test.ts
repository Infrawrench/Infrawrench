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
    const [preset] = sshTunnelPresets([{ id: "aws" }, docker]);
    expect(preset).toEqual({
      key: "docker",
      label: "Docker",
      pluginId: "docker",
      port: 2375,
      credentials: { dockerHost: "tcp://localhost:{port}" },
    });
  });

  it("orders by port whatever order the plugins came in", () => {
    const keys = sshTunnelPresets([postgres, docker]).map((p) => p.key);
    expect(keys).toEqual(["docker", "postgres", "custom"]);
  });

  it("always ends with the host's custom entry, which has no plugin", () => {
    expect(sshTunnelPresets([])).toEqual([CUSTOM_SSH_TUNNEL_PRESET]);
    expect(CUSTOM_SSH_TUNNEL_PRESET.pluginId).toBeNull();
  });
});

describe("buildSshTunnelCredentials", () => {
  it("fills {port} in what the plugin declared", () => {
    const [dockerPreset, postgresPreset] = sshTunnelPresets([docker, postgres]);
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
