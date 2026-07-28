import { describe, expect, it } from "vitest";
import { runPluginRenderingTests } from "@infrawrench/plugin-base/test-harness";
import type { ResourceInstance } from "@infrawrench/plugin-base";
import { plugin } from "../plugin.js";
import { AnthropicClient } from "../client.js";

runPluginRenderingTests(plugin);

const ACCOUNT = "acct-1";

function client(): AnthropicClient {
  return new AnthropicClient({ apiKey: "sk-ant-api03-test", adminApiKey: "sk-ant-admin01-test" });
}

function resource(
  resourceTypeId: string,
  externalId: string,
  fields: Record<string, string | number | boolean>,
): ResourceInstance {
  return {
    id: `${ACCOUNT}:${resourceTypeId}:${externalId}`,
    pluginId: "anthropic",
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
  it("renders the model capability matrix as a table and offers a metrics tab", () => {
    const schema = client().renderDetail(
      resource("model", "claude-opus-4-6", {
        modelId: "claude-opus-4-6",
        displayName: "Claude Opus 4.6",
        maxInputTokens: 200000,
        maxTokens: 64000,
        vision: true,
        pdfInput: true,
        batch: true,
        citations: false,
        codeExecution: true,
        structuredOutputs: true,
        thinking: true,
        contextManagement: true,
        thinkingTypes: "adaptive, enabled",
        effortLevels: "low, medium, high",
      }),
    );

    expect(schema.metricsCapability).toBeDefined();
    const caps = schema.sections.find((section) => section.title === "Capabilities")!;
    const list = caps.children.find((node) => node.kind === "key-value-list");
    if (list?.kind !== "key-value-list") throw new Error("expected a key-value-list node");
    expect(list.items).toHaveLength(8);
    expect(list.items[0]!.key).toBe("Image input (vision)");
    expect(list.items[0]!.value).toBe("Yes");
    // Citations is false in the fixture — the matrix must not fake it.
    expect(list.items.find((item) => item.key === "Citations")!.value).toBe("No");
  });

  it("only offers Cancel while a batch is in progress, and explains the JSONL ordering", () => {
    const inProgress = client().renderDetail(
      resource("message-batch", "msgbatch_1", {
        processingStatus: "in_progress",
        processing: 100,
        succeeded: 0,
        errored: 0,
        canceled: 0,
        expired: 0,
        totalRequests: 100,
        resultsUrl: "",
      }),
    );
    expect(inProgress.headerActions?.map((a) => a.label)).toContain("Cancel batch");

    const ended = client().renderDetail(
      resource("message-batch", "msgbatch_2", {
        processingStatus: "ended",
        processing: 0,
        succeeded: 100,
        errored: 0,
        canceled: 0,
        expired: 0,
        totalRequests: 100,
        resultsUrl: "https://api.anthropic.com/v1/messages/batches/msgbatch_2/results",
      }),
    );
    expect(ended.headerActions?.map((a) => a.label)).not.toContain("Cancel batch");

    const resultsSection = ended.sections.find((s) => s.title === "Results")!;
    const link = resultsSection.children.find((n) => n.kind === "link");
    expect(link).toBeDefined();
    const note = resultsSection.children.find((n) => n.kind === "text");
    if (note?.kind !== "text") throw new Error("expected a text node");
    expect(note.content).toMatch(/custom_id/);
    expect(note.content).toMatch(/JSON Lines/);
  });

  it("exposes workspace archive as a confirm-guarded danger action, never a delete", () => {
    const active = client().renderDetail(
      resource("workspace", "wrkspc_1", { name: "Production", archivedAt: "" }),
    );
    const archive = active.headerActions?.find((a) => a.label === "Archive workspace…");
    expect(archive).toBeDefined();
    expect(archive!.variant).toBe("danger");
    if (archive!.action.type !== "plugin-action") throw new Error("expected a plugin-action");
    expect(archive!.action.confirmMessage).toMatch(/revokes EVERY API key/);
    expect(archive!.action.confirmMessage).toMatch(/no unarchive/);

    // Already archived → no second archive button.
    const archived = client().renderDetail(
      resource("workspace", "wrkspc_2", { name: "Old", archivedAt: "2026-01-01T00:00:00Z" }),
    );
    expect(archived.headerActions?.map((a) => a.label)).not.toContain("Archive workspace…");
    expect(archived.status?.status).toBe("degraded");
  });

  it("offers deactivate/reactivate on an API key instead of a delete", () => {
    const activeKey = client().renderDetail(
      resource("api-key", "apikey_1", { name: "Developer Key", status: "active" }),
    );
    expect(activeKey.headerActions?.map((a) => a.label)).toEqual(["Refresh", "Deactivate key"]);

    const inactiveKey = client().renderDetail(
      resource("api-key", "apikey_2", { name: "Old Key", status: "inactive" }),
    );
    expect(inactiveKey.headerActions?.map((a) => a.label)).toEqual(["Refresh", "Reactivate key"]);
  });
});

describe("renderSidebarItem", () => {
  it("labels invite status distinctly from key status", () => {
    const invite = client().renderSidebarItem(
      resource("invite", "invite_1", { email: "a@b.com", status: "pending" }),
    );
    expect(invite.status?.status).toBe("provisioning");
    expect(invite.status?.label).toBe("pending");

    const key = client().renderSidebarItem(
      resource("api-key", "apikey_1", { name: "k", status: "inactive" }),
    );
    expect(key.status?.status).toBe("degraded");
  });
});
