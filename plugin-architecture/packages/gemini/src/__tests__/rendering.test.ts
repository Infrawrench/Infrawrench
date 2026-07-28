import { describe, expect, it } from "vitest";
import { runPluginRenderingTests } from "@infrawrench/plugin-base/test-harness";
import type { ResourceInstance } from "@infrawrench/plugin-base";
import { plugin } from "../plugin.js";
import { GeminiClient } from "../client.js";
import { GEMINI_VOICES } from "../speech-catalog.js";

runPluginRenderingTests(plugin);

const ACCOUNT = "acct-1";

function client() {
  return new GeminiClient({ apiKey: "AIzaTest" });
}

function resource(
  resourceTypeId: string,
  fields: Record<string, string | number | boolean>,
  externalId = "ext-1",
  resolvedOutputs: Record<string, string> = {},
): ResourceInstance {
  return {
    id: `${ACCOUNT}:${resourceTypeId}:${externalId}`,
    pluginId: "gemini",
    resourceTypeId,
    accountId: ACCOUNT,
    displayName: String(fields["displayName"] || externalId),
    fields,
    resolvedOutputs,
    secretStates: [],
    externalId,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

describe("model detail — speech panel", () => {
  const detail = () =>
    client().renderDetail(
      resource("model", { name: "models/gemini-2.5-flash" }, "gemini-2.5-flash"),
    );

  it("offers both halves — Gemini does TTS and STT", () => {
    expect(detail().speechPanel!.modes).toEqual(["tts", "stt"]);
  });

  it("lists all thirty documented voices with their style descriptors", () => {
    const voices = detail().speechPanel!.voices!;
    expect(voices).toHaveLength(30);
    expect(voices.map((v) => v.id)).toEqual(GEMINI_VOICES.map((v) => v.id));
    expect(voices.find((v) => v.id === "Kore")!.description).toBe("Firm");
    expect(voices.find((v) => v.id === "Puck")!.description).toBe("Upbeat");
    expect(voices.find((v) => v.id === "Zephyr")!.description).toBe("Bright");
  });

  it("defaults to Kore", () => {
    expect(detail().speechPanel!.defaultVoice).toBe("Kore");
  });

  it("offers the three TTS models and defaults to one of them", () => {
    const ids = detail().speechPanel!.models!.map((m) => m.id);
    expect(ids).toContain("gemini-3.1-flash-tts-preview");
    expect(ids).toContain("gemini-2.5-flash-preview-tts");
    expect(ids).toContain("gemini-2.5-pro-preview-tts");
    expect(detail().speechPanel!.defaultModel).toBe("gemini-3.1-flash-tts-preview");
  });

  it("defaults the model picker to the model itself when it is a TTS model", () => {
    const ttsDetail = client().renderDetail(
      resource(
        "model",
        { name: "models/gemini-2.5-pro-preview-tts" },
        "gemini-2.5-pro-preview-tts",
      ),
    );
    expect(ttsDetail.speechPanel!.defaultModel).toBe("gemini-2.5-pro-preview-tts");
  });

  it("scopes the file picker to the six documented audio types", () => {
    const accepted = detail().speechPanel!.acceptedAudioTypes!;
    expect(accepted).toEqual(
      expect.arrayContaining([
        "audio/wav",
        "audio/mp3",
        "audio/aiff",
        "audio/aac",
        "audio/ogg",
        "audio/flac",
      ]),
    );
    // Not documented by Google for generativelanguage.googleapis.com.
    expect(accepted).not.toContain("audio/webm");
    expect(accepted).not.toContain("audio/mp4");
  });

  it("explains the browser-recording caveat in the help text", () => {
    const help = detail().speechPanel!.helpText!;
    expect(help).toMatch(/WebM/);
    expect(help).toMatch(/MP4/);
    expect(help).toMatch(/WAV header/);
  });

  it("caps inline uploads under the 20 MB request limit", () => {
    // Base64 inflates by ~4/3, so the raw cap has to sit well under 20 MB.
    const max = detail().speechPanel!.maxAudioBytes!;
    expect(max).toBeLessThan(20 * 1024 * 1024);
    expect(max * (4 / 3)).toBeLessThan(20 * 1024 * 1024);
  });

  it("merges stashed transcription models in after the TTS ones", () => {
    const withStash = client().renderDetail(
      resource("model", { name: "models/gemini-2.5-flash" }, "gemini-2.5-flash", {
        __sttModels__: JSON.stringify([{ id: "gemini-4.0-flash", label: "Gemini 4.0 Flash" }]),
      }),
    );
    const ids = withStash.speechPanel!.models!.map((m) => m.id);
    expect(ids.slice(0, 3)).toEqual([
      "gemini-3.1-flash-tts-preview",
      "gemini-2.5-flash-preview-tts",
      "gemini-2.5-pro-preview-tts",
    ]);
    expect(ids).toContain("gemini-4.0-flash");
  });
});

describe("model detail — quota honesty", () => {
  it("says there is no usage or billing API rather than showing an empty chart", () => {
    const detail = client().renderDetail(resource("model", { name: "models/x" }, "x"));
    const text = JSON.stringify(detail.sections);
    expect(text).toMatch(/no admin, usage, quota or billing endpoints/i);
    expect(text).toContain("aistudio.google.com");
  });

  it("does not declare a metrics tab it cannot populate", () => {
    const detail = client().renderDetail(resource("model", { name: "models/x" }, "x"));
    expect(detail.metricsCapability).toBeUndefined();
  });
});

describe("batch detail", () => {
  it("humanises the BATCH_STATE_ enum", () => {
    const detail = client().renderDetail(
      resource("batch", { name: "batches/b1", state: "BATCH_STATE_SUCCEEDED" }),
    );
    expect(detail.status).toEqual({ kind: "status-dot", status: "healthy" });
    expect(JSON.stringify(detail.sections)).toContain("Succeeded");
  });

  it("offers Cancel only while pending or running", () => {
    for (const state of ["BATCH_STATE_PENDING", "BATCH_STATE_RUNNING"]) {
      const detail = client().renderDetail(resource("batch", { name: "batches/b1", state }));
      expect(JSON.stringify(detail.headerActions)).toContain("Cancel batch");
    }
    for (const state of ["BATCH_STATE_SUCCEEDED", "BATCH_STATE_FAILED", "BATCH_STATE_EXPIRED"]) {
      const detail = client().renderDetail(resource("batch", { name: "batches/b1", state }));
      expect(JSON.stringify(detail.headerActions)).not.toContain("Cancel batch");
    }
  });

  it("maps every batch state onto a dot", () => {
    const c = client();
    const dot = (state: string) =>
      c.renderSidebarItem(resource("batch", { name: "n", state })).status;
    expect(dot("BATCH_STATE_SUCCEEDED")).toEqual({ kind: "status-dot", status: "healthy" });
    expect(dot("BATCH_STATE_FAILED")).toEqual({ kind: "status-dot", status: "error" });
    expect(dot("BATCH_STATE_CANCELLED")).toEqual({ kind: "status-dot", status: "degraded" });
    expect(dot("BATCH_STATE_EXPIRED")).toEqual({ kind: "status-dot", status: "degraded" });
    expect(dot("BATCH_STATE_RUNNING")).toEqual({ kind: "status-dot", status: "provisioning" });
    expect(dot("BATCH_STATE_UNSPECIFIED")).toEqual({ kind: "status-dot", status: "info" });
  });
});

describe("state enums differ between files and file-search documents", () => {
  it("files use bare PROCESSING/ACTIVE/FAILED", () => {
    const c = client();
    expect(c.renderSidebarItem(resource("file", { state: "ACTIVE" })).status).toEqual({
      kind: "status-dot",
      status: "healthy",
    });
    expect(c.renderSidebarItem(resource("file", { state: "PROCESSING" })).status).toEqual({
      kind: "status-dot",
      status: "provisioning",
    });
  });

  it("documents use the STATE_-prefixed variant", () => {
    const c = client();
    expect(
      c.renderSidebarItem(resource("file-search-document", { state: "STATE_ACTIVE" })).status,
    ).toEqual({ kind: "status-dot", status: "healthy" });
    expect(
      c.renderSidebarItem(resource("file-search-document", { state: "STATE_PENDING" })).status,
    ).toEqual({ kind: "status-dot", status: "provisioning" });
    // The bare form must NOT be treated as healthy on a document.
    expect(
      c.renderSidebarItem(resource("file-search-document", { state: "ACTIVE" })).status,
    ).toEqual({ kind: "status-dot", status: "info" });
  });
});

describe("file detail", () => {
  it("surfaces the 48-hour expiry rule", () => {
    const detail = client().renderDetail(
      resource("file", {
        name: "files/f1",
        state: "ACTIVE",
        expirationTime: "2026-01-03T00:00:00Z",
      }),
    );
    expect(JSON.stringify(detail.sections)).toMatch(/48 hours/);
  });
});

describe("cached-content detail", () => {
  it("explains that only ttl is editable", () => {
    const detail = client().renderDetail(
      resource("cached-content", { name: "cachedContents/c1", ttl: "3600s" }),
    );
    expect(JSON.stringify(detail.sections)).toMatch(/only property the API lets you change/i);
  });
});

describe("file-search-store detail", () => {
  it("degrades when documents have failed to index", () => {
    const detail = client().renderDetail(
      resource("file-search-store", {
        name: "fileSearchStores/s1",
        activeDocumentsCount: 3,
        failedDocumentsCount: 1,
      }),
    );
    expect(detail.status).toEqual({ kind: "status-dot", status: "degraded" });
  });

  it("shows provisioning while documents are still pending", () => {
    const detail = client().renderDetail(
      resource("file-search-store", {
        name: "fileSearchStores/s1",
        pendingDocumentsCount: 2,
        failedDocumentsCount: 0,
      }),
    );
    expect(detail.status).toEqual({ kind: "status-dot", status: "provisioning" });
  });
});
