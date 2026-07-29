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

function account(
  fields: Record<string, string | number | boolean> = {},
  resolvedOutputs: Record<string, string> = {},
): ResourceInstance {
  return {
    id: "acct-1:account:default",
    pluginId: "speechmatics",
    resourceTypeId: "account",
    accountId: "acct-1",
    displayName: "Speechmatics (eu1)",
    fields: {
      region: "eu1",
      endpoint: "https://eu1.asr.api.speechmatics.com/v2",
      managementToken: false,
      usageSince: "2026-06-29",
      usageUntil: "2026-07-28",
      usageHours: 0,
      usageJobs: 0,
      languagePacks: 0,
      ...fields,
    },
    resolvedOutputs,
    secretStates: [],
    externalId: "default",
    createdAt: "2026-07-28T00:00:00Z",
    updatedAt: "2026-07-28T00:00:00Z",
  };
}

describe("renderDetail — account", () => {
  it("carries the Speech tab on an account with no jobs and no usage", () => {
    // Jobs are purged after 7 days; the account is what keeps the tab reachable.
    const detail = client().renderDetail(account());
    expect(detail.speechPanel?.modes).toEqual(["stt"]);
    expect(detail.speechPanel?.maxAudioBytes).toBe(25 * 1024 * 1024);
    expect(detail.speechPanel?.defaultModel).toBe("enhanced");
    // Discovery was never stashed, so the picker falls back rather than emptying.
    expect(detail.speechPanel?.languages?.some((l) => l.id === "en")).toBe(true);
  });

  it("renders the usage window, the breakdown rows and the language-pack count", () => {
    const detail = client().renderDetail(
      account(
        { usageHours: 1.75, usageJobs: 4, languagePacks: 2 },
        {
          __usage__: JSON.stringify({
            since: "2026-06-29",
            until: "2026-07-28",
            hours: 1.75,
            jobs: 4,
            rows: [{ label: "batch · transcription · enhanced", count: 3, hours: 1.25 }],
          }),
          __discovery__: JSON.stringify({
            languages: [
              { id: "en", label: "English (en)" },
              { id: "multi", label: "Multilingual (multi)" },
            ],
            models: [{ id: "enhanced", label: "Enhanced" }],
          }),
        },
      ),
    );

    const flat = JSON.stringify(detail.sections);
    expect(flat).toContain("2026-06-29 → 2026-07-28");
    expect(flat).toContain("batch · transcription · enhanced");
    expect(flat).toContain("3 jobs · 1.250 h");
    expect(detail.speechPanel?.languages?.map((l) => l.id)).toEqual(["en", "multi"]);
    expect(detail.metricsCapability).toBeDefined();
  });

  it("says the Projects and API Keys lists stay empty without a management token", () => {
    expect(JSON.stringify(client().renderDetail(account()).sections)).toContain(
      "Projects and API Keys lists stay empty",
    );
    expect(
      JSON.stringify(client().renderDetail(account({ managementToken: true })).sections),
    ).toContain("mp.api.speechmatics.com");
  });

  it("labels the sidebar entry with the region rather than a job status", () => {
    expect(client().renderSidebarItem(account()).status).toEqual({
      kind: "status-dot",
      status: "info",
      label: "eu1",
    });
  });
});

describe("renderDetail — job", () => {
  it("declares an stt-only speech panel with the documented limits", () => {
    const detail = client().renderDetail(job({ status: "done" }));
    const panel = detail.speechPanel;
    expect(panel).toBeDefined();
    expect(panel?.modes).toEqual(["stt"]);
    // Speechmatics does no synthesis.
    expect(panel?.modes).not.toContain("tts");
    // Capped by our base64-over-JSON transport (ingress proxy-body-size 36m
    // ⇒ ~27 MB of raw audio), not by what the provider would accept.
    expect(panel?.maxAudioBytes).toBe(25 * 1024 * 1024);
    expect(panel!.maxAudioBytes!).toBeLessThanOrEqual(27 * 1024 * 1024);
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
