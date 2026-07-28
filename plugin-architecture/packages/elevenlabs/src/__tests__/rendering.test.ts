import { describe, expect, it } from "vitest";
import { runPluginRenderingTests } from "@infrawrench/plugin-base/test-harness";
import type { ResourceInstance } from "@infrawrench/plugin-base";
import { plugin } from "../plugin.js";
import { ElevenLabsClient } from "../client.js";

runPluginRenderingTests(plugin);

const ACCOUNT = "acct-1";

function client() {
  return new ElevenLabsClient({ apiKey: "sk_test" });
}

function voiceResource(overrides: Partial<ResourceInstance> = {}): ResourceInstance {
  const now = new Date().toISOString();
  return {
    id: `${ACCOUNT}:voice:21m00Tcm4TlvDq8ikWAM`,
    pluginId: "elevenlabs",
    resourceTypeId: "voice",
    accountId: ACCOUNT,
    displayName: "Rachel",
    fields: {
      name: "Rachel",
      voiceId: "21m00Tcm4TlvDq8ikWAM",
      category: "premade",
      accent: "american",
      gender: "female",
      previewUrl: "https://storage.googleapis.com/eleven-public-prod/preview.mp3",
    },
    resolvedOutputs: {
      voiceId: "21m00Tcm4TlvDq8ikWAM",
      voiceName: "Rachel",
      previewUrl: "https://storage.googleapis.com/eleven-public-prod/preview.mp3",
    },
    secretStates: [],
    externalId: "21m00Tcm4TlvDq8ikWAM",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("voice speech panel", () => {
  it("declares both TTS and STT modes", () => {
    const schema = client().renderDetail(voiceResource());
    expect(schema.speechPanel?.modes).toEqual(["tts", "stt"]);
  });

  it("builds the voice and model pickers from the stashed lists", () => {
    const resource = voiceResource();
    resource.resolvedOutputs["__voices__"] = JSON.stringify([
      { id: "21m00Tcm4TlvDq8ikWAM", label: "Rachel", description: "Accent: american" },
      { id: "AZnzlk1XvdvUeBnXmlld", label: "Domi", description: "Accent: american" },
    ]);
    resource.resolvedOutputs["__models__"] = JSON.stringify([
      {
        id: "eleven_multilingual_v2",
        label: "Eleven Multilingual v2",
        description: "Lifelike speech",
        maxCharacters: 10000,
      },
      {
        id: "eleven_flash_v2_5",
        label: "Eleven Flash v2.5",
        description: "Low latency",
        maxCharacters: 40000,
      },
    ]);

    const panel = client().renderDetail(resource).speechPanel;
    expect(panel?.voices?.map((v) => v.id)).toEqual([
      "21m00Tcm4TlvDq8ikWAM",
      "AZnzlk1XvdvUeBnXmlld",
    ]);
    expect(panel?.defaultVoice).toBe("21m00Tcm4TlvDq8ikWAM");
    // TTS models first, then the Scribe transcription models.
    expect(panel?.models?.map((m) => m.id)).toEqual([
      "eleven_multilingual_v2",
      "eleven_flash_v2_5",
      "scribe_v2",
      "scribe_v1",
    ]);
    expect(panel?.defaultModel).toBe("eleven_multilingual_v2");
  });

  it("takes maxCharacters from the default model rather than a hardcoded value", () => {
    const resource = voiceResource();
    resource.resolvedOutputs["__models__"] = JSON.stringify([
      {
        id: "eleven_flash_v2_5",
        label: "Eleven Flash v2.5",
        description: "",
        maxCharacters: 40000,
      },
    ]);
    const panel = client().renderDetail(resource).speechPanel;
    expect(panel?.defaultModel).toBe("eleven_flash_v2_5");
    expect(panel?.maxCharacters).toBe(40000);
  });

  it("renders the character-quota gauge from the stashed subscription", () => {
    const resource = voiceResource();
    resource.resolvedOutputs["__subscription__"] = JSON.stringify({
      used: 25000,
      limit: 100000,
      resetUnix: 1_800_000_000,
      tier: "creator",
    });
    const schema = client().renderDetail(resource);
    const quota = schema.sections.find((section) => section.title === "Character Quota");
    expect(quota).toBeDefined();
    expect(JSON.stringify(quota)).toContain("25%");
    expect(schema.speechPanel?.subtitle).toContain("25,000 / 100,000");
  });

  it("survives a resource with no stashed lists", () => {
    const resource = voiceResource();
    const panel = client().renderDetail(resource).speechPanel;
    expect(panel?.voices).toBeUndefined();
    expect(panel?.models?.map((m) => m.id)).toEqual(["scribe_v2", "scribe_v1"]);
    expect(panel?.maxCharacters).toBe(10000);
  });
});

describe("renderSidebarItem", () => {
  it("labels a voice with its category", () => {
    expect(client().renderSidebarItem(voiceResource()).status?.label).toBe("Premade");
  });

  it("marks a conversion-only model as info", () => {
    const now = new Date().toISOString();
    const item = client().renderSidebarItem({
      id: `${ACCOUNT}:model:eleven_english_sts_v2`,
      pluginId: "elevenlabs",
      resourceTypeId: "model",
      accountId: ACCOUNT,
      displayName: "Eleven English STS v2",
      fields: { name: "Eleven English STS v2", modelId: "eleven_english_sts_v2" },
      resolvedOutputs: {},
      secretStates: [],
      createdAt: now,
      updatedAt: now,
    });
    expect(item.status?.status).toBe("info");
    expect(item.status?.label).toBe("Conversion only");
  });
});
