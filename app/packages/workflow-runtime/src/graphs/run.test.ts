import { describe, expect, it, vi } from "vitest";

import { runGraph } from "./run.js";
import type { GraphHost } from "./types.js";

/**
 * The graph prelude is a source string, so nothing type-checks it — these run
 * a real isolate to prove the control lifecycle, the render round-trip, and
 * the fail-closed dispatcher actually behave.
 */

function hostFor(overrides: Partial<GraphHost> = {}): GraphHost {
  return {
    queryCosts: async () => ({ series: [], totals: {}, currencies: [] }),
    listResources: async () => [],
    metricSeries: async () => [],
    dataGet: async () => null,
    dataSet: async () => {},
    dataDelete: async () => {},
    dataList: async () => [],
    ...overrides,
  };
}

describe("runGraph", () => {
  it("renders a chart with declared controls resolved from state", async () => {
    const result = await runGraph({
      source: [
        'const range = graph.controls.select("range", {',
        '  label: "Range",',
        '  options: [{ value: "7", label: "7d" }, { value: "30", label: "30d" }],',
        '  default: "30",',
        "});",
        'const detailed = graph.controls.checkbox("detailed", { label: "Detailed" });',
        "graph.render({",
        '  title: "Range " + range + " detailed " + detailed,',
        '  chart: { type: "line", series: [{ key: "a", points: [{ x: "2026-07-01", y: 1 }] }] },',
        "  refreshSeconds: 60,",
        "});",
      ].join("\n"),
      host: hostFor(),
      controls: { range: "7", detailed: true },
    });

    expect(result.status).toBe("success");
    expect(result.spec?.title).toBe("Range 7 detailed true");
    expect(result.spec?.refreshSeconds).toBe(60);
    expect(result.spec?.controls).toEqual([
      {
        kind: "select",
        id: "range",
        label: "Range",
        options: [
          { value: "7", label: "7d" },
          { value: "30", label: "30d" },
        ],
        value: "7",
      },
      { kind: "checkbox", id: "detailed", label: "Detailed", value: true },
    ]);
  });

  it("falls back to defaults when the state holds an invalid value", async () => {
    const result = await runGraph({
      source: [
        'const r = graph.controls.select("r", { options: ["a", "b"], default: "b" });',
        'graph.render({ chart: { type: "stat", value: r } });',
      ].join("\n"),
      host: hostFor(),
      controls: { r: "not-an-option" },
    });
    expect(result.status).toBe("success");
    expect(result.spec?.chart).toEqual({ type: "stat", value: "b" });
  });

  it("reports a button press through graph.event and the control's return", async () => {
    const result = await runGraph({
      source: [
        'const pressed = graph.controls.button("reset", { label: "Reset" });',
        'graph.render({ chart: { type: "stat", value: pressed ? 1 : 0, caption: graph.event.button } });',
      ].join("\n"),
      host: hostFor(),
      button: "reset",
    });
    expect(result.status).toBe("success");
    expect(result.spec?.chart).toMatchObject({ value: 1, caption: "reset" });
  });

  it("passes cost queries through the host, normalized", async () => {
    let seen: unknown;
    const result = await runGraph({
      source: [
        'const costs = await graph.costs.query({ days: 7, groupBy: "provider" });',
        'graph.render({ chart: { type: "stacked_bar", series: costs.series } });',
      ].join("\n"),
      host: hostFor({
        queryCosts: async (q) => {
          seen = q;
          return {
            series: [{ key: "aws", label: "AWS", points: [{ x: "2026-07-01", y: 2 }] }],
            totals: { USD: 2 },
            currencies: ["USD"],
          };
        },
      }),
    });
    expect(result.status).toBe("success");
    expect(seen).toMatchObject({ binning: "daily", groupBy: "provider", topN: 10 });
    const chart = result.spec?.chart;
    expect(chart && "series" in chart ? chart.series[0]?.key : undefined).toBe("aws");
  });

  it("round-trips the data store — the guest reads the VALUE back, not an envelope", async () => {
    // Pre-seeded, so the second-run path is exercised: a wrapped {value: 1}
    // would read as non-number and reset the counter to 1 forever.
    const store = new Map<string, unknown>([["count", 1]]);
    const result = await runGraph({
      source: [
        'const prev = await graph.data.get("count");',
        'const next = (typeof prev === "number" ? prev : 0) + 1;',
        'await graph.data.set("count", next);',
        'graph.render({ chart: { type: "stat", value: next } });',
      ].join("\n"),
      host: hostFor({
        dataGet: async (key) => (store.has(key) ? store.get(key) : null),
        dataSet: async (key, value) => {
          store.set(key, value);
        },
      }),
    });
    expect(result.status).toBe("success");
    expect(store.get("count")).toBe(2);
    expect(result.spec?.chart).toEqual({ type: "stat", value: 2 });
  });

  it("reads a never-set key as null, so ?? fallbacks work", async () => {
    const result = await runGraph({
      source: [
        'const v = (await graph.data.get("missing")) ?? "fallback";',
        'graph.render({ chart: { type: "stat", value: v } });',
      ].join("\n"),
      host: hostFor(),
    });
    expect(result.status).toBe("success");
    expect(result.spec?.chart).toEqual({ type: "stat", value: "fallback" });
  });

  it("surfaces the trigger as graph.event.kind", async () => {
    const result = await runGraph({
      source: 'graph.render({ chart: { type: "stat", value: 1, caption: graph.event.kind } });',
      host: hostFor(),
      trigger: "refresh",
    });
    expect(result.status).toBe("success");
    expect(result.spec?.chart).toMatchObject({ caption: "refresh" });
  });

  it("rejects a table row wider than its declared columns", async () => {
    const result = await runGraph({
      source:
        'graph.render({ chart: { type: "table", columns: ["a", "b"], rows: [["x", "y", "z"]] } });',
      host: hostFor(),
    });
    expect(result.status).toBe("failure");
    expect(result.error?.message).toContain("3 cells");
  });

  it("fails when the script never renders", async () => {
    const result = await runGraph({ source: "const x = 1;", host: hostFor() });
    expect(result.status).toBe("failure");
    expect(result.error?.message).toContain("graph.render");
  });

  it("fails closed on workflow host methods", async () => {
    const result = await runGraph({
      source: [
        // Bypass the prelude entirely — a hostile script talking straight to __host.
        'await (globalThis.__hostRef || __host)("resource.delete", JSON.stringify({}));',
        'graph.render({ chart: { type: "stat", value: 1 } });',
      ].join("\n"),
      host: hostFor(),
    });
    expect(result.status).toBe("failure");
    expect(result.error?.message).toContain("not available in a custom graph");
  });

  it("rejects an invalid render spec", async () => {
    const result = await runGraph({
      source: 'graph.render({ chart: { type: "line", series: [] } });',
      host: hostFor(),
    });
    expect(result.status).toBe("failure");
    expect(result.error?.message).toContain("non-empty");
  });

  it("clamps refreshSeconds to the floor", async () => {
    const result = await runGraph({
      source: 'graph.render({ chart: { type: "stat", value: 1 }, refreshSeconds: 1 });',
      host: hostFor(),
    });
    expect(result.status).toBe("success");
    expect(result.spec?.refreshSeconds).toBe(30);
  });

  it("enforces the per-run cost-query budget", async () => {
    const result = await runGraph({
      source: [
        "for (let i = 0; i < 12; i++) await graph.costs.query({ days: 1 });",
        'graph.render({ chart: { type: "stat", value: 1 } });',
      ].join("\n"),
      host: hostFor(),
    });
    expect(result.status).toBe("failure");
    expect(result.error?.message).toContain("at most 10 cost queries");
  });

  it("routes console output to the run log", async () => {
    const result = await runGraph({
      source: [
        'console.log("hello", { a: 1 });',
        'graph.render({ chart: { type: "stat", value: 1 } });',
      ].join("\n"),
      host: hostFor(),
    });
    expect(result.status).toBe("success");
    expect(result.logs.map((l) => l.message)).toContain('hello {"a":1}');
  });
});

describe("runGraph infra access", () => {
  const tree = [
    {
      pluginId: "digitalocean",
      displayName: "DigitalOcean",
      accounts: [{ id: "acc1", pluginId: "digitalocean", displayName: "prod" }],
      resourceTypes: [
        {
          id: "droplet",
          displayName: "Droplet",
          pluralDisplayName: "Droplets",
          outputs: [],
          supportsCreate: true,
          supportsUpdate: false,
          supportsDelete: true,
        },
      ],
    },
  ];

  function infraFor(overrides: Record<string, unknown> = {}, authorize = vi.fn()) {
    const droplet = {
      id: "d1",
      pluginId: "digitalocean",
      resourceTypeId: "droplet",
      accountId: "acc1",
      displayName: "web-1",
      fields: {},
      resolvedOutputs: {},
    };
    const host = {
      listPlugins: async () => tree,
      listResources: async () => [droplet],
      getResource: async () => droplet,
      resolveOutput: async () => "203.0.113.7",
      listStorageObjects: async () => [],
      readStorageObject: async () => ({ base64: "", text: "" }),
      prompt: async () => {
        throw new Error("no prompts in graphs");
      },
      getMetric: async () => null,
      setMetric: async () => {},
      listMetrics: async () => ({}),
      createResource: async () => {
        throw new Error("createResource must never be reached from a graph");
      },
      deleteResource: async () => {
        throw new Error("deleteResource must never be reached from a graph");
      },
      sshExec: async () => ({
        stdoutBase64: Buffer.from("uptime ok", "utf8").toString("base64"),
        stderrBase64: "",
        code: 0,
      }),
      ...overrides,
    };
    return {
      authorize,
      infra: {
        accountsTreeJson: JSON.stringify(tree),
        host: host as never,
        authorize,
      },
    };
  }

  it("lists resources through infra.accounts and authorizes reads", async () => {
    const { infra, authorize } = infraFor();
    const result = await runGraph({
      source: [
        'const account = infra.accounts.digitalocean.getByName("prod");',
        "const droplets = await account.droplets.list();",
        'graph.render({ chart: { type: "stat", value: droplets.length, caption: droplets[0].displayName } });',
      ].join("\n"),
      host: hostFor(),
      infra,
    });
    expect(result.error).toBeUndefined();
    expect(result.spec?.chart).toMatchObject({ value: 1, caption: "web-1" });
    expect(authorize).toHaveBeenCalledWith("read");
  });

  it("runs ssh with a clamped timeout under the execute action", async () => {
    const seen: unknown[] = [];
    const { infra, authorize } = infraFor({
      sshExec: async (params: Record<string, unknown>) => {
        seen.push(params);
        return {
          stdoutBase64: Buffer.from("14:02 up 3 days", "utf8").toString("base64"),
          stderrBase64: "",
          code: 0,
        };
      },
    });
    const result = await runGraph({
      source: [
        'const [droplet] = await infra.accounts.digitalocean.getByName("prod").droplets.list();',
        'const out = await droplet.ssh("uptime", { timeoutMs: 999999 });',
        'graph.render({ chart: { type: "stat", value: out.trim() } });',
      ].join("\n"),
      host: hostFor(),
      infra,
    });
    expect(result.error).toBeUndefined();
    expect(result.spec?.chart).toMatchObject({ value: "14:02 up 3 days" });
    expect(authorize).toHaveBeenCalledWith("execute");
    expect((seen[0] as { timeoutMs: number }).timeoutMs).toBe(30_000);
  });

  it("fails closed on mutations even with infra enabled", async () => {
    const { infra } = infraFor();
    const result = await runGraph({
      source: [
        'const account = infra.accounts.digitalocean.getByName("prod");',
        'await account.droplets.create({ name: "nope" });',
        'graph.render({ chart: { type: "stat", value: 1 } });',
      ].join("\n"),
      host: hostFor(),
      infra,
    });
    expect(result.status).toBe("failure");
    expect(result.error?.message).toContain("not available in a custom graph");
  });

  it("surfaces an authorization denial as the script's error", async () => {
    const { infra } = infraFor(
      {},
      vi.fn().mockImplementation(() => {
        throw new Error("The author of this graph no longer has resources:read.");
      }),
    );
    const result = await runGraph({
      source: [
        'await infra.accounts.digitalocean.getByName("prod").droplets.list();',
        'graph.render({ chart: { type: "stat", value: 1 } });',
      ].join("\n"),
      host: hostFor(),
      infra,
    });
    expect(result.status).toBe("failure");
    expect(result.error?.message).toContain("no longer has resources:read");
  });

  it("explains itself when infra is not configured", async () => {
    const result = await runGraph({
      // Straight to the RPC: without a tree the prelude has no account handle,
      // so this is the only way to reach a whitelisted method infra-less.
      source: [
        'await __host("resource.list", JSON.stringify({ accountId: "acc1", typeId: "droplet" }));',
        'graph.render({ chart: { type: "stat", value: 1 } });',
      ].join("\n"),
      host: hostFor(),
    });
    expect(result.status).toBe("failure");
    expect(result.error?.message).toContain("no recorded author");
  });

  it("enforces the per-run SSH command budget", async () => {
    const { infra } = infraFor();
    const result = await runGraph({
      source: [
        'const [droplet] = await infra.accounts.digitalocean.getByName("prod").droplets.list();',
        'for (let i = 0; i < 12; i++) await droplet.ssh("true");',
        'graph.render({ chart: { type: "stat", value: 1 } });',
      ].join("\n"),
      host: hostFor(),
      infra,
    });
    expect(result.status).toBe("failure");
    expect(result.error?.message).toContain("at most 10 SSH commands");
  });
});
