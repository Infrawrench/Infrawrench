import { describe, expect, it } from "vitest";
import { runPluginRenderingTests } from "@infrawrench/plugin-base/test-harness";
import type { ResourceInstance } from "@infrawrench/plugin-base";
import { plugin } from "../plugin.js";
import { DeepgramClient } from "../client.js";

runPluginRenderingTests(plugin);

const ACCOUNT = "acct-1";

function client() {
  return new DeepgramClient({ apiKey: "test-key" });
}

function resource(overrides: Partial<ResourceInstance> & { resourceTypeId: string }) {
  const now = "2026-07-01T00:00:00.000Z";
  return {
    id: `${ACCOUNT}:${overrides.resourceTypeId}:ext`,
    pluginId: "deepgram",
    accountId: ACCOUNT,
    displayName: "Test",
    fields: {},
    resolvedOutputs: {},
    secretStates: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as ResourceInstance;
}

describe("project detail", () => {
  const stashed = JSON.stringify({
    stt: [
      { id: "nova-3", label: "Nova 3", description: "en, es, fr" },
      { id: "nova-2", label: "Nova 2" },
    ],
    tts: [
      { id: "aura-2-thalia-en", label: "Thalia", description: "American · clear, confident" },
      { id: "aura-asteria-en", label: "Asteria", description: "American" },
    ],
  });

  it("builds the speech panel from the stashed model catalogue", () => {
    const schema = client().renderDetail(
      resource({
        resourceTypeId: "project",
        displayName: "Prod",
        fields: { name: "Prod", projectId: "proj-1" },
        resolvedOutputs: { projectId: "proj-1", __models__: stashed },
      }),
    );

    expect(schema.speechPanel).toBeDefined();
    expect(schema.speechPanel!.modes).toEqual(["stt", "tts"]);
    expect(schema.speechPanel!.maxCharacters).toBe(2000);
    expect(schema.speechPanel!.voices?.map((v) => v.id)).toEqual([
      "aura-2-thalia-en",
      "aura-asteria-en",
    ]);
    expect(schema.speechPanel!.defaultVoice).toBe("aura-2-thalia-en");
    expect(schema.speechPanel!.models?.map((m) => m.id)).toEqual(["nova-3", "nova-2"]);
    expect(schema.speechPanel!.defaultModel).toBe("nova-3");
    expect(schema.speechPanel!.languages?.some((l) => l.id === "multi")).toBe(true);
  });

  it("renders a metrics tab and a console deep link", () => {
    const schema = client().renderDetail(
      resource({
        resourceTypeId: "project",
        fields: { name: "Prod", projectId: "proj-1" },
        resolvedOutputs: { __models__: stashed },
      }),
    );
    expect(schema.metricsCapability).toBeDefined();
    expect(schema.headerActions?.[0]?.action).toEqual({
      type: "open-url",
      url: "https://console.deepgram.com/project/proj-1",
    });
  });

  it("disables the speech panel when the catalogue is unreadable", () => {
    const schema = client().renderDetail(
      resource({
        resourceTypeId: "project",
        fields: { name: "Prod", projectId: "proj-1" },
        resolvedOutputs: {},
      }),
    );
    expect(schema.speechPanel!.disabledReason).toMatch(/model catalogue/);
    expect(schema.speechPanel!.voices).toBeUndefined();
  });

  it("survives a malformed __models__ stash", () => {
    const schema = client().renderDetail(
      resource({
        resourceTypeId: "project",
        fields: { name: "Prod", projectId: "proj-1" },
        resolvedOutputs: { __models__: "{not json" },
      }),
    );
    expect(schema.speechPanel!.disabledReason).toBeDefined();
  });
});

describe("api-key detail", () => {
  it("shows the one-shot secret when create handed one back", () => {
    const schema = client().renderDetail(
      resource({
        resourceTypeId: "api-key",
        displayName: "CI",
        fields: { apiKeyId: "key-1", comment: "CI", scopes: "member" },
        resolvedOutputs: { apiKeyId: "key-1", apiKey: "super-secret" },
      }),
    );
    const text = JSON.stringify(schema.sections);
    expect(text).toContain("super-secret");
    expect(text).toContain("shown once");
  });

  it("explains the absence of the secret on a listed key", () => {
    const schema = client().renderDetail(
      resource({
        resourceTypeId: "api-key",
        fields: { apiKeyId: "key-1", scopes: "admin" },
        resolvedOutputs: { apiKeyId: "key-1" },
      }),
    );
    expect(JSON.stringify(schema.sections)).toContain("cannot be revealed");
  });
});

describe("model detail", () => {
  it("links the preview clip and avatar for a TTS voice", () => {
    const schema = client().renderDetail(
      resource({
        resourceTypeId: "model",
        displayName: "Thalia",
        fields: { canonicalName: "aura-2-thalia-en", family: "tts", accent: "American" },
        resolvedOutputs: {
          sampleUrl: "https://static.deepgram.com/examples/thalia.wav",
          imageUrl: "https://static.deepgram.com/examples/thalia.jpg",
        },
      }),
    );
    const links = JSON.stringify(schema.sections);
    expect(links).toContain("thalia.wav");
    expect(links).toContain("thalia.jpg");
    expect(links).toContain("/v1/speak");
  });

  it("points STT models at /v1/listen", () => {
    const schema = client().renderDetail(
      resource({
        resourceTypeId: "model",
        fields: { canonicalName: "nova-3", family: "stt" },
      }),
    );
    expect(JSON.stringify(schema.sections)).toContain("/v1/listen");
  });
});

describe("renderSidebarItem", () => {
  it("flags an expiring key and a drained balance", () => {
    const key = client().renderSidebarItem(
      resource({
        resourceTypeId: "api-key",
        fields: { scopes: "owner", expirationDate: "2026-12-01T00:00:00Z" },
      }),
    );
    expect(key.status?.status).toBe("degraded");
    expect(key.status?.label).toBe("owner");

    const balance = client().renderSidebarItem(
      resource({ resourceTypeId: "balance", fields: { amount: 0 } }),
    );
    expect(balance.status?.status).toBe("degraded");
  });

  it("marks invites as pending", () => {
    const invite = client().renderSidebarItem(
      resource({ resourceTypeId: "invite", fields: { email: "a@b.co" } }),
    );
    expect(invite.status?.status).toBe("provisioning");
  });
});
