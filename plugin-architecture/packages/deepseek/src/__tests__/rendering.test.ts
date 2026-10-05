import { describe, expect, it } from "vitest";
import { runPluginRenderingTests } from "@infrawrench/plugin-base/test-harness";
import type { ResourceInstance } from "@infrawrench/plugin-base";
import { plugin } from "../plugin.js";
import { DeepSeekClient } from "../client.js";

runPluginRenderingTests(plugin);

const ACCOUNT = "acct-1";

function client(): DeepSeekClient {
  return new DeepSeekClient({ apiKey: "sk-test" });
}

function resource(
  resourceTypeId: string,
  externalId: string,
  fields: Record<string, string | number | boolean>,
): ResourceInstance {
  return {
    id: `${ACCOUNT}:${resourceTypeId}:${externalId}`,
    pluginId: "deepseek",
    resourceTypeId,
    accountId: ACCOUNT,
    displayName: externalId,
    externalId,
    fields,
    resolvedOutputs: {},
    secretStates: [],
    createdAt: "2026-07-01T00:00:00Z",
    updatedAt: "2026-07-01T00:00:00Z",
  };
}

describe("renderDetail", () => {
  it("says plainly that DeepSeek has no usage or cost API", () => {
    const schema = client().renderDetail(
      resource("balance", "USD", {
        currency: "USD",
        totalBalance: 110,
        grantedBalance: 10,
        toppedUpBalance: 100,
        isAvailable: true,
      }),
    );

    expect(schema.subtitle).toBe("110.00 USD remaining");
    expect(schema.status?.status).toBe("healthy");
    const billing = schema.sections.find((s) => s.title === "Billing")!;
    const note = billing.children.find((n) => n.kind === "text");
    if (note?.kind !== "text") throw new Error("expected a text node");
    expect(note.content).toMatch(/no usage time series/);
  });

  it("flags an exhausted balance as an error, not merely degraded", () => {
    const schema = client().renderDetail(
      resource("balance", "USD", {
        currency: "USD",
        totalBalance: 0,
        grantedBalance: 0,
        toppedUpBalance: 0,
        isAvailable: false,
      }),
    );
    expect(schema.status?.status).toBe("error");
  });

  it("documents concurrency rather than inventing an RPM limit", () => {
    const schema = client().renderDetail(
      resource("model", "deepseek-v4-flash", {
        modelId: "deepseek-v4-flash",
        ownedBy: "deepseek",
        concurrencyLimit: 2500,
      }),
    );

    const notes = schema.sections[0]!.children.filter((n) => n.kind === "text");
    const joined = notes.map((n) => (n.kind === "text" ? n.content : "")).join(" ");
    expect(joined).toMatch(/has no RPM or TPM limit/);
    // The canonical base URL has no /v1 segment.
    expect(joined).toMatch(/https:\/\/api\.deepseek\.com\/chat\/completions/);
  });
});

describe("renderDetail: models and files", () => {
  it("renders published peak and off-peak prices for a priced model", () => {
    const schema = client().renderDetail(
      resource("model", "deepseek-v4-pro", {
        modelId: "deepseek-v4-pro",
        name: "DeepSeek-V4-Pro",
        contextWindow: 1048576,
        effortLevels: "low, high, max",
        defaultEffort: "high",
      }),
    );
    expect(schema.subtitle).toBe("DeepSeek-V4-Pro");
    expect(schema.sections.map((s) => s.title)).toEqual(["Model", "Thinking", "Pricing"]);
    const table = schema.sections[2]!.children.find((n) => n.kind === "table");
    if (table?.kind !== "table") throw new Error("expected a pricing table");
    expect(table.rows[2]!.cells).toEqual({ category: "Output", peak: "$3.96", offPeak: "$1.98" });
  });

  it("omits pricing for a model the published table does not cover", () => {
    const schema = client().renderDetail(
      resource("model", "deepseek-future", { modelId: "deepseek-future" }),
    );
    expect(schema.sections.map((s) => s.title)).toEqual(["Model"]);
  });

  it("says a file without an expiry is kept until deleted", () => {
    const schema = client().renderDetail(
      resource("file", "file-api-a", {
        fileId: "file-api-a",
        filename: "a.jpg",
        bytes: 102400,
        purpose: "user_data",
        expiresAt: "",
      }),
    );
    const list = schema.sections[0]!.children.find((n) => n.kind === "key-value-list");
    if (list?.kind !== "key-value-list") throw new Error("expected a key-value list");
    expect(list.items.find((i) => i.key === "Expires")?.value).toBe("Never (kept until deleted)");
  });
});

describe("renderSidebarItem", () => {
  it("shows the balance amount as the status label", () => {
    const item = client().renderSidebarItem(
      resource("balance", "CNY", { currency: "CNY", totalBalance: 42.5, isAvailable: true }),
    );
    expect(item.status?.label).toBe("42.50 CNY");
  });
});
