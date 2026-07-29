import { describe, expect, it } from "vitest";
import { runPluginRenderingTests } from "@infrawrench/plugin-base/test-harness";
import type { ResourceInstance } from "@infrawrench/plugin-base";
import { plugin } from "../plugin.js";
import { CohereClient } from "../client.js";

runPluginRenderingTests(plugin);

const ACCOUNT = "acct-1";

function client() {
  return new CohereClient({ apiKey: "test-key" });
}

function resource(
  resourceTypeId: string,
  fields: Record<string, string | number | boolean>,
  resolvedOutputs: Record<string, string> = {},
): ResourceInstance {
  return {
    id: `${ACCOUNT}:${resourceTypeId}:ext-1`,
    pluginId: "cohere",
    resourceTypeId,
    accountId: ACCOUNT,
    displayName: String(fields["name"] ?? "thing"),
    fields,
    resolvedOutputs,
    secretStates: [],
    externalId: "ext-1",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

describe("model detail", () => {
  it("declares an STT-only speech panel — Cohere has no TTS", () => {
    const detail = client().renderDetail(resource("model", { name: "command-a-03-2025" }));
    expect(detail.speechPanel).toBeDefined();
    expect(detail.speechPanel!.modes).toEqual(["stt"]);
    expect(detail.speechPanel!.modes).not.toContain("tts");
  });

  it("caps uploads at Cohere's real 25 MB limit", () => {
    const detail = client().renderDetail(resource("model", { name: "command-a-03-2025" }));
    expect(detail.speechPanel!.maxAudioBytes).toBe(25 * 1024 * 1024);
  });

  it("steers the file picker away from browser recording formats", () => {
    const accepted = client().renderDetail(resource("model", { name: "m" })).speechPanel!
      .acceptedAudioTypes!;
    // The six formats Cohere documents.
    expect(accepted).toEqual(
      expect.arrayContaining([
        "audio/flac",
        "audio/mpeg",
        "audio/mp3",
        "audio/mpga",
        "audio/ogg",
        "audio/wav",
      ]),
    );
    // What MediaRecorder actually produces — both rejected by Cohere.
    expect(accepted).not.toContain("audio/webm");
    expect(accepted).not.toContain("audio/mp4");
  });

  it("says so in the help text", () => {
    const help = client().renderDetail(resource("model", { name: "m" })).speechPanel!.helpText!;
    expect(help).toMatch(/WebM/i);
    expect(help).toMatch(/MP4/i);
  });

  it("hides the recorder outright — every recording would be rejected", () => {
    // Chromium and Firefox record WebM, Safari records MP4, mobile records
    // M4A; Cohere accepts none of the three. A Record button here could only
    // ever end in "…is not a container Cohere transcribes".
    const panel = client().renderDetail(resource("model", { name: "m" })).speechPanel!;

    expect(panel.disableRecording).toBe(true);
    expect(panel.recordingDisabledReason).toMatch(/FLAC, MP3, MPEG, MPGA, OGG and WAV/);
    expect(panel.recordingDisabledReason).toMatch(/WebM/i);
    // Uploading is untouched — only the recorder half goes away.
    expect(panel.disabledReason).toBeUndefined();
    expect(panel.acceptedAudioTypes!.length).toBeGreaterThan(0);
  });

  it("defaults the language picker, because the API requires one", () => {
    const panel = client().renderDetail(resource("model", { name: "m" })).speechPanel!;
    expect(panel.defaultLanguage).toBe("en");
    // No blank auto-detect entry — `language` is a required form field.
    expect(panel.languages!.some((l) => l.id === "")).toBe(false);
  });

  it("falls back to the documented transcription model with no stashed list", () => {
    const panel = client().renderDetail(resource("model", { name: "m" })).speechPanel!;
    expect(panel.defaultModel).toBe("cohere-transcribe-03-2026");
    expect(panel.models!.map((m) => m.id)).toContain("cohere-transcribe-03-2026");
  });

  it("uses the stashed model list when getResource supplied one", () => {
    const detail = client().renderDetail(
      resource(
        "model",
        { name: "m" },
        {
          __speechModels__: JSON.stringify([
            { id: "cohere-transcribe-99-2027", label: "cohere-transcribe-99-2027" },
          ]),
        },
      ),
    );
    expect(detail.speechPanel!.models!.map((m) => m.id)).toEqual(["cohere-transcribe-99-2027"]);
  });

  it("marks a deprecated model as degraded rather than healthy", () => {
    const detail = client().renderDetail(
      resource("model", { name: "command", isDeprecated: true }),
    );
    expect(detail.status).toEqual({ kind: "status-dot", status: "degraded" });
    expect(detail.subtitle).toContain("deprecated");
  });

  it("states plainly that there is no usage API", () => {
    const detail = client().renderDetail(resource("model", { name: "m" }));
    const text = JSON.stringify(detail.sections);
    expect(text).toMatch(/no usage or billing API/i);
  });
});

describe("dataset detail", () => {
  it("renders storage usage against the 10 GB cap when stashed", () => {
    const detail = client().renderDetail(
      resource(
        "dataset",
        { name: "d", validationStatus: "validated" },
        { __datasetUsage__: JSON.stringify(1024 * 1024 * 1024) },
      ),
    );
    const text = JSON.stringify(detail.sections);
    expect(text).toContain("1.0 GB");
    expect(text).toContain("10 GB");
  });

  it("degrades gracefully when the usage call failed", () => {
    const detail = client().renderDetail(
      resource("dataset", { name: "d" }, { __datasetUsage__: "null" }),
    );
    expect(JSON.stringify(detail.sections)).toMatch(/unavailable/i);
  });
});

describe("finetuned-model detail", () => {
  it("humanises the STATUS_ enum", () => {
    const detail = client().renderDetail(
      resource("finetuned-model", {
        name: "ft",
        status: "STATUS_READY",
        baseType: "BASE_TYPE_CHAT",
      }),
    );
    expect(detail.status).toEqual({ kind: "status-dot", status: "healthy" });
    expect(JSON.stringify(detail.sections)).toContain("Ready");
  });

  it("exposes Events and Training Metrics tabs", () => {
    const detail = client().renderDetail(resource("finetuned-model", { name: "ft" }));
    expect(detail.customTabs!.map((t) => t.id)).toEqual(["events", "training-metrics"]);
  });

  it("builds a metrics table from stashed training steps", () => {
    const detail = client().renderDetail(
      resource(
        "finetuned-model",
        { name: "ft" },
        {
          __stepMetrics__: JSON.stringify([
            { step: 1, createdAt: "", metrics: { loss: 0.5, accuracy: 0.8 } },
          ]),
        },
      ),
    );
    const tab = detail.customTabs!.find((t) => t.id === "training-metrics")!;
    expect(JSON.stringify(tab)).toContain("accuracy");
    expect(JSON.stringify(tab)).toContain("loss");
  });
});

describe("job cancellation", () => {
  it("offers Cancel only while an embed job is processing", () => {
    const running = client().renderDetail(
      resource("embed-job", { name: "j", status: "processing" }),
    );
    expect(JSON.stringify(running.headerActions)).toContain("Cancel job");

    const done = client().renderDetail(resource("embed-job", { name: "j", status: "complete" }));
    expect(JSON.stringify(done.headerActions)).not.toContain("Cancel job");
  });

  it("offers Cancel only for queued or in-progress batches", () => {
    const running = client().renderDetail(
      resource("batch", { name: "b", status: "BATCH_STATUS_IN_PROGRESS" }),
    );
    expect(JSON.stringify(running.headerActions)).toContain("Cancel batch");

    const done = client().renderDetail(
      resource("batch", { name: "b", status: "BATCH_STATUS_COMPLETED" }),
    );
    expect(JSON.stringify(done.headerActions)).not.toContain("Cancel batch");
  });
});

describe("renderSidebarItem", () => {
  it("maps each status enum onto a dot", () => {
    const c = client();
    expect(
      c.renderSidebarItem(resource("model", { name: "m", isDeprecated: true })).status,
    ).toEqual({ kind: "status-dot", status: "degraded" });
    expect(
      c.renderSidebarItem(resource("batch", { name: "b", status: "BATCH_STATUS_FAILED" })).status,
    ).toEqual({ kind: "status-dot", status: "error" });
    expect(
      c.renderSidebarItem(resource("dataset", { name: "d", validationStatus: "validated" })).status,
    ).toEqual({ kind: "status-dot", status: "healthy" });
    expect(
      c.renderSidebarItem(resource("embed-job", { name: "j", status: "processing" })).status,
    ).toEqual({ kind: "status-dot", status: "provisioning" });
  });
});
