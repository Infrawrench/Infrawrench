import { describe, expect, it, vi } from "vitest";

import { generateInfraDts } from "./codegen.js";
import { dispatch, type WorkflowHost, type WorkflowRunContext } from "./host.js";
import { attachSidecarInfo } from "./sidecars.js";
import { typecheckWorkflow } from "./typecheck.js";
import type { WorkflowPluginInfo, WorkflowResourceTypeInfo } from "./types.js";

/**
 * Sidecars — the peer plugins a resource exposes (a managed cluster's
 * `kubernetes`, a managed database's `postgres`) — used to exist at every layer
 * except the one an author writes against. A workflow could not name what runs
 * inside its own cluster, and nothing in the typings said so, so the only way to
 * find that out was to guess an accessor and watch it come back `undefined`.
 */

const K8S_TYPES: WorkflowResourceTypeInfo[] = [
  {
    id: "k8s-pod",
    displayName: "Pod",
    pluralDisplayName: "Pods",
    outputs: [],
    supportsCreate: true,
    supportsUpdate: false,
    supportsDelete: true,
    capabilities: { logs: true, describe: true },
  },
  {
    id: "k8s-deployment",
    displayName: "Deployment",
    pluralDisplayName: "Deployments",
    outputs: [],
    supportsCreate: true,
    supportsUpdate: true,
    supportsDelete: true,
  },
];

const PLUGINS: WorkflowPluginInfo[] = [
  {
    pluginId: "gcp",
    displayName: "Google Cloud",
    accounts: [{ id: "acc1", pluginId: "gcp", displayName: "Infrawrench GCP" }],
    resourceTypes: [
      {
        id: "gke-cluster",
        displayName: "GKE Cluster",
        pluralDisplayName: "GKE Clusters",
        outputs: [{ key: "kubeconfig", label: "Kubeconfig" }],
        supportsCreate: true,
        supportsUpdate: false,
        supportsDelete: true,
        sidecars: [
          {
            pluginId: "kubernetes",
            displayName: "Kubernetes",
            tabLabel: "Kubernetes",
            resourceTypes: K8S_TYPES,
          },
        ],
      },
    ],
  },
];

const dts = generateInfraDts({ plugins: PLUGINS, metrics: [], triggerKind: "cron", costs: true });

describe("sidecars in the generated typings", () => {
  it("types the workflow that motivated this: page on pods with too many restarts", () => {
    const source = [
      'const account = infra.accounts.gcp.getByName("Infrawrench GCP");',
      "for (const cluster of await account.gkeClusters.list()) {",
      "  for (const pod of await cluster.kubernetes.pods.list()) {",
      "    if (Number(pod.fields.restarts) > 3) {",
      "      await infra.page(`${pod.displayName} restarted ${pod.fields.restarts} times`, {",
      "        key: `pod-restarts-${pod.id}`,",
      "      });",
      "    }",
      "  }",
      "}",
    ].join("\n");
    const result = typecheckWorkflow({ source, dts });
    expect(result.diagnostics).toEqual([]);
    expect(result.hasErrors).toBe(false);
  });

  it("rejects the accessor the model guessed when nothing was typed", () => {
    // `cluster.pods()` was invented because the real path wasn't discoverable.
    // It has to fail loudly rather than resolve to undefined at runtime.
    const result = typecheckWorkflow({
      source: [
        'const account = infra.accounts.gcp.getByName("Infrawrench GCP");',
        "const cluster = (await account.gkeClusters.list())[0]!;",
        "await cluster.pods();",
      ].join("\n"),
      dts,
    });
    expect(result.hasErrors).toBe(true);
  });

  it("carries the peer plugin's own capabilities onto its resources", () => {
    const ok = typecheckWorkflow({
      source: [
        'const account = infra.accounts.gcp.getByName("Infrawrench GCP");',
        "const cluster = (await account.gkeClusters.list())[0]!;",
        "const pod = (await cluster.kubernetes.pods.list())[0]!;",
        "await infra.log(await pod.logs({ tailLines: 50 }));",
        "await infra.log(await pod.describe());",
      ].join("\n"),
      dts,
    });
    expect(ok.diagnostics).toEqual([]);

    // A deployment declares neither, so neither is offered on one.
    const bad = typecheckWorkflow({
      source: [
        'const account = infra.accounts.gcp.getByName("Infrawrench GCP");',
        "const cluster = (await account.gkeClusters.list())[0]!;",
        "await (await cluster.kubernetes.deployments.list())[0]!.logs();",
      ].join("\n"),
      dts,
    });
    expect(bad.hasErrors).toBe(true);
  });

  it("offers only the write operations the peer type actually supports", () => {
    const result = typecheckWorkflow({
      source: [
        'const account = infra.accounts.gcp.getByName("Infrawrench GCP");',
        "const cluster = (await account.gkeClusters.list())[0]!;",
        // Pods are supportsUpdate: false.
        'await cluster.kubernetes.pods.update("id", {});',
      ].join("\n"),
      dts,
    });
    expect(result.hasErrors).toBe(true);
  });

  it("declares each interface once when a peer plugin also has its own account", () => {
    // Duplicate `interface Resource_kubernetes_k8s_pod` would be a hard TS
    // error in every workflow the org writes, not just ones touching sidecars.
    const withStandalone = generateInfraDts({
      plugins: [
        ...PLUGINS,
        {
          pluginId: "kubernetes",
          displayName: "Kubernetes",
          accounts: [{ id: "acc2", pluginId: "kubernetes", displayName: "staging cluster" }],
          resourceTypes: K8S_TYPES,
        },
      ],
      metrics: [],
      triggerKind: "cron",
    });
    const occurrences = withStandalone.match(/interface Resource_kubernetes_k8s_pod\b/g) ?? [];
    expect(occurrences).toHaveLength(1);

    // Both routes to a pod work, and they agree on the type.
    const result = typecheckWorkflow({
      source: [
        'const cluster = (await infra.accounts.gcp.getByName("Infrawrench GCP").gkeClusters.list())[0]!;',
        'const direct = infra.accounts.kubernetes.getByName("staging cluster");',
        "const a = (await cluster.kubernetes.pods.list())[0]!;",
        "const b = (await direct.pods.list())[0]!;",
        "const same: typeof a = b;",
        "await infra.log(same.id);",
      ].join("\n"),
      dts: withStandalone,
    });
    expect(result.diagnostics).toEqual([]);
  });

  it("does not offer ssh or bucket reads on something inside a cluster", () => {
    // Both resolve against the account's own plugin — an SSH endpoint, a bucket
    // name — which a pod borrowing a parent's credentials doesn't have.
    const result = typecheckWorkflow({
      source: [
        'const cluster = (await infra.accounts.gcp.getByName("Infrawrench GCP").gkeClusters.list())[0]!;',
        'await (await cluster.kubernetes.pods.list())[0]!.ssh("ls");',
      ].join("\n"),
      dts,
    });
    expect(result.hasErrors).toBe(true);
  });
});

describe("attachSidecarInfo", () => {
  const gkeDef = {
    id: "gke-cluster",
    displayName: "GKE Cluster",
    pluralDisplayName: "GKE Clusters",
    fields: [],
    peerIntegrations: [
      {
        pluginId: "kubernetes",
        credentialMappings: [{ outputKey: "kubeconfig", credentialKey: "kubeconfig" }],
        tabLabel: "Kubernetes",
      },
    ],
  };
  const bucketDef = {
    id: "gcs-bucket",
    displayName: "GCS Bucket",
    pluralDisplayName: "GCS Buckets",
    fields: [],
  };
  const k8sPlugin = {
    manifest: { id: "kubernetes", displayName: "Kubernetes" },
    resourceTypes: [
      {
        id: "k8s-pod",
        displayName: "Pod",
        pluralDisplayName: "Pods",
        fields: [],
        supportsCreate: true,
      },
    ],
  };

  const infosFor = (ids: string[]): WorkflowResourceTypeInfo[] =>
    ids.map((id) => ({
      id,
      displayName: id,
      pluralDisplayName: id,
      outputs: [],
      supportsCreate: false,
      supportsUpdate: false,
      supportsDelete: false,
    }));

  it("attaches the peer plugin's resource types to the type that declares it", async () => {
    const infos = infosFor(["gke-cluster", "gcs-bucket"]);
    await attachSidecarInfo(infos, [gkeDef, bucketDef] as never, async () => k8sPlugin as never);

    expect(infos[0]?.sidecars).toEqual([
      {
        pluginId: "kubernetes",
        displayName: "Kubernetes",
        tabLabel: "Kubernetes",
        resourceTypes: [
          {
            id: "k8s-pod",
            displayName: "Pod",
            pluralDisplayName: "Pods",
            outputs: [],
            supportsCreate: true,
            supportsUpdate: false,
            supportsDelete: true,
            capabilities: {},
          },
        ],
      },
    ]);
    // A type with no peer integrations is left alone entirely.
    expect(infos[1]?.sidecars).toBeUndefined();
  });

  it("skips a peer plugin that isn't installed rather than typing an empty one", async () => {
    const infos = infosFor(["gke-cluster"]);
    await attachSidecarInfo(infos, [gkeDef] as never, async () => undefined);
    expect(infos[0]?.sidecars).toBeUndefined();
  });
});

describe("dispatch", () => {
  const ctx: WorkflowRunContext = { interactive: false, log: () => {}, setOutput: () => {} };

  it("forwards the sidecar ref so the host builds the peer plugin's client", async () => {
    const listResources = vi.fn().mockResolvedValue([]);
    const host = { listResources } as unknown as WorkflowHost;

    await dispatch(host, ctx, "resource.list", {
      accountId: "acc1",
      typeId: "k8s-pod",
      sidecar: { pluginId: "kubernetes", parentResourceId: "acc1:gke-cluster:prod" },
    });
    expect(listResources).toHaveBeenCalledWith("acc1", "k8s-pod", {
      pluginId: "kubernetes",
      parentResourceId: "acc1:gke-cluster:prod",
    });

    // Ordinary calls stay ordinary — no ref, the account's own plugin.
    await dispatch(host, ctx, "resource.list", { accountId: "acc1", typeId: "gke-cluster" });
    expect(listResources).toHaveBeenLastCalledWith("acc1", "gke-cluster", undefined);
  });

  it("ignores a half-specified ref instead of passing on something unresolvable", async () => {
    const getLogs = vi.fn().mockResolvedValue({ text: "", containers: [], activeContainer: "" });
    const host = { getLogs } as unknown as WorkflowHost;
    await dispatch(host, ctx, "resource.logs", {
      accountId: "acc1",
      typeId: "k8s-pod",
      resourceId: "p1",
      sidecar: { pluginId: "kubernetes" },
    });
    expect(getLogs).toHaveBeenCalledWith("acc1", "k8s-pod", "p1", {}, undefined);
  });
});
