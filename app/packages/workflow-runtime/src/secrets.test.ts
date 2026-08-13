import { describe, expect, it } from "vitest";

import type { WorkflowHost } from "./host.js";
import { runWorkflow } from "./sandbox.js";

const host = {
  listPlugins: async () => [],
  listMetrics: async () => ({}),
  getMetric: async () => null,
  setMetric: async () => {},
} as unknown as WorkflowHost;

describe("workflow secrets sandbox", () => {
  it("executes with a synchronous frozen assigned-value snapshot", async () => {
    const result = await runWorkflow({
      source: `
        const tokenWorks = infra.secrets.stripe.apiKey === "super-secret-token";
        const mutationBlocked = (() => {
          try {
            infra.secrets.stripe.apiKey = "changed";
            return false;
          } catch {
            return true;
          }
        })();
        infra.output({ tokenWorks, mutationBlocked });
      `,
      host,
      interactive: false,
      secrets: { "stripe.apiKey": "super-secret-token" },
    });

    expect(result.status).toBe("success");
    expect(result.output).toEqual({ tokenWorks: true, mutationBlocked: true });
  });

  it("redacts exact values from persisted logs, output, and errors", async () => {
    const result = await runWorkflow({
      source: `
        await infra.log("token=super-secret-token");
        infra.output({ nested: ["super-secret-token"] });
        throw new Error("failed with super-secret-token");
      `,
      host,
      interactive: false,
      secrets: { API_TOKEN: "super-secret-token" },
    });

    expect(result.logs[0]?.message).toBe("token=[REDACTED]");
    expect(result.output).toEqual({ nested: ["[REDACTED]"] });
    expect(result.error?.message).toBe("failed with [REDACTED]");
    expect(JSON.stringify(result)).not.toContain("super-secret-token");
  });

  it("fails before isolate execution when an assigned value is missing", async () => {
    const result = await runWorkflow({
      source: `infra.output("must not run");`,
      host,
      interactive: false,
      secrets: { BROKEN_SECRET: undefined } as unknown as Record<string, string>,
    });

    expect(result.status).toBe("failure");
    expect(result.output).toBeUndefined();
    expect(result.error?.message).toContain('Assigned workflow secret "BROKEN_SECRET"');
    expect(JSON.stringify(result)).not.toContain("must not run");
  });

  it.each([
    ["scalar first", { stripe: "one", "stripe.apiKey": "two" }],
    ["nested first", { "stripe.apiKey": "two", stripe: "one" }],
  ])("fails before execution for colliding secret paths (%s)", async (_label, secrets) => {
    const result = await runWorkflow({
      source: `infra.output("must not run");`,
      host,
      interactive: false,
      secrets,
    });

    expect(result.status).toBe("failure");
    expect(result.output).toBeUndefined();
    expect(result.error?.message).toContain(
      'Workflow secret names "stripe" and "stripe.apiKey" cannot coexist.',
    );
  });
});
