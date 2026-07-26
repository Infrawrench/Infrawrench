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
