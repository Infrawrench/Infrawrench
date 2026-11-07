import { beforeAll, describe, expect, it } from "vitest";

let registry: typeof import("../plugin-registry");

// Transforming every plugin package is expensive, so import once for the file.
beforeAll(async () => {
  registry = await import("../plugin-registry");
}, 120_000);

function manifests() {
  return registry.BUNDLED_PLUGINS.map((plugin) => plugin.manifest);
}

describe("what plugins declare for the hosts", () => {
  it("offers the same SSH tunnel services the modal has always offered", () => {
    const declared = Object.fromEntries(
      manifests().flatMap((m) => (m.sshTunnel ? [[m.id, m.sshTunnel]] : [])),
    );
    expect(declared).toEqual({
      docker: {
        label: "Docker",
        defaultPort: 2375,
        credentials: { dockerHost: "tcp://localhost:{port}" },
      },
      postgres: {
        label: "PostgreSQL",
        defaultPort: 5432,
        credentials: { connectionString: "postgresql://localhost:{port}/postgres" },
      },
      mysql: {
        label: "MySQL",
        defaultPort: 3306,
        credentials: { connectionString: "mysql://localhost:{port}/mysql" },
      },
      redis: {
        label: "Redis",
        defaultPort: 6379,
        credentials: { connectionString: "redis://localhost:{port}" },
      },
      memcached: {
        label: "Memcached",
        defaultPort: 11211,
        credentials: { connectionString: "memcached://localhost:{port}" },
      },
    });
  });

  it("has one plugin whose accounts are jump hosts", () => {
    expect(manifests().flatMap((m) => (m.jumpHost ? [m.id] : []))).toEqual(["ssh"]);
  });

  it("opens a document browser for one KV driver", () => {
    const documents = manifests().flatMap((m) =>
      m.kvDriver?.browser === "documents" ? [m.id] : [],
    );
    expect(documents).toEqual(["mongodb"]);
  });
});
