import { describe, expect, it } from "vitest";

import { generateInfraDts } from "../codegen.js";
import { typecheckWorkflow } from "../typecheck.js";
import type { WorkflowPluginInfo } from "../types.js";
import { generateGraphDts } from "./codegen.js";

/**
 * The org-scoped graph typings are the static graph half concatenated with a
 * read-only infra half — two independently authored ambient files. These
 * checks catch the failure mode where an identifier collision between them
 * breaks EVERY graph typecheck at once, and pin that readOnly really strips
 * the mutating surface.
 */

const plugins: WorkflowPluginInfo[] = [
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
        supportsUpdate: true,
        supportsDelete: true,
        capabilities: { ssh: true },
      },
    ],
  },
];

function combinedDts(): string {
  const infraDts = generateInfraDts({
    plugins,
    metrics: [],
    interactive: false,
    costs: false,
    readOnly: true,
  });
  return `${generateGraphDts({ omitFetch: true })}\n${infraDts}`;
}

describe("combined graph typings", () => {
  it("accepts a script using both graph.* and read-only infra.*", () => {
    const result = typecheckWorkflow({
      source: [
        'const [droplet] = await infra.accounts.digitalocean.getByName("prod").droplets.list();',
        'const out = await droplet.ssh("uptime");',
        'graph.render({ chart: { type: "stat", value: out.trim() } });',
      ].join("\n"),
      dts: combinedDts(),
    });
    expect(result.degraded).toBe(false);
    expect(result.diagnostics).toEqual([]);
  });

  it("rejects create() — readOnly stripped the mutating surface", () => {
    const result = typecheckWorkflow({
      source: [
        'await infra.accounts.digitalocean.getByName("prod").droplets.create({ name: "x" });',
        'graph.render({ chart: { type: "stat", value: 1 } });',
      ].join("\n"),
      dts: combinedDts(),
    });
    expect(result.hasErrors).toBe(true);
    expect(result.diagnostics.some((d) => d.message.includes("create"))).toBe(true);
  });

  it("rejects infra.page — typed never in readOnly", () => {
    const result = typecheckWorkflow({
      source: [
        'await infra.page("alert!");',
        'graph.render({ chart: { type: "stat", value: 1 } });',
      ].join("\n"),
      dts: combinedDts(),
    });
    expect(result.hasErrors).toBe(true);
  });
});
