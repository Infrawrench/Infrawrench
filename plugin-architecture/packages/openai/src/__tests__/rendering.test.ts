import { describe, expect, it } from "vitest";
import { runPluginRenderingTests } from "@infrawrench/plugin-base/test-harness";
import type { ResourceInstance } from "@infrawrench/plugin-base";
import { plugin } from "../plugin.js";
import { OpenAIClient } from "../client.js";
import { MAX_AUDIO_BYTES, MAX_TTS_CHARACTERS } from "../speech.js";

runPluginRenderingTests(plugin);

const ACCOUNT = "acct-1";

function client(): OpenAIClient {
  return new OpenAIClient({ apiKey: "sk-proj-test", adminApiKey: "sk-admin-test" });
}

function resource(
  resourceTypeId: string,
  externalId: string,
  fields: Record<string, string | number | boolean>,
): ResourceInstance {
  return {
    id: `${ACCOUNT}:${resourceTypeId}:${externalId}`,
    pluginId: "openai",
    resourceTypeId,
    accountId: ACCOUNT,
    displayName: externalId,
    externalId,
    fields,
    resolvedOutputs: {},
    secretStates: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("model detail", () => {
  it("attaches a Speech tab with the real voice list and provider limits", () => {
    const detail = client().renderDetail(
      resource("model", "gpt-4o-mini-tts-2025-12-15", {
        modelId: "gpt-4o-mini-tts-2025-12-15",
        isFineTuned: false,
        supportsTts: true,
        supportsStt: false,
      }),
    );

    const panel = detail.speechPanel;
    expect(panel).toBeDefined();
    expect(panel!.modes).toEqual(["tts", "stt"]);
    expect(panel!.maxCharacters).toBe(MAX_TTS_CHARACTERS);
    expect(panel!.maxAudioBytes).toBe(MAX_AUDIO_BYTES);
    expect(panel!.voices?.map((v) => v.id)).toEqual([
      "alloy",
      "ash",
      "ballad",
      "coral",
      "echo",
      "sage",
      "shimmer",
      "verse",
      "marin",
      "cedar",
    ]);
    // A speech-capable model preselects itself in the shared dropdown.
    expect(panel!.defaultModel).toBe("gpt-4o-mini-tts-2025-12-15");
  });

  it("falls back to a TTS default when the model can't do audio", () => {
    const detail = client().renderDetail(
      resource("model", "gpt-5", { modelId: "gpt-5", isFineTuned: false }),
    );
    expect(detail.speechPanel?.defaultModel).toBe("gpt-4o-mini-tts-2025-12-15");
  });

  it("only offers the delete action on fine-tuned models", () => {
    const base = client().renderDetail(
      resource("model", "gpt-5", { modelId: "gpt-5", isFineTuned: false }),
    );
    expect(base.headerActions?.some((a) => a.label.includes("Delete"))).toBe(false);

    const tuned = client().renderDetail(
      resource("model", "ft:gpt-4o-mini:acme::abc", {
        modelId: "ft:gpt-4o-mini:acme::abc",
        isFineTuned: true,
      }),
    );
    expect(tuned.headerActions?.some((a) => a.label === "Delete fine-tuned model")).toBe(true);
  });
});

describe("fine-tuning job detail", () => {
  it("shows cancel/pause/resume while the job is live", () => {
    const detail = client().renderDetail(
      resource("fine-tuning-job", "ftjob-1", { model: "gpt-4o-mini", status: "running" }),
    );
    const labels = (detail.headerActions ?? []).map((a) => a.label);
    expect(labels).toContain("Pause");
    expect(labels).toContain("Resume");
    expect(labels).toContain("Cancel");
  });

  it("hides them once the job is terminal", () => {
    const detail = client().renderDetail(
      resource("fine-tuning-job", "ftjob-1", { model: "gpt-4o-mini", status: "succeeded" }),
    );
    const labels = (detail.headerActions ?? []).map((a) => a.label);
    expect(labels).toEqual(["Refresh"]);
    expect(detail.status?.status).toBe("healthy");
  });
});

describe("batch detail", () => {
  it("offers cancel only while the batch is in flight", () => {
    const live = client().renderDetail(
      resource("batch", "batch_1", { endpoint: "/v1/chat/completions", status: "in_progress" }),
    );
    expect(live.headerActions?.some((a) => a.label === "Cancel batch")).toBe(true);

    const done = client().renderDetail(
      resource("batch", "batch_1", { endpoint: "/v1/chat/completions", status: "completed" }),
    );
    expect(done.headerActions?.some((a) => a.label === "Cancel batch")).toBe(false);
  });
});

describe("project detail", () => {
  it("offers archive rather than delete, and only while active", () => {
    const active = client().renderDetail(
      resource("project", "proj_1", { name: "prod", status: "active" }),
    );
    expect(active.headerActions?.some((a) => a.label === "Archive project")).toBe(true);

    const archived = client().renderDetail(
      resource("project", "proj_1", { name: "prod", status: "archived" }),
    );
    expect(archived.headerActions?.some((a) => a.label === "Archive project")).toBe(false);
    expect(archived.status?.status).toBe("degraded");
  });
});

describe("renderSidebarItem", () => {
  it("keys the dot off the resource status", () => {
    const item = client().renderSidebarItem(
      resource("vector-store", "vs_1", { name: "faq", status: "in_progress" }),
    );
    expect(item.id).toBe(`${ACCOUNT}:vector-store:vs_1`);
    expect(item.status?.status).toBe("provisioning");
  });
});
