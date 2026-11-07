import { hostClient, hostPlugin } from "@infrawrench/plugin-base/effect";
import type { HostServices } from "@infrawrench/plugin-base";
import { describe, expect, it } from "vitest";
import { CLUSTER_HOSTS_LABEL } from "../api.js";
import { WeaviateClient } from "../client.js";
import { manifest, plugin } from "../plugin.js";
import { RESOURCE_TYPES } from "../resource-types.js";
import { fakeHttp } from "./helpers.js";

const CLOUD = "abc.c0.europe-west3.gcp.weaviate.cloud";
const SELF = "vectors.acme.example";

function refusing(host: string): HostServices {
  const http = fakeHttp();
  return {
    ...http.services,
    http: {
      async request(req) {
        if (new URL(req.url).hostname !== host) return http.services.http!.request(req);
        throw new Error("fetch failed", {
          cause: new Error(
            `${host} is not allowed for this account: it is neither one of the plugin's hosts nor the account's own`,
          ),
        });
      },
    },
  };
}

describe("self-hosted cluster hosts", () => {
  it("is a host field the bastion allowlist reads", () => {
    const field = manifest.credentialFields.find((f) => f.key === "clusterHosts");
    expect(field).toMatchObject({
      providerHost: true,
      sensitive: false,
      optional: true,
      advanced: true,
      label: CLUSTER_HOSTS_LABEL,
    });
    expect(field?.providerOptions).toMatchObject({ dependsOn: ["clusters"], multiple: true });
  });

  it("offers each More Clusters host outside Weaviate Cloud's, and never the keys", async () => {
    const http = fakeHttp();
    const options = await hostPlugin(plugin).listCredentialOptions!(
      "clusterHosts",
      {
        endpoint: "https://primary.acme.example",
        clusters: [
          `https://${CLOUD} cloud-key`,
          `https://${SELF}:8080 self-key`,
          `${SELF} other-key`,
          "# https://commented.acme.example k",
          "https://old.weaviate.network k",
          "https://primary.acme.example k",
          "edge.acme.example,edge-key",
        ].join("\n"),
      },
      http.services,
    );
    expect(options).toEqual([
      {
        id: "edge.acme.example",
        label: "edge.acme.example",
        description: "https://edge.acme.example",
      },
      {
        id: SELF,
        label: SELF,
        description: `https://${SELF}:8080, https://${SELF}`,
      },
    ]);
    expect(JSON.stringify(options)).not.toMatch(/key/);
    expect(http.calls).toEqual([]);
  });

  it("names the host and the field when a bastion refuses a self-hosted cluster", async () => {
    const services = refusing(SELF);
    const c = hostClient(
      new WeaviateClient({ clusters: `https://${SELF} k` }, RESOURCE_TYPES, services),
    );
    const err = await c.listResources("collection", "acct").then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(String(err)).toContain(SELF);
    expect(String(err)).toContain(CLUSTER_HOSTS_LABEL);
  });

  it("leaves a refusal of Weaviate Cloud's own host as it was", async () => {
    const services = refusing(CLOUD);
    const c = hostClient(
      new WeaviateClient({ clusters: `https://${CLOUD} k` }, RESOURCE_TYPES, services),
    );
    const err = await c.listResources("collection", "acct").then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(String(err)).toContain("fetch failed");
    expect(String(err)).not.toContain(CLUSTER_HOSTS_LABEL);
  });
});
