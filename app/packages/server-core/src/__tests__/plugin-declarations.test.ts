import { beforeAll, describe, expect, it } from "vitest";

import { rewriteCredentialFields } from "../credential-rewriters/tunnel-form";

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

  it("widens only fields that are a provider's host to one label under it", () => {
    const declared = manifests().flatMap((m) =>
      m.credentialFields
        .filter((f) => f.providerHostSubdomains)
        .map((f) => `${m.id}.${f.key}${f.providerHost ? "" : " (not providerHost)"}`),
    );
    expect(declared).toEqual(["s3-compatible.endpoint"]);
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

  it("names the fields an SSH tunnel rewrites, and how", () => {
    const declared = manifests().flatMap((m) =>
      m.credentialFields.filter((f) => f.tunnel).map((f) => `${m.id}.${f.key}: ${f.tunnel}`),
    );
    expect(declared.sort()).toEqual([
      "auth0.domain: address",
      "clickhouse.chHost: address",
      "consul.address: address",
      "databricks.host: address",
      "docker.dockerHost: address",
      "dynatrace.environmentUrl: address",
      "gitlab.url: address",
      "hashicorp-vault.address: address",
      "hcp-terraform.hostname: address",
      "infisical.siteUrl: address",
      "jfrog.baseUrl: address",
      "kafka.connectionString: address",
      "kubernetes.kubeconfig: kubeconfig",
      "memcached.connectionString: address",
      "mongodb.connectionString: address",
      "mssql.connectionString: address",
      "mysql.connectionString: address",
      "nats.servers: address",
      "nats.url: address",
      "nomad.address: address",
      "okta.orgUrl: address",
      "opensearch.endpoint: address",
      "openstack.authUrl: address",
      "postgres.connectionString: address",
      "posthog.host: address",
      "prometheus.alertmanagerUrl: address",
      "prometheus.url: address",
      "proxmox.url: address",
      "pulumi-cloud.apiUrl: address",
      "rabbitmq.url: address",
      "redis.connectionString: address",
      "s3-compatible.endpoint: address",
      "sentry.baseUrl: address",
      "spacelift.endpoint: address",
      "vsphere.url: address",
      "weaviate-cloud.endpoint: address",
    ]);
  });

  it("marks every driver's connection for the tunnel, a kubeconfig as one", () => {
    const unmarked = manifests().flatMap((m) => {
      const wanted = [
        ...[m.sqlDriver, m.kvDriver, m.dockerDriver].flatMap((d) =>
          d ? [[d.credentialKey, "address"] as const] : [],
        ),
        ...(m.kubernetesDriver ? [[m.kubernetesDriver.credentialKey, "kubeconfig"] as const] : []),
      ];
      return wanted
        .filter(([key, form]) => m.credentialFields.find((f) => f.key === key)?.tunnel !== form)
        .map(([key]) => `${m.id}.${key}`);
    });
    expect(unmarked).toEqual([]);
  });

  it("marks every address a bastion reads, except the hosts listed only for its allowlist", () => {
    const unmarked = manifests().flatMap((m) =>
      m.credentialFields.filter((f) => f.providerHost && !f.tunnel).map((f) => `${m.id}.${f.key}`),
    );
    expect(unmarked.sort()).toEqual([
      "openstack.endpointHosts",
      "qdrant-cloud.clusterHosts",
      "weaviate-cloud.clusterHosts",
    ]);
  });

  it("points each SSH tunnel preset's account at the tunnel's local end", () => {
    const rewritten = Object.fromEntries(
      manifests().flatMap((m) => {
        if (!m.sshTunnel) return [];
        const port = m.sshTunnel.defaultPort;
        // What the "Connect to service via SSH" modal stores (`{port}` is the
        // remote port), with the bastion forwarding to its own loopback.
        const credentials = Object.fromEntries(
          Object.entries(m.sshTunnel.credentials).map(([k, v]) => [
            k,
            v.replaceAll("{port}", String(port)),
          ]),
        );
        const changed = rewriteCredentialFields(
          m.credentialFields,
          credentials,
          { localPort: 40000, remoteHost: "127.0.0.1", remotePort: port },
          { fallback: false },
        );
        return [[m.id, { changed, credentials }]];
      }),
    );
    expect(rewritten).toEqual({
      docker: { changed: ["dockerHost"], credentials: { dockerHost: "tcp://127.0.0.1:40000" } },
      postgres: {
        changed: ["connectionString"],
        credentials: { connectionString: "postgresql://127.0.0.1:40000/postgres" },
      },
      mysql: {
        changed: ["connectionString"],
        credentials: { connectionString: "mysql://127.0.0.1:40000/mysql" },
      },
      redis: {
        changed: ["connectionString"],
        credentials: { connectionString: "redis://127.0.0.1:40000" },
      },
      memcached: {
        changed: ["connectionString"],
        credentials: { connectionString: "memcached://127.0.0.1:40000" },
      },
    });
  });

  it("gives every peer a plugin whose connection the tunnel can rewrite", () => {
    // A managed cluster or database is used as its peer (a GKE cluster as a
    // Kubernetes connection): the credential its outputs fill is a marked field.
    const byId = new Map(manifests().map((m) => [m.id, m]));
    const unmarked = registry.BUNDLED_PLUGINS.flatMap((plugin) =>
      plugin.resourceTypes.flatMap((type) =>
        (type.peerIntegrations ?? []).flatMap((integration) => {
          const peer = byId.get(integration.pluginId);
          const driver =
            peer?.sqlDriver ?? peer?.kvDriver ?? peer?.dockerDriver ?? peer?.kubernetesDriver;
          if (!peer || !driver) return [];
          const mapped = integration.credentialMappings.some(
            (m) => m.credentialKey === driver.credentialKey,
          );
          const field = peer.credentialFields.find((f) => f.key === driver.credentialKey);
          return mapped && !field?.tunnel ? [`${plugin.manifest.id}.${type.id} -> ${peer.id}`] : [];
        }),
      ),
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
