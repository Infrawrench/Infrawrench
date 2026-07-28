import { describe, expect, it } from "vitest";
import type { ResourceInstance } from "@infrawrench/plugin-base";
import { runPluginRenderingTests } from "@infrawrench/plugin-base/test-harness";
import { GroqClient } from "../client.js";
import { plugin } from "../plugin.js";

runPluginRenderingTests(plugin);

function client() {
  return new GroqClient({ apiKey: "gsk_test" });
}

function resource(
  resourceTypeId: string,
  fields: Record<string, string | number | boolean>,
  resolvedOutputs: Record<string, string> = {},
): ResourceInstance {
  return {
    id: `acct-1:${resourceTypeId}:ext-1`,
    pluginId: "groq",
    resourceTypeId,
    accountId: "acct-1",
    displayName: String(fields["modelId"] ?? fields["batchId"] ?? "thing"),
    externalId: "ext-1",
    fields,
    resolvedOutputs,
    secretStates: [],
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
  };
}

describe("renderDetail — model", () => {
  it("drives the speech pickers off the stashed live model list", () => {
    const detail = client().renderDetail(
      resource(
        "groq-model",
        { modelId: "whisper-large-v3-turbo", modality: "Transcription", active: true },
        {
          __audioModels__: JSON.stringify({
            stt: ["whisper-large-v3-turbo"],
            tts: ["canopylabs/orpheus-v1-english"],
          }),
        },
      ),
    );

    expect(detail.speechPanel?.modes).toEqual(["tts", "stt"]);
    expect(detail.speechPanel?.models?.map((m) => m.id)).toEqual([
      "whisper-large-v3-turbo",
      "canopylabs/orpheus-v1-english",
    ]);
    // The open model is a speech model, so it is preselected.
    expect(detail.speechPanel?.defaultModel).toBe("whisper-large-v3-turbo");
  });

  it("never offers the deprecated distil-whisper or playai-tts models", () => {
    const detail = client().renderDetail(
      resource("groq-model", { modelId: "llama-3.3-70b-versatile", active: true }),
    );
    const ids = (detail.speechPanel?.models ?? []).map((m) => m.id).join(" ");
    expect(ids).not.toMatch(/distil-whisper|playai-tts/);
    expect(ids).toContain("canopylabs/orpheus-v1-english");
  });

  it("warns about the 10-second minimum billed length", () => {
    const detail = client().renderDetail(resource("groq-model", { modelId: "whisper-large-v3" }));
    expect(detail.speechPanel?.helpText).toContain("minimum of 10 seconds");
    expect(detail.speechPanel?.maxAudioBytes).toBe(25 * 1024 * 1024);
    expect(detail.speechPanel?.maxCharacters).toBe(200);
  });

  it("says billing is console-only rather than showing an empty chart", () => {
    const detail = client().renderDetail(
      resource("groq-model", { modelId: "llama-3.1-8b-instant" }),
    );
    const rendered = JSON.stringify(detail);
    expect(rendered).toContain("no usage, cost, or API-key management API");
    expect(detail.metricsCapability).toBeUndefined();
  });
});

describe("renderDetail — batch", () => {
  it("offers cancel only while the batch is still running", () => {
    const running = client().renderDetail(
      resource("groq-batch", { batchId: "batch_1", status: "in_progress" }),
    );
    expect(JSON.stringify(running.headerActions)).toContain('"actionId":"cancel"');

    const done = client().renderDetail(
      resource("groq-batch", { batchId: "batch_1", status: "completed" }),
    );
    expect(JSON.stringify(done.headerActions)).not.toContain('"actionId":"cancel"');
  });
});

describe("renderSidebarItem", () => {
  it("marks inactive models as degraded", () => {
    const item = client().renderSidebarItem(
      resource("groq-model", { modelId: "old-model", active: false }),
    );
    expect(item.status?.status).toBe("degraded");
  });
});
