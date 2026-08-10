import { describe, expect, it } from "vitest";

import { generateInfraDts } from "./codegen.js";
import { resolveTsLibDir, typecheckWorkflow } from "./typecheck.js";
import type { WorkflowPluginInfo } from "./types.js";

/**
 * Headless type checking must agree with what the Monaco editor shows an author
 * — same lib, same leniency about top-level await, same line numbers.
 */

const PLUGINS: WorkflowPluginInfo[] = [
  {
    pluginId: "digitalocean",
    displayName: "DigitalOcean",
    accounts: [{ id: "acc1", pluginId: "digitalocean", displayName: "production" }],
    resourceTypes: [
      {
        id: "droplet",
        displayName: "Droplet",
        pluralDisplayName: "Droplets",
        outputs: [{ key: "ipv4", label: "IPv4" }],
        supportsCreate: true,
        supportsUpdate: false,
        supportsDelete: true,
      },
    ],
  },
];

const dts = generateInfraDts({ plugins: PLUGINS, metrics: [], triggerKind: "manual" });

describe("resolveTsLibDir", () => {
  it("finds the TypeScript standard library in a dev checkout", () => {
    // A null here in CI would silently reduce every check below to syntax-only.
    expect(resolveTsLibDir()).not.toBeNull();
  });
});

describe("typecheckWorkflow", () => {
  it("accepts a valid workflow that uses top-level await", async () => {
    const result = typecheckWorkflow({
      source: [
        'const acc = infra.accounts.digitalocean.getByName("production");',
        "const droplets = await acc.droplets.list();",
        "await infra.log(droplets.length);",
      ].join("\n"),
      dts,
    });
    expect(result.degraded).toBe(false);
    expect(result.diagnostics).toEqual([]);
    expect(result.hasErrors).toBe(false);
  });

  it("reports an unknown property on infra with its source position", () => {
    const result = typecheckWorkflow({ source: "\ninfra.nope();\n", dts });
    expect(result.hasErrors).toBe(true);
    expect(result.diagnostics[0]).toMatchObject({ line: 2, category: "error", code: 2339 });
  });

  it("reports a plugin the org has no accounts for", () => {
    // Account *names* are an open union (literals are suggestions, not a
    // constraint), but a plugin namespace that isn't connected does not exist.
    const result = typecheckWorkflow({
      source: 'infra.accounts.hetzner.getByName("production");',
      dts,
    });
    expect(result.hasErrors).toBe(true);
  });

  it("reports an unknown resource group on a connected account", () => {
    const result = typecheckWorkflow({
      source: 'await infra.accounts.digitalocean.getByName("production").databases.list();',
      dts,
    });
    expect(result.hasErrors).toBe(true);
  });

  it("reports syntax errors", () => {
    const result = typecheckWorkflow({ source: "const a = (;", dts });
    expect(result.hasErrors).toBe(true);
    expect(result.diagnostics[0]?.line).toBe(1);
  });

  it("types infra.event as the crossing payload for budget triggers", () => {
    const budgetDts = generateInfraDts({
      plugins: PLUGINS,
      metrics: [],
      interactive: false,
      triggerKind: "budget",
    });
    expect(
      typecheckWorkflow({
        source: "const over: number = infra.event.observedCents - infra.event.amountCents;",
        dts: budgetDts,
      }).hasErrors,
    ).toBe(false);
    // The same access is not available on a manual workflow's event.
    expect(typecheckWorkflow({ source: "infra.event.observedCents;", dts }).hasErrors).toBe(true);
  });

  it("rejects infra.prompt on a non-interactive workflow", () => {
    const cronDts = generateInfraDts({
      plugins: PLUGINS,
      metrics: [],
      interactive: false,
      triggerKind: "cron",
    });
    expect(typecheckWorkflow({ source: 'await infra.prompt("hi");', dts: cronDts }).hasErrors).toBe(
      true,
    );
  });

  it("types infra.costs.write when the host can store cost data", () => {
    const cloudDts = generateInfraDts({
      plugins: PLUGINS,
      metrics: [],
      interactive: false,
      triggerKind: "cron",
      costs: true,
    });
    const source = [
      "const { written } = await infra.costs.write([",
      '  { date: "2026-07-01", currency: "USD", amount: 12.5, service: "Snowflake Compute" },',
      "]);",
      // A single row, not an array, is accepted too.
      'await infra.costs.write({ date: "2026-07-02", currency: "USD", amount: 1 });',
      "await infra.log(written);",
    ].join("\n");
    expect(typecheckWorkflow({ source, dts: cloudDts }).diagnostics).toEqual([]);
    // A wrongly-typed field is caught before the workflow is ever saved.
    expect(
      typecheckWorkflow({
        source: 'await infra.costs.write({ date: 20260701, currency: "USD", amount: 1 });',
        dts: cloudDts,
      }).hasErrors,
    ).toBe(true);
  });

  it("types infra.costs as unavailable when the host has no cost store", () => {
    const localDts = generateInfraDts({
      plugins: PLUGINS,
      metrics: [],
      interactive: false,
      triggerKind: "cron",
      costs: false,
    });
    expect(
      typecheckWorkflow({
        source: 'await infra.costs.write({ date: "2026-07-01", currency: "USD", amount: 1 });',
        dts: localDts,
      }).hasErrors,
    ).toBe(true);
  });

  it("types both call shapes of infra.ai, and rejects a bad model", () => {
    const source = [
      'const r = await infra.ai("Summarize these logs", { model: "claude-haiku-4-5" });',
      "await infra.log(r.text, r.costMicros);",
      'await infra.ai({ prompt: "Classify this error", system: "One word.", maxTokens: 16 });',
    ].join("\n");
    expect(typecheckWorkflow({ source, dts }).diagnostics).toEqual([]);
    // The model allowlist is a closed union — a typo fails at save time, the
    // same place dispatch would refuse it at run time.
    expect(
      typecheckWorkflow({ source: 'await infra.ai("hi", { model: "gpt-4o" });', dts }).hasErrors,
    ).toBe(true);
  });

  it("types infra.ai as unavailable when the host cannot reach a model", () => {
    const localDts = generateInfraDts({
      plugins: PLUGINS,
      metrics: [],
      interactive: false,
      triggerKind: "cron",
      ai: false,
    });
    expect(typecheckWorkflow({ source: 'await infra.ai("hi");', dts: localDts }).hasErrors).toBe(
      true,
    );
  });

  it("types both call shapes of infra.page, and rejects a bad option", () => {
    const source = [
      'const r = await infra.page("3 pods are crash-looping", { key: "restarts" });',
      "if (r.suppressed) await infra.log(r.retryAt);",
      'await infra.page({ message: "still bad", cooldownMinutes: 15, voice: true });',
      'await infra.page.clear("restarts");',
    ].join("\n");
    expect(typecheckWorkflow({ source, dts }).diagnostics).toEqual([]);
    // Author typos in the options bag are caught before the workflow is saved.
    expect(
      typecheckWorkflow({
        source: 'await infra.page("down", { cooldownMinutes: "15" });',
        dts,
      }).hasErrors,
    ).toBe(true);
  });

  it("keeps infra.page available to automated triggers", () => {
    // Paging exists precisely so a cron can wake someone up, so unlike
    // infra.prompt it must survive the non-interactive typings.
    const cronDts = generateInfraDts({
      plugins: PLUGINS,
      metrics: [],
      interactive: false,
      triggerKind: "cron",
    });
    expect(
      typecheckWorkflow({ source: 'await infra.page("nightly check failed");', dts: cronDts })
        .hasErrors,
    ).toBe(false);
  });

  it("types the global fetch, including a JSON body and the response readers", () => {
    const source = [
      'const res = await fetch("https://api.example.com/v1/status", {',
      '  method: "POST",',
      '  headers: { authorization: "Bearer t" },',
      "  body: { probe: true },",
      "  timeoutMs: 5000,",
      "});",
      "if (!res.ok) throw new Error(`HTTP ${res.status}`);",
      "const body = await res.json<{ healthy: boolean }>();",
      'await infra.log(body.healthy, res.headers.get("content-type"));',
    ].join("\n");
    expect(typecheckWorkflow({ source, dts }).diagnostics).toEqual([]);
  });

  it("rejects fetch options and methods the host would refuse at runtime", () => {
    // Better to fail at save time than to fail the run — these are exactly the
    // requests dispatch throws on (see fetch.test.ts).
    expect(
      typecheckWorkflow({
        source: 'await fetch("https://a.example.com/", { method: "TRACE" });',
        dts,
      }).hasErrors,
    ).toBe(true);
    expect(
      typecheckWorkflow({ source: 'await fetch("https://a.example.com/", { timeout: 5 });', dts })
        .hasErrors,
    ).toBe(true);
  });

  it("keeps fetch available to automated triggers", () => {
    // A cron that pulls an API on a schedule is the main reason fetch exists.
    const cronDts = generateInfraDts({
      plugins: PLUGINS,
      metrics: [],
      interactive: false,
      triggerKind: "cron",
    });
    expect(
      typecheckWorkflow({
        source: 'const r = await fetch("https://a.example.com/");',
        dts: cronDts,
      }).hasErrors,
    ).toBe(false);
  });

  it("caps the number of returned diagnostics", () => {
    const source = Array.from({ length: 30 }, () => "infra.nope();").join("\n");
    expect(typecheckWorkflow({ source, dts, limit: 5 }).diagnostics).toHaveLength(5);
  });

  it("degrades to syntax-only when the standard library is missing", () => {
    const result = typecheckWorkflow({ source: "infra.nope();", dts, libDir: "/nonexistent" });
    expect(result.degraded).toBe(true);
    expect(result.diagnostics).toEqual([]);
  });
});
