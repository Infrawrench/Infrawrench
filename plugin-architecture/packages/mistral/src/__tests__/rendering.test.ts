import { describe, expect, it } from "vitest";
import type { ResourceInstance } from "@infrawrench/plugin-base";
import { runPluginRenderingTests } from "@infrawrench/plugin-base/test-harness";
import { MistralClient } from "../client.js";
import { plugin } from "../plugin.js";

runPluginRenderingTests(plugin);

function client(adminApiKey = "") {
  return new MistralClient({ apiKey: "test-key", adminApiKey });
}

function resource(
  resourceTypeId: string,
  fields: Record<string, string | number | boolean>,
  resolvedOutputs: Record<string, string> = {},
): ResourceInstance {
  return {
    id: `acct-1:${resourceTypeId}:ext-1`,
    pluginId: "mistral",
    resourceTypeId,
    accountId: "acct-1",
    displayName: String(fields["name"] ?? fields["modelId"] ?? "thing"),
    externalId: String(fields["voiceId"] ?? "ext-1"),
    fields,
    resolvedOutputs,
    secretStates: [],
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
  };
}

const VOICE_STASH = JSON.stringify([
  { id: "amelie", name: "Amélie", gender: "female", languages: ["fr", "en"], description: "Warm" },
  { id: "hugo", name: "Hugo", gender: "male", languages: ["fr"], description: "" },
]);

const MODEL_STASH = JSON.stringify({
  stt: ["voxtral-mini-transcribe-2602"],
  tts: ["voxtral-mini-tts-2603"],
});

describe("renderDetail — voice", () => {
  it("builds the voice picker from the stashed live list and preselects this voice", () => {
    const detail = client().renderDetail(
      resource(
        "mistral-voice",
        { voiceId: "hugo", name: "Hugo", custom: false },
        { __voices__: VOICE_STASH, __audioModels__: MODEL_STASH },
      ),
    );

    expect(detail.speechPanel?.modes).toEqual(["tts", "stt"]);
    expect(detail.speechPanel?.voices?.map((v) => v.id)).toEqual(["amelie", "hugo"]);
    expect(detail.speechPanel?.voices?.[0]?.description).toContain("female");
    expect(detail.speechPanel?.defaultVoice).toBe("hugo");
    expect(detail.speechPanel?.models?.map((m) => m.id)).toEqual([
      "voxtral-mini-transcribe-2602",
      "voxtral-mini-tts-2603",
    ]);
  });

  it("says preset voices cannot be edited", () => {
    const preset = client().renderDetail(
      resource("mistral-voice", { voiceId: "amelie", name: "Amélie", custom: false }),
    );
    expect(JSON.stringify(preset)).toContain("belong to Mistral");

    const clone = client().renderDetail(
      resource("mistral-voice", { voiceId: "mine", name: "Mine", custom: true }),
    );
    expect(JSON.stringify(clone)).not.toContain("belong to Mistral");
  });

  it("still renders a usable panel when nothing has been stashed yet", () => {
    const detail = client().renderDetail(resource("mistral-voice", { voiceId: "x", name: "X" }));
    expect(detail.speechPanel?.models?.map((m) => m.id)).toEqual([
      "voxtral-mini-latest",
      "voxtral-mini-tts-2603",
    ]);
    expect(detail.speechPanel?.defaultVoice).toBe("x");
  });
});

describe("renderDetail — model", () => {
  it("renders the capabilities object as a table", () => {
    const detail = client().renderDetail(
      resource("mistral-model", {
        modelId: "mistral-large-latest",
        maxContextLength: 131072,
        capabilities: JSON.stringify({ completion_chat: true, vision: false }),
      }),
    );
    const table = detail.sections[1]?.children[0];
    expect(table?.kind).toBe("table");
    expect(JSON.stringify(table)).toContain("completion chat");
    expect(JSON.stringify(detail.sections[0])).toContain("131,072 tokens");
  });
});

describe("renderDetail — batch job", () => {
  it("offers cancel only while the job is queued or running", () => {
    const running = client().renderDetail(
      resource("mistral-batch-job", { jobId: "b1", status: "RUNNING" }),
    );
    expect(JSON.stringify(running.headerActions)).toContain('"actionId":"cancel"');

    const done = client().renderDetail(
      resource("mistral-batch-job", { jobId: "b1", status: "SUCCESS" }),
    );
    expect(JSON.stringify(done.headerActions)).not.toContain('"actionId":"cancel"');
    expect(done.status?.status).toBe("healthy");
  });
});

describe("renderDetail — api key", () => {
  it("explains that keys are minted in the backoffice, not here", () => {
    const detail = client("admin").renderDetail(
      resource("mistral-api-key", { keyId: "k1", name: "ci", hiddenKey: "sk-…abcd" }),
    );
    expect(JSON.stringify(detail)).toContain("Enterprise-only Admin API");
  });
});
