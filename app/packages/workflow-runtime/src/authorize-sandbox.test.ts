import { describe, expect, it, vi } from "vitest";

import { runWorkflow } from "./sandbox.js";
import type { WorkflowHost } from "./host.js";

/**
 * The `authorize` gate, driven through a real isolate rather than by calling
 * `dispatch` directly.
 *
 * Worth the cost of a real run because the thing being asserted is placement:
 * the gate has to sit ahead of every branch in `dispatch`, so that a refusal
 * means the host method was never reached. A unit test of the predicate proves
 * the policy; only this proves the plumbing — and "the check ran but the delete
 * happened anyway" is precisely the failure that would not show up anywhere
 * else.
 */

function hostFor(overrides: Partial<WorkflowHost>): WorkflowHost {
  return {
    listPlugins: async () => [],
    listMetrics: async () => ({}),
    getMetric: async () => null,
    setMetric: async () => {},
    ...overrides,
  } as unknown as WorkflowHost;
}

describe("authorize in the isolate", () => {
  it("refuses a denied operation before the host method runs", async () => {
    const deleteResource = vi.fn(async () => {});
    const host = hostFor({
      listPlugins: async () => [
        {
          pluginId: "demo",
          displayName: "Demo",
          accounts: [{ id: "acct-1", pluginId: "demo", displayName: "Demo account" }],
          resourceTypes: [
            {
              id: "vm",
              displayName: "VM",
              pluralDisplayName: "Machines",
              outputs: [],
              supportsCreate: true,
              supportsUpdate: true,
              supportsDelete: true,
              storage: false,
              capabilities: {},
            },
          ],
        },
      ],
      listResources: async () => [
        {
          id: "res-1",
          pluginId: "demo",
          resourceTypeId: "vm",
          accountId: "acct-1",
          externalId: "ext-1",
          displayName: "box",
          fields: {},
          resolvedOutputs: {},
        },
      ],
      deleteResource,
    });

    const result = await runWorkflow({
      source: `
        const [box] = await infra.accounts.demo.getByName("Demo account").machines.list();
        try {
          await box.delete();
          infra.output("deleted");
        } catch (e) {
          infra.output(String(e.message ?? e));
        }
      `,
      host,
      interactive: false,
      authorize: (method) => {
        if (method === "resource.delete") throw new Error(`Not permitted: ${method}`);
      },
    });

    expect(result.status).toBe("success");
    expect(String(result.output)).toContain("Not permitted: resource.delete");
    // The point of the whole exercise.
    expect(deleteResource).not.toHaveBeenCalled();
  });

  it("lets an allowed operation through untouched", async () => {
    const listResources = vi.fn(async () => []);
    const host = hostFor({
      listPlugins: async () => [
        {
          pluginId: "demo",
          displayName: "Demo",
          accounts: [{ id: "acct-1", pluginId: "demo", displayName: "Demo account" }],
          resourceTypes: [
            {
              id: "vm",
              displayName: "VM",
              pluralDisplayName: "Machines",
              outputs: [],
              supportsCreate: false,
              supportsUpdate: false,
              supportsDelete: true,
              storage: false,
              capabilities: {},
            },
          ],
        },
      ],
      listResources,
    });

    const seen: string[] = [];
    const result = await runWorkflow({
      source: `
        const boxes = await infra.accounts.demo.getByName("Demo account").machines.list();
        infra.output(boxes.length);
      `,
      host,
      interactive: false,
      authorize: (method) => {
        seen.push(method);
      },
    });

    expect(result.status).toBe("success");
    expect(result.output).toBe(0);
    expect(listResources).toHaveBeenCalled();
    expect(seen).toContain("resource.list");
  });

  it("runs ungated when no authorize is supplied", async () => {
    // The desktop host passes none — a workflow there runs as the one local
    // user, and adding a gate would mean inventing a role system for a
    // single-user app.
    const deleteResource = vi.fn(async () => {});
    const host = hostFor({
      listPlugins: async () => [
        {
          pluginId: "demo",
          displayName: "Demo",
          accounts: [{ id: "acct-1", pluginId: "demo", displayName: "Demo account" }],
          resourceTypes: [
            {
              id: "vm",
              displayName: "VM",
              pluralDisplayName: "Machines",
              outputs: [],
              supportsCreate: false,
              supportsUpdate: false,
              supportsDelete: true,
              storage: false,
              capabilities: {},
            },
          ],
        },
      ],
      listResources: async () => [
        {
          id: "res-1",
          pluginId: "demo",
          resourceTypeId: "vm",
          accountId: "acct-1",
          externalId: "ext-1",
          displayName: "box",
          fields: {},
          resolvedOutputs: {},
        },
      ],
      deleteResource,
    });

    const result = await runWorkflow({
      source: `
        const [box] = await infra.accounts.demo.getByName("Demo account").machines.list();
        await box.delete();
        infra.output("deleted");
      `,
      host,
      interactive: false,
    });

    expect(result.status).toBe("success");
    expect(deleteResource).toHaveBeenCalled();
  });
});
