import { describe, expect, it } from "vitest";
import type { ResourceInstance } from "@infrawrench/plugin-base";
import { runPluginRenderingTests } from "@infrawrench/plugin-base/test-harness";
import { plugin } from "../plugin.js";
import { SpeechmaticsClient } from "../client.js";

runPluginRenderingTests(plugin);

function client(overrides: Record<string, string> = {}) {
  return new SpeechmaticsClient({ apiKey: "key", region: "eu1", ...overrides });
}

function job(
  fields: Record<string, string | number | boolean>,
  resolvedOutputs: Record<string, string> = {},
): ResourceInstance {
  return {
    id: "acct-1:job:a1b2c3d4e5",
    pluginId: "speechmatics",
    resourceTypeId: "job",
    accountId: "acct-1",
    displayName: "recording.mp3",
    fields: { jobId: "a1b2c3d4e5", region: "eu1", ...fields },
    resolvedOutputs,
    secretStates: [],
    externalId: "a1b2c3d4e5",
    createdAt: "2026-07-01T00:00:00Z",
    updatedAt: "2026-07-01T00:00:00Z",
  };
}

describe("renderDetail — job", () => {
  it("declares an stt-only speech panel with the documented limits", () => {
    const detail = client().renderDetail(job({ status: "done" }));
    const panel = detail.speechPanel;
    expect(panel).toBeDefined();
    expect(panel?.modes).toEqual(["stt"]);
    // Speechmatics does no synthesis.
    expect(panel?.modes).not.toContain("tts");
    expect(panel?.maxAudioBytes).toBe(1024 * 1024 * 1024);
    expect(panel?.acceptedAudioTypes).toContain(".flac");
    expect(panel?.acceptedAudioTypes).not.toContain(".opus");
    expect(panel?.models?.map((m) => m.id)).toEqual(["enhanced", "standard", "melia-1"]);
    expect(panel?.defaultModel).toBe("enhanced");
  });

  it("falls back to a built-in language list when discovery was not stashed", () => {
    const panel = client().renderDetail(job({ status: "done" })).speechPanel;
    expect(panel?.languages?.some((l) => l.id === "en")).toBe(true);
    expect(panel?.languages?.some((l) => l.id === "multi")).toBe(true);
  });

  it("uses the stashed discovery payload for the language picker", () => {
    const stash = JSON.stringify({
      languages: [
        { id: "en", label: "English (en)" },
        { id: "cy", label: "Welsh (cy)" },
      ],
      models: [{ id: "enhanced", label: "Enhanced" }],
    });
    const panel = client().renderDetail(
      job({ status: "done" }, { __discovery__: stash }),
    ).speechPanel;
    expect(panel?.languages?.map((l) => l.id)).toEqual(["en", "cy"]);
    expect(panel?.models?.map((m) => m.id)).toEqual(["enhanced"]);
  });

  it("surfaces the regional transcript URL and the 7-day retention note", () => {
    const detail = client({ region: "us1" }).renderDetail(job({ status: "done", region: "us1" }));
    const flat = JSON.stringify(detail);
    expect(flat).toContain("https://us1.asr.api.speechmatics.com/v2/jobs/a1b2c3d4e5/transcript");
    expect(flat).toContain("7 days");
  });

  it("maps every documented async status onto a status dot", () => {
    const expected: Record<string, string> = {
      running: "provisioning",
      done: "healthy",
      rejected: "error",
      deleted: "unknown",
      expired: "degraded",
    };
    for (const [status, dot] of Object.entries(expected)) {
      expect(client().renderSidebarItem(job({ status })).status?.status).toBe(dot);
    }
  });
});
