import { describe, expect, it } from "vitest";
import { runPluginRenderingTests } from "@infrawrench/plugin-base/test-harness";
import type { ResourceInstance } from "@infrawrench/plugin-base";
import { AssemblyAIClient } from "../client.js";
import { plugin } from "../plugin.js";

runPluginRenderingTests(plugin);

const ACCOUNT = "acct-1";

function transcript(overrides: Partial<ResourceInstance> = {}): ResourceInstance {
  return {
    id: `${ACCOUNT}:transcript:1f9c0a5e-0000-4000-8000-000000000001`,
    pluginId: "assemblyai",
    resourceTypeId: "transcript",
    accountId: ACCOUNT,
    displayName: "Hello from the other side",
    fields: {
      status: "completed",
      speechModel: "universal-3-5-pro",
      audioDuration: 92.5,
      languageCode: "en_us",
      confidence: 0.947,
      wordCount: 214,
      speakerLabels: true,
      audioUrl: "https://cdn.assemblyai.com/upload/abc",
      textPreview: "Hello from the other side.",
      errorMessage: "",
      created: "2026-07-20T10:00:00.000Z",
      completed: "2026-07-20T10:01:00.000Z",
    },
    resolvedOutputs: {},
    secretStates: [],
    externalId: "1f9c0a5e-0000-4000-8000-000000000001",
    createdAt: "2026-07-20T10:00:00.000Z",
    updatedAt: "2026-07-20T10:01:00.000Z",
    ...overrides,
  };
}

function account(fields: Record<string, string | number | boolean> = {}): ResourceInstance {
  return {
    id: `${ACCOUNT}:account:default`,
    pluginId: "assemblyai",
    resourceTypeId: "account",
    accountId: ACCOUNT,
    displayName: "AssemblyAI",
    fields: {
      endpoint: "https://api.assemblyai.com",
      region: "us",
      sampledTranscripts: 0,
      completedTranscripts: 0,
      erroredTranscripts: 0,
      pendingTranscripts: 0,
      oldestSampledAt: "",
      ...fields,
    },
    resolvedOutputs: {},
    secretStates: [],
    externalId: "default",
    createdAt: "2026-07-20T10:00:00.000Z",
    updatedAt: "2026-07-20T10:00:00.000Z",
  };
}

function client(): AssemblyAIClient {
  return new AssemblyAIClient({ apiKey: "k" });
}

describe("renderDetail — account", () => {
  it("carries the Speech tab on an account with zero transcripts", () => {
    // The plugin's only feature must not be gated behind already having used it.
    const schema = client().renderDetail(account());
    expect(schema.speechPanel?.modes).toEqual(["stt"]);
    expect(schema.speechPanel?.models?.map((m) => m.id)).toEqual([
      "universal-3-5-pro",
      "universal-2",
    ]);
  });

  it("shows the retention-window counts, labelled as a job count and not spend", () => {
    const schema = client().renderDetail(
      account({
        sampledTranscripts: 12,
        completedTranscripts: 10,
        erroredTranscripts: 1,
        pendingTranscripts: 1,
        oldestSampledAt: "2026-05-01T00:00:00.000Z",
      }),
    );
    expect(schema.sections.map((s) => s.title)).toContain(
      "Recent activity (90-day retention window)",
    );
    const flat = JSON.stringify(schema.sections);
    expect(flat).toContain("2026-05-01T00:00:00.000Z");
    expect(flat).toContain("not billed usage");
  });

  it("names the host the account is pinned to", () => {
    const schema = client().renderDetail(
      account({ endpoint: "https://api.eu.assemblyai.com", region: "eu" }),
    );
    expect(schema.subtitle).toContain("eu");
    expect(JSON.stringify(schema.sections)).toContain("https://api.eu.assemblyai.com");
  });

  it("renders an informational sidebar dot rather than a job status", () => {
    expect(client().renderSidebarItem(account()).status).toEqual({
      kind: "status-dot",
      status: "info",
      label: "Account",
    });
  });
});

describe("renderDetail", () => {
  it("declares an STT-only speech panel — AssemblyAI has no TTS", () => {
    const schema = client().renderDetail(transcript());
    expect(schema.speechPanel?.modes).toEqual(["stt"]);
  });

  it("offers only the two live model ids, and not the retired slam-1", () => {
    const models = client().renderDetail(transcript()).speechPanel?.models ?? [];
    expect(models.map((m) => m.id)).toEqual(["universal-3-5-pro", "universal-2"]);
    expect(models.map((m) => m.id)).not.toContain("slam-1");
    expect(models.map((m) => m.id)).not.toContain("universal-3.5-pro");
  });

  it("uses underscored language codes, never hyphenated BCP-47", () => {
    const languages = client().renderDetail(transcript()).speechPanel?.languages ?? [];
    expect(languages.map((l) => l.id)).toContain("en_us");
    for (const language of languages) expect(language.id).not.toContain("-");
  });

  it("shows duration, confidence and model", () => {
    const schema = client().renderDetail(transcript());
    const values = JSON.stringify(schema.sections);
    expect(values).toContain("1m 33s");
    expect(values).toContain("94.7%");
    expect(schema.subtitle).toContain("universal-3-5-pro");
  });

  it("surfaces the error message when a job failed", () => {
    const schema = client().renderDetail(
      transcript({
        fields: {
          ...transcript().fields,
          status: "error",
          errorMessage: "Transcoding failed",
        },
      }),
    );
    expect(schema.status?.status).toBe("error");
    expect(JSON.stringify(schema.sections)).toContain("Transcoding failed");
  });

  it("renders the recent-activity block from the enriched output, labelled as a retention window", () => {
    const schema = client().renderDetail(
      transcript({
        resolvedOutputs: {
          __recentActivity__: JSON.stringify({
            sampled: 12,
            completed: 10,
            error: 1,
            pending: 1,
          }),
        },
      }),
    );
    const titles = schema.sections.map((s) => s.title);
    expect(titles).toContain("Recent activity (90-day retention window)");
    expect(JSON.stringify(schema.sections)).toContain("not billed usage");
  });

  it("omits the recent-activity block when enrichDetail has not run", () => {
    const schema = client().renderDetail(transcript());
    expect(schema.sections.map((s) => s.title)).not.toContain(
      "Recent activity (90-day retention window)",
    );
  });
});

describe("renderSidebarItem", () => {
  it("maps queued/processing to a provisioning dot", () => {
    const item = client().renderSidebarItem(
      transcript({ fields: { ...transcript().fields, status: "processing" } }),
    );
    expect(item.status).toEqual({
      kind: "status-dot",
      status: "provisioning",
      label: "processing",
    });
  });

  it("maps completed to a healthy dot", () => {
    const item = client().renderSidebarItem(transcript());
    expect(item.status?.status).toBe("healthy");
  });
});
