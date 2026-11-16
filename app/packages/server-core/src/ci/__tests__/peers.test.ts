import { beforeEach, describe, expect, it, vi } from "vitest";

/** What each test's world looks like: tunnels, the parent account and what the peer was built from. */
const world = vi.hoisted(() => ({
  tunnelled: false,
  accountPluginId: "gcp",
  fields: {} as Record<string, unknown>,
  credentials: {} as Record<string, string>,
  /** Whether the credential rewriters changed what the peer was built from. */
  rewritten: false,
  built: [] as Array<{ pluginId: string; outputs: string[] }>,
}));

// `reachedThroughTunnel` reads ssh_tunnel_configs: one row, or none.
vi.mock("../../db/client.js", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({ limit: async () => (world.tunnelled ? [{ id: "t1" }] : []) }),
      }),
    }),
  },
}));

const gke = {
  id: "gke-cluster",
  peerIntegrations: [
    {
      pluginId: "kubernetes",
      credentialMappings: [
        { outputKey: "kubeconfig", credentialKey: "kubeconfig" },
        { outputKey: "nodeHourlyRates", credentialKey: "nodeHourlyRates" },
      ],
      tabLabel: "Kubernetes",
      ci: {
        lends: "token",
        reach: "cluster",
        lifetime: "hour",
        credentialMappings: [{ outputKey: "ciKubeconfig", credentialKey: "kubeconfig" }],
        availableWhen: { fieldKey: "entraId", equals: "true", reason: "Local accounts only" },
      },
    },
    // A peer the type has, but declares nothing for CI about.
    { pluginId: "postgres", credentialMappings: [], tabLabel: "PostgreSQL" },
  ],
};

vi.mock("../../org-accounts.js", () => ({
  getOrgAccountClient: async (accountId: string) => ({
    account: { id: accountId, pluginId: world.accountPluginId },
    credentials: {},
    plugin: { manifest: { id: world.accountPluginId }, resourceTypes: [gke] },
    client: {
      getResource: async (type: string, id: string) => ({
        id,
        resourceTypeId: type,
        fields: world.fields,
        resolvedOutputs: {},
      }),
    },
  }),
}));

vi.mock("../../peer-clients.js", () => ({
  filterVisiblePeerIntegrations: (i: unknown[]) => i,
  buildPeerPluginClient: async (input: {
    integration: { pluginId: string; credentialMappings: Array<{ outputKey: string }> };
  }) => {
    world.built.push({
      pluginId: input.integration.pluginId,
      outputs: input.integration.credentialMappings.map((m) => m.outputKey),
    });
    return {
      client: {},
      plugin: { manifest: { id: input.integration.pluginId } },
      credentials: world.credentials,
      rewritten: world.rewritten,
    };
  },
}));

const { ciPeerClient } = await import("../peers");

const resource = { id: "acc:gke-cluster:prod", accountId: "acc", resourceTypeId: "gke-cluster" };

describe("the peer client CI uses", () => {
  beforeEach(() => {
    Object.assign(world, {
      tunnelled: false,
      accountPluginId: "gcp",
      fields: { entraId: true },
      credentials: { token: "opaque-token" },
      rewritten: false,
      built: [],
    });
  });

  it("reads the outputs the CI declaration names, over the peer tabs' own", async () => {
    const peer = await ciPeerClient("org", resource, "kubernetes", "lend");
    expect(peer && !("refused" in peer)).toBe(true);
    expect(world.built).toEqual([
      { pluginId: "kubernetes", outputs: ["nodeHourlyRates", "ciKubeconfig"] },
    ]);
  });

  it("is no peer of an account of the peer's own plugin", async () => {
    world.accountPluginId = "kubernetes";
    expect(await ciPeerClient("org", resource, "kubernetes", "lend")).toBeNull();
    expect(world.built).toEqual([]);
  });

  it("refuses a peer the type declares nothing for CI about", async () => {
    expect(await ciPeerClient("org", resource, "postgres", "lend")).toEqual({
      refused: "it is no longer offered to CI as `postgres`",
    });
  });

  it("refuses a resource its declaration rules out, checked as the provider lists it now", async () => {
    world.fields = { entraId: false };
    expect(await ciPeerClient("org", resource, "kubernetes", "run")).toEqual({
      refused: "Local accounts only",
    });
    expect(world.built).toEqual([]);
  });

  it("refuses credentials an SSH tunnel rewrote, lends ones it left alone, and tears down through it", async () => {
    world.tunnelled = true;
    // The account has a tunnel, but it is for something else: the peer's
    // kubeconfig names another server, the rewriter left it alone, and it is lent.
    world.credentials = { kubeconfig: "apiVersion: v1\nkind: Config\n" };
    const untouched = await ciPeerClient("org", resource, "kubernetes", "lend");
    expect(untouched && !("refused" in untouched)).toBe(true);
    // One the rewriter pointed at the gateway's end of the tunnel is refused,
    // a correctly rewritten kubeconfig as much as a connection string.
    for (const credentials of [
      { connectionString: "postgres://u:pw@127.0.0.1:41234/db" },
      {
        kubeconfig:
          "clusters:\n- cluster:\n    server: https://127.0.0.1:41234\n    tls-server-name: 10.0.0.1\n",
      },
    ]) {
      world.credentials = credentials;
      world.rewritten = true;
      const refused = await ciPeerClient("org", resource, "kubernetes", "lend");
      expect(refused && "refused" in refused && refused.refused).toMatch(/SSH tunnel/);
    }
    // Teardown still goes through the peer, rewritten or not.
    world.fields = { entraId: false };
    const teardown = await ciPeerClient("org", resource, "kubernetes", "teardown");
    expect(teardown && !("refused" in teardown)).toBe(true);
  });
});
