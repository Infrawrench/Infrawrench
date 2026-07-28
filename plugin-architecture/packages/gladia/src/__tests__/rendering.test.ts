import { describe, expect, it } from "vitest";
import { runPluginRenderingTests } from "@infrawrench/plugin-base/test-harness";
import type { ResourceInstance } from "@infrawrench/plugin-base";
import { plugin } from "../plugin.js";
import { GladiaClient } from "../client.js";

const ACCOUNT = "acct-1";

function client(): GladiaClient {
  return new GladiaClient({ apiKey: "test-gladia-key" });
}

function transcription(overrides: Partial<ResourceInstance> = {}): ResourceInstance {
  return {
    id: `${ACCOUNT}:transcription:job-1`,
    pluginId: "gladia",
    resourceTypeId: "transcription",
    accountId: ACCOUNT,
    displayName: "meeting.mp3",
    externalId: "job-1",
    fields: {
      status: "done",
      filename: "meeting.mp3",
      audioDuration: 12.5,
      billingTime: 12.5,
      transcriptionTime: 3.2,
      languages: "en",
      channels: 1,
      createdAt: "2026-07-01T00:00:00Z",
      completedAt: "2026-07-01T00:00:20Z",
      errorCode: 0,
      requestId: "req-1",
      kind: "pre-recorded",
    },
    resolvedOutputs: { __transcript__: "Hello world.", __model__: "solaria-1" },
    secretStates: [],
    createdAt: "2026-07-01T00:00:00Z",
    updatedAt: "2026-07-01T00:00:20Z",
    ...overrides,
  };
}

function workspace(): ResourceInstance {
  return {
    id: `${ACCOUNT}:workspace:default`,
    pluginId: "gladia",
    resourceTypeId: "workspace",
    accountId: ACCOUNT,
    displayName: "Gladia",
    externalId: "default",
    fields: {
      endpoint: "https://api.gladia.io",
      recentJobs: 3,
      doneJobs: 2,
      erroredJobs: 1,
      runningJobs: 0,
      sampledBillingTime: 61.5,
      sampledAudioDuration: 61.5,
      oldestSampledAt: "2026-06-01T00:00:00Z",
    },
    resolvedOutputs: { endpoint: "https://api.gladia.io" },
    secretStates: [],
    createdAt: "2026-07-01T00:00:00Z",
    updatedAt: "2026-07-01T00:00:00Z",
  };
}

runPluginRenderingTests(plugin);

describe("renderDetail", () => {
  it("declares an STT-only speech panel on the workspace", () => {
    const schema = client().renderDetail(workspace());
    expect(schema.speechPanel?.modes).toEqual(["stt"]);
    expect(schema.speechPanel?.maxAudioBytes).toBe(1000 * 1024 * 1024);
    expect(schema.speechPanel?.defaultLanguage).toBe("auto");
    expect(schema.speechPanel?.models?.map((m) => m.id)).toEqual(["solaria-1", "solaria-3"]);
  });

  it("labels the derived usage figures as a history sum, not a quota", () => {
    const schema = client().renderDetail(workspace());
    const titles = schema.sections.map((section) => section.title);
    expect(titles).toContain("Activity (derived from recent history)");
    const activity = schema.sections.find((s) => s.title?.startsWith("Activity"));
    const note = activity?.children.find((child) => child.kind === "text");
    expect(note && "content" in note ? note.content : "").toMatch(/no usage or quota endpoint/i);
  });

  it("renders the stashed transcript for a completed job", () => {
    const schema = client().renderDetail(transcription());
    const section = schema.sections.find((s) => s.title === "Transcript");
    const text = section?.children[0];
    expect(text && "content" in text ? text.content : "").toBe("Hello world.");
    expect(schema.status?.status).toBe("healthy");
  });

  it("explains the HTTP-200-with-error convention on a failed job", () => {
    const schema = client().renderDetail(
      transcription({ fields: { ...transcription().fields, status: "error", errorCode: 500 } }),
    );
    expect(schema.status?.status).toBe("error");
    const failure = schema.sections.find((s) => s.title === "Failure");
    const text = failure?.children[0];
    expect(text && "content" in text ? text.content : "").toMatch(/HTTP 200/);
  });
});

describe("renderSidebarItem", () => {
  it("maps job status onto the status dot", () => {
    const c = client();
    expect(c.renderSidebarItem(transcription()).status?.status).toBe("healthy");
    expect(
      c.renderSidebarItem(
        transcription({ fields: { ...transcription().fields, status: "processing" } }),
      ).status?.status,
    ).toBe("provisioning");
    expect(c.renderSidebarItem(workspace()).status?.status).toBe("info");
  });
});
