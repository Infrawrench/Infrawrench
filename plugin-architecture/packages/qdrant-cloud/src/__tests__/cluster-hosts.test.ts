import { hostClient, hostPlugin } from "@infrawrench/plugin-base/effect";
import type { HostServices } from "@infrawrench/plugin-base";
import { describe, expect, it } from "vitest";
import { CLUSTER_HOSTS_LABEL } from "../api.js";
import { QdrantCloudClient } from "../client.js";
import { manifest, plugin } from "../plugin.js";
import { RESOURCE_TYPES } from "../resource-types.js";
import type { QcCluster } from "../types.js";
import { fakeHttp } from "./helpers.js";

const ACC = "acct-uuid";
const CLUSTERS = `api.cloud.qdrant.io/api/cluster/v1/accounts/${ACC}/clusters`;

function withEndpoint(id: string, name: string, url: string): QcCluster {
  return {
    id,
    name,
    accountId: ACC,
    state: { phase: "CLUSTER_PHASE_HEALTHY", endpoint: { url, restPort: 6333 } },
  };
}

const managed = withEndpoint("c1", "search", "https://abc.us-east-1-0.aws.cloud.qdrant.io");
const hybrid = withEndpoint("c2", "on-prem", "https://qdrant.acme.example");
const hybridToo = withEndpoint("c3", "on-prem-2", "qdrant.acme.example");
const other = withEndpoint("c4", "edge", "https://vectors.edge.acme.example/");

describe("hybrid cluster endpoints", () => {
  it("is a host field the bastion allowlist reads", () => {
    const field = manifest.credentialFields.find((f) => f.key === "clusterHosts");
    expect(field).toMatchObject({
      providerHost: true,
      sensitive: false,
      optional: true,
      advanced: true,
      label: CLUSTER_HOSTS_LABEL,
    });
    expect(field?.providerOptions).toMatchObject({
      dependsOn: ["apiKey", "accountId"],
      multiple: true,
    });
  });

  it("offers each cluster endpoint outside Qdrant Cloud's own hosts", async () => {
    const http = fakeHttp();
    http.route("GET", CLUSTERS, { items: [managed, hybrid, hybridToo, other] });
    const options = await hostPlugin(plugin).listCredentialOptions!(
      "clusterHosts",
      { apiKey: "mk", accountId: ACC },
      http.services,
    );
    expect(options).toEqual([
      {
        id: "qdrant.acme.example",
        label: "qdrant.acme.example",
        description: "on-prem, on-prem-2",
      },
      { id: "vectors.edge.acme.example", label: "vectors.edge.acme.example", description: "edge" },
    ]);
  });

  it("asks for the account before listing clusters", async () => {
    const http = fakeHttp();
    await expect(
      hostPlugin(plugin).listCredentialOptions!("clusterHosts", { apiKey: "mk" }, http.services),
    ).rejects.toThrow("Account");
    expect(http.calls).toEqual([]);
  });

  it("names the host and the field when a bastion refuses a cluster endpoint", async () => {
    const http = fakeHttp();
    http.route("GET", CLUSTERS, { items: [hybrid] });
    const services: HostServices = {
      ...http.services,
      http: {
        async request(req) {
          const host = new URL(req.url).hostname;
          if (host === "api.cloud.qdrant.io") return http.services.http!.request(req);
          throw new Error("fetch failed", {
            cause: new Error(
              `${host} is not allowed for this account: it is neither one of the plugin's hosts nor the account's own`,
            ),
          });
        },
      },
    };
    await services.secrets!.setPlaintext!("host:cluster:c2", "databaseApiKey", "k");
    const c = hostClient(
      new QdrantCloudClient({ apiKey: "mk", accountId: ACC }, RESOURCE_TYPES, services),
    );
    const err = await c.listResources("collection", "host").then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect(String(err)).toContain("qdrant.acme.example");
    expect(String(err)).toContain("Hybrid Cluster Endpoints");
  });

  it("leaves a refusal of Qdrant Cloud's own host as it was", async () => {
    const http = fakeHttp();
    http.route("GET", CLUSTERS, { items: [managed] });
    const refusal = new Error("fetch failed", {
      cause: new Error("destination not allowlisted: abc.us-east-1-0.aws.cloud.qdrant.io:6333"),
    });
    const services: HostServices = {
      ...http.services,
      http: {
        async request(req) {
          if (new URL(req.url).hostname === "api.cloud.qdrant.io") {
            return http.services.http!.request(req);
          }
          throw refusal;
        },
      },
    };
    await services.secrets!.setPlaintext!("host:cluster:c1", "databaseApiKey", "k");
    const c = hostClient(
      new QdrantCloudClient({ apiKey: "mk", accountId: ACC }, RESOURCE_TYPES, services),
    );
    await expect(c.listResources("collection", "host")).rejects.toBe(refusal);
  });
});
