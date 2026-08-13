import { describe, expect, it } from "vitest";

import { generateInfraDts, generateInfraDtsParts } from "./codegen.js";
import type { WorkflowPluginInfo } from "./types.js";

/**
 * The parts split exists so the MCP/chat tool can send the typings in pieces
 * instead of one large blob. What matters: `full` stays the exact file the
 * editor and type checker use, `global` omits (but still references) every
 * named interface, and `types` carries each named declaration verbatim.
 */

const PLUGINS: WorkflowPluginInfo[] = [
  {
    pluginId: "digitalocean",
    displayName: "DigitalOcean",
    accounts: [{ id: "acc1", pluginId: "digitalocean", displayName: "production" }],
    resourceTypes: [
      {
        id: "doks-cluster",
        displayName: "Kubernetes Cluster",
        pluralDisplayName: "Kubernetes Clusters",
        outputs: [],
        supportsCreate: true,
        supportsUpdate: false,
        supportsDelete: true,
        sidecars: [
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
                supportsCreate: false,
                supportsUpdate: false,
                supportsDelete: true,
              },
            ],
          },
        ],
      },
    ],
  },
];

const input = { plugins: PLUGINS, metrics: [], triggerKind: "manual" as const };

describe("generateInfraDtsParts", () => {
  it("reassembles to exactly what generateInfraDts returns", () => {
    expect(generateInfraDtsParts(input).full).toBe(generateInfraDts(input));
  });

  it("names every generated interface, in file order", () => {
    const { full, types } = generateInfraDtsParts(input);
    expect(types.map((t) => t.name)).toEqual([
      "Resource_digitalocean_doks_cluster",
      "Resource_kubernetes_k8s_pod",
      "Sidecar_kubernetes",
      "Account_digitalocean",
      "AccountGroup_digitalocean",
    ]);
    let cursor = 0;
    for (const t of types) {
      expect(t.dts).toContain(`interface ${t.name}`);
      const at = full.indexOf(t.dts, cursor);
      expect(at, `${t.name} should appear in full after the previous part`).toBeGreaterThanOrEqual(
        cursor,
      );
      cursor = at + t.dts.length;
    }
  });

  it("omits the named interfaces from the global scope but keeps the references", () => {
    const { global } = generateInfraDtsParts(input);
    expect(global).not.toContain("interface Resource_");
    expect(global).not.toContain("interface Sidecar_");
    expect(global).not.toContain("interface Account_");
    expect(global).not.toContain("interface AccountGroup_");
    // The traversal entry points survive: InfraAccounts references each
    // plugin's group interface by name, and the rest of the API is intact.
    expect(global).toContain("readonly digitalocean: AccountGroup_digitalocean;");
    expect(global).toContain("declare const infra: InfraApi;");
    expect(global).toContain("interface InfraMetrics");
    expect(global).toContain("declare function fetch(");
  });

  it("types only assigned secret names as readonly strings", () => {
    const dts = generateInfraDts({
      ...input,
      secrets: [
        { key: "secret-1", name: "API_TOKEN" },
        { key: "secret-2", name: "stripe.apiKey" },
      ],
    });
    expect(dts).toContain("readonly API_TOKEN: string;");
    expect(dts).toContain("readonly stripe: {");
    expect(dts).toContain("readonly apiKey: string;");
    expect(dts).toContain("readonly secrets: InfraSecrets;");
  });

  it("emits an empty typed secret interface with no assignments", () => {
    const dts = generateInfraDts(input);
    expect(dts).toContain("interface InfraSecrets {}");
  });

  it.each([
    ["scalar first", ["stripe", "stripe.apiKey"]],
    ["nested first", ["stripe.apiKey", "stripe"]],
  ])("rejects colliding secret paths (%s)", (_label, names) => {
    expect(() =>
      generateInfraDts({
        ...input,
        secrets: names.map((name, index) => ({ key: `secret-${index}`, name })),
      }),
    ).toThrow('Workflow secret names "stripe" and "stripe.apiKey" cannot coexist.');
  });

  it("rejects duplicate assigned secret names", () => {
    expect(() =>
      generateInfraDts({
        ...input,
        secrets: [
          { key: "secret-1", name: "API_TOKEN" },
          { key: "secret-2", name: "API_TOKEN" },
        ],
      }),
    ).toThrow('Workflow secret name "API_TOKEN" is assigned more than once.');
  });
});
