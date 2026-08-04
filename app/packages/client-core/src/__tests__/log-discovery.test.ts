import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginClient, ResourceInstance } from "@infrawrench/plugin-base";
import {
  __resetPeerLogCapabilityCache,
  discoverSidecarLogStreams,
  peerIntegrationVisible,
  type SidecarLogDiscoveryDeps,
  type SidecarLogParent,
} from "../log-discovery";

function instance(over: Partial<ResourceInstance> = {}): ResourceInstance {
  return {
    id: "acc-1:k8s-pod:default:api-0",
    pluginId: "kubernetes",
    resourceTypeId: "k8s-pod",
    accountId: "acc-1",
    displayName: "api-0",
    fields: {},
    resolvedOutputs: {},
    secretStates: [],
    createdAt: "",
    updatedAt: "",
    ...over,
  };
}

/** A peer client whose `k8s-pod` type declares logs and lists two pods. */
function peerClient(over: Partial<PluginClient> = {}): PluginClient {
  return {
    listResources: vi.fn(async (typeId: string) =>
      typeId === "k8s-pod"
        ? [instance(), instance({ id: "acc-1:k8s-pod:default:api-1", displayName: "api-1" })]
        : [],
    ),
    renderDetail: vi.fn((r: ResourceInstance) =>
      r.resourceTypeId === "k8s-pod"
        ? { sections: [], logs: { defaultTailLines: 200 } }
        : { sections: [] },
    ),
    getLogs: vi.fn(),
    ...over,
  } as unknown as PluginClient;
}

function parent(over: Partial<SidecarLogParent> = {}): SidecarLogParent {
  return {
    accountId: "acc-1",
    accountName: "GCP",
    resourceId: "parent-1",
    displayName: "prod-cluster",
    fields: {},
    integrations: [{ pluginId: "kubernetes", credentialMappings: [], tabLabel: "Kubernetes" }],
    ...over,
  };
}

function deps(over: Partial<SidecarLogDiscoveryDeps> = {}): SidecarLogDiscoveryDeps {
  return {
    getPeerClient: vi.fn(async () => peerClient()),
    peerResourceTypeIds: vi.fn(async () => ["k8s-pod", "k8s-namespace"]),
    warn: vi.fn(),
    maxResults: 500,
    ...over,
  };
}

beforeEach(() => {
  __resetPeerLogCapabilityCache();
});

describe("peerIntegrationVisible", () => {
  const base = { pluginId: "kubernetes", credentialMappings: [], tabLabel: "K8s" };

  it("gates on requiresFields and showWhen like the detail view", () => {
    expect(peerIntegrationVisible(base, {})).toBe(true);
    expect(peerIntegrationVisible({ ...base, requiresFields: ["endpoint"] }, {})).toBe(false);
    expect(
      peerIntegrationVisible({ ...base, requiresFields: ["endpoint"] }, { endpoint: "1.2.3.4" }),
    ).toBe(true);
    expect(
      peerIntegrationVisible(
        { ...base, showWhen: { fieldKey: "engine", prefix: "POSTGRES_" } },
        { engine: "MYSQL_8" },
      ),
    ).toBe(false);
  });

  it("hides integrations the provider declares unreachable", () => {
    const gated = {
      ...base,
      unreachableWhen: { fieldsEmpty: ["publicIp"], title: "No public IP", suggestions: [] },
    };
    expect(peerIntegrationVisible(gated, { publicIp: "" })).toBe(false);
    expect(peerIntegrationVisible(gated, { publicIp: "1.2.3.4" })).toBe(true);
  });
});

describe("discoverSidecarLogStreams", () => {
  it("lists log-capable peer streams with parent attribution", async () => {
    const d = deps();
    const streams = await discoverSidecarLogStreams([parent()], d);
    expect(streams).toEqual([
      expect.objectContaining({
        resourceId: "acc-1:k8s-pod:default:api-0",
        pluginId: "kubernetes",
        resourceTypeId: "k8s-pod",
        displayName: "api-0",
        parentResourceId: "parent-1",
        parentDisplayName: "prod-cluster",
        accountId: "acc-1",
        accountName: "GCP",
      }),
      expect.objectContaining({ resourceId: "acc-1:k8s-pod:default:api-1" }),
    ]);
    // Only the log-capable type is listed — k8s-namespace renders no logs tab.
    const client = (await (d.getPeerClient as ReturnType<typeof vi.fn>).mock.results[0]!
      .value) as PluginClient;
    expect(client.listResources).toHaveBeenCalledTimes(1);
  });

  it("skips log-incapable peer plugins without rebuilding their client next time", async () => {
    const noLogs = peerClient({ getLogs: undefined });
    const getPeerClient = vi.fn(async () => noLogs);
    const d = deps({ getPeerClient });
    expect(await discoverSidecarLogStreams([parent()], d)).toEqual([]);
    expect(await discoverSidecarLogStreams([parent()], d)).toEqual([]);
    // Second walk hits the cached "log-incapable" verdict.
    expect(getPeerClient).toHaveBeenCalledTimes(1);
  });

  it("keeps other parents alive when one peer build fails, and warns", async () => {
    const good = parent();
    const bad = parent({ resourceId: "parent-2", displayName: "broken-cluster" });
    const getPeerClient = vi.fn(async (p: SidecarLogParent) => {
      if (p.resourceId === "parent-2") throw new Error("kubeconfig fetch failed");
      return peerClient();
    });
    const warn = vi.fn();
    // The broken parent first, so its failure backoff must not skip the good one.
    const streams = await discoverSidecarLogStreams([bad, good], deps({ getPeerClient, warn }));
    expect(streams).toHaveLength(2);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("kubeconfig fetch failed"));
  });

  it("respects maxResults across parents", async () => {
    const streams = await discoverSidecarLogStreams(
      [parent(), parent({ resourceId: "parent-2", displayName: "second" })],
      deps({ maxResults: 3 }),
    );
    expect(streams).toHaveLength(3);
  });

  it("times out a hung parent without losing the rest", async () => {
    const hung = parent({ resourceId: "parent-2", displayName: "hung-cluster" });
    const getPeerClient = vi.fn(async (p: SidecarLogParent) => {
      if (p.resourceId === "parent-2") return new Promise<never>(() => {});
      return peerClient();
    });
    const warn = vi.fn();
    const streams = await discoverSidecarLogStreams(
      [hung, parent()],
      deps({ getPeerClient, warn, parentTimeoutMs: 20 }),
    );
    expect(streams).toHaveLength(2);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("timed out"));
  });
});
