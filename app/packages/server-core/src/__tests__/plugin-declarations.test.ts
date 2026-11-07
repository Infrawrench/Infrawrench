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

  it("names the fields that hold a provider's own host", () => {
    const declared = manifests().flatMap((m) =>
      m.credentialFields.filter((f) => f.providerHost).map((f) => `${m.id}.${f.key}`),
    );
    expect(declared.sort()).toEqual([
      "auth0.domain",
      "clickhouse.chHost",
      "consul.address",
      "databricks.host",
      "dynatrace.environmentUrl",
      "gitlab.url",
      "hashicorp-vault.address",
      "hcp-terraform.hostname",
      "infisical.siteUrl",
      "jfrog.baseUrl",
      "nats.url",
      "nomad.address",
      "okta.orgUrl",
      "opensearch.endpoint",
      "openstack.authUrl",
      "openstack.endpointHosts",
      "posthog.host",
      "prometheus.alertmanagerUrl",
      "prometheus.url",
      "proxmox.url",
      "pulumi-cloud.apiUrl",
      "qdrant-cloud.clusterHosts",
      "rabbitmq.url",
      "s3-compatible.endpoint",
      "sentry.baseUrl",
      "spacelift.endpoint",
      "vsphere.url",
      "weaviate-cloud.clusterHosts",
      "weaviate-cloud.endpoint",
    ]);
  });

  it("never marks a sensitive field as a host, which would put a secret on the allowlist", () => {
    const marked = manifests().flatMap((m) =>
      m.credentialFields.filter((f) => f.providerHost && f.sensitive).map((f) => f.key),
    );
    expect(marked).toEqual([]);
  });

  it("marks any field that asks for a URL as the provider's host", () => {
    const asksForUrl = /^https?:\/\//;
    const unmarked = manifests().flatMap((m) =>
      m.credentialFields
        .filter(
          (f) => asksForUrl.test(f.placeholder ?? "") || asksForUrl.test(f.defaultValue ?? ""),
        )
        .filter((f) => !f.providerHost && !f.sensitive)
        .map((f) => `${m.id}.${f.key}`),
    );
    expect(unmarked).toEqual([]);
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
