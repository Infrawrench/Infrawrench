import { describe, expect, it } from "vitest";
import { runPluginRenderingTests } from "@infrawrench/plugin-base/test-harness";
import type { ResourceInstance } from "@infrawrench/plugin-base";
import { plugin } from "../plugin.js";
import { RevAiClient, assembleTranscript } from "../client.js";
import { REVAI_TRANSCRIBER_OPTIONS } from "../options.js";

const ACCOUNT = "acct-1";

function client(region = "us"): RevAiClient {
  return new RevAiClient({ accessToken: "test-revai-access-token", region });
}

function account(): ResourceInstance {
  return {
    id: `${ACCOUNT}:account:self`,
    pluginId: "revai",
    resourceTypeId: "account",
    accountId: ACCOUNT,
    displayName: "dev@example.com",
    externalId: "self",
    fields: {
      email: "dev@example.com",
      region: "us",
      endpoint: "https://api.rev.ai/speechtotext/v1",
      freeBalance: 5,
      purchasedBalance: 20,
      totalBalance: 25,
      invoicedBalance: 0,
      hipaaEnabled: false,
    },
    resolvedOutputs: {},
    secretStates: [],
    createdAt: "2026-07-01T00:00:00Z",
    updatedAt: "2026-07-01T00:00:00Z",
  };
}

function job(overrides: Record<string, string | number | boolean> = {}): ResourceInstance {
  return {
    id: `${ACCOUNT}:job:Umx5c6F7pH7r`,
    pluginId: "revai",
    resourceTypeId: "job",
    accountId: ACCOUNT,
    displayName: "sample_audio.mp3",
    externalId: "Umx5c6F7pH7r",
    fields: {
      status: "transcribed",
      name: "sample_audio.mp3",
      durationSeconds: 356.24,
      transcriber: "machine",
      language: "en",
      createdOn: "2026-07-01T00:00:00Z",
      completedOn: "2026-07-01T00:05:00Z",
      failure: "",
      failureDetail: "",
      mediaUrl: "",
      metadata: "",
      deleteAfterSeconds: 0,
      type: "async",
      ...overrides,
    },
    resolvedOutputs: { __transcript__: "Hello World." },
    secretStates: [],
    createdAt: "2026-07-01T00:00:00Z",
    updatedAt: "2026-07-01T00:05:00Z",
  };
}

function vocabulary(status = "complete"): ResourceInstance {
  return {
    id: `${ACCOUNT}:vocabulary:cvgnDwmB6iXevn`,
    pluginId: "revai",
    resourceTypeId: "vocabulary",
    accountId: ACCOUNT,
    displayName: "product names",
    externalId: "cvgnDwmB6iXevn",
    fields: {
      status,
      metadata: "product names",
      createdOn: "2026-07-01T00:00:00Z",
      completedOn: "2026-07-01T00:00:30Z",
      failure: "",
      failureDetail: "",
      callbackUrl: "",
    },
    resolvedOutputs: {},
    secretStates: [],
    createdAt: "2026-07-01T00:00:00Z",
    updatedAt: "2026-07-01T00:00:30Z",
  };
}

runPluginRenderingTests(plugin);

describe("transcriber options", () => {
  it("lists only the four real API values", () => {
    expect(REVAI_TRANSCRIBER_OPTIONS.map((option) => option.id)).toEqual([
      "machine",
      "low_cost",
      "fusion",
      "human",
    ]);
  });

  it("never offers the marketing names reverb / reverb_turbo / whisper", () => {
    const ids = REVAI_TRANSCRIBER_OPTIONS.map((option) => option.id);
    for (const marketingName of ["reverb", "reverb_turbo", "whisper"]) {
      expect(ids).not.toContain(marketingName);
    }
  });
});

describe("assembleTranscript", () => {
  it("concatenates every element including punct, with no added spaces", () => {
    const text = assembleTranscript({
      monologues: [
        {
          speaker: 1,
          elements: [
            { type: "text", value: "Hello", ts: 0.5, end_ts: 1.5, confidence: 1 },
            { type: "punct", value: " " },
            { type: "text", value: "World", ts: 1.75, end_ts: 2.85, confidence: 0.8 },
            { type: "punct", value: "." },
          ],
        },
        {
          speaker: 2,
          elements: [
            { type: "punct", value: " " },
            { type: "unknown", value: "<inaudible>" },
            { type: "punct", value: "." },
          ],
        },
      ],
    });
    expect(text).toBe("Hello World. <inaudible>.");
  });

  it("returns an empty string for an empty transcript", () => {
    expect(assembleTranscript({})).toBe("");
    expect(assembleTranscript({ monologues: [] })).toBe("");
  });
});

describe("renderDetail", () => {
  it("declares an STT-only speech panel on the account", () => {
    const schema = client().renderDetail(account());
    expect(schema.speechPanel?.modes).toEqual(["stt"]);
    expect(schema.speechPanel?.maxAudioBytes).toBe(2 * 1024 * 1024 * 1024);
    expect(schema.speechPanel?.modelLabel).toBe("Transcriber");
    expect(schema.speechPanel?.defaultModel).toBe("machine");
  });

  it("shows the USD balances and never balance_seconds", () => {
    const schema = client().renderDetail(account());
    const balance = schema.sections.find((section) => section.title === "Balance");
    const list = balance?.children.find((child) => child.kind === "key-value-list");
    const items = list?.kind === "key-value-list" ? list.items : [];
    expect(items.map((item) => item.key)).toEqual(["Total", "Free", "Purchased", "Invoiced"]);
    expect(items.find((item) => item.key === "Total")?.value).toBe("$25.00");
    const note = balance?.children.find((child) => child.kind === "text");
    expect(note && "content" in note ? note.content : "").toMatch(/balance_seconds.*deprecated/);
  });

  it("names the EU deployment in the panel subtitle", () => {
    const euAccount = account();
    euAccount.fields["region"] = "eu";
    const schema = client("eu").renderDetail(euAccount);
    expect(schema.subtitle).toContain("Frankfurt");
    expect(schema.speechPanel?.subtitle).toContain("eu");
  });

  it("renders the stashed transcript on a transcribed job", () => {
    const schema = client().renderDetail(job());
    const section = schema.sections.find((s) => s.title === "Transcript");
    const text = section?.children[0];
    expect(text && "content" in text ? text.content : "").toBe("Hello World.");
    expect(schema.status?.status).toBe("healthy");
  });

  it("surfaces failure and failure_detail on a failed job", () => {
    const schema = client().renderDetail(
      job({ status: "failed", failure: "download_failure", failureDetail: "bad url" }),
    );
    expect(schema.status?.status).toBe("error");
    const failure = schema.sections.find((s) => s.title === "Failure");
    const list = failure?.children[0];
    const items = list?.kind === "key-value-list" ? list.items : [];
    expect(items.map((item) => item.value)).toEqual(["download_failure", "bad url"]);
  });

  it("treats vocabulary status `complete` (not `completed`) as healthy", () => {
    expect(client().renderDetail(vocabulary("complete")).status?.status).toBe("healthy");
    expect(client().renderDetail(vocabulary("completed")).status?.status).toBe("info");
    expect(client().renderDetail(vocabulary("in_progress")).status?.status).toBe("provisioning");
  });
});

describe("renderSidebarItem", () => {
  it("maps the three job statuses onto the status dot", () => {
    const c = client();
    expect(c.renderSidebarItem(job()).status?.status).toBe("healthy");
    expect(c.renderSidebarItem(job({ status: "in_progress" })).status?.status).toBe("provisioning");
    expect(c.renderSidebarItem(job({ status: "failed" })).status?.status).toBe("error");
  });
});
