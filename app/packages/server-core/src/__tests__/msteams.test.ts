import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fakePostgres } from "./helpers/fake-postgres";

/**
 * Microsoft Teams transport tests. The interesting behavior is in three places:
 *
 *  - URL validation, which is a security control rather than a convenience.
 *    The server POSTs to whatever an org member pastes, so anything that isn't
 *    an https Microsoft host has to be refused;
 *  - the fan-out, where a channel must only get the triggers it opted into,
 *    and alert text must be escaped before it reaches the Adaptive Card
 *    markdown renderer;
 *  - the 429 retry, because Microsoft throttles a webhook above 4 req/s and a
 *    dropped page is worse than a slow one.
 *
 * The DB is real Drizzle over a recording driver (`fake-postgres.ts`) against
 * the real schema, so the webhook reads render their actual SQL; `fetch` is
 * spied on `globalThis`.
 */

vi.mock("../encryption", () => ({
  encrypt: async () => ({ ciphertext: "CT", iv: "IV" }),
  decrypt: async (ct: string) =>
    ct === "THROW"
      ? Promise.reject(new Error("bad key"))
      : "https://acme.webhook.office.com/webhookb2/abc/IncomingWebhook/def",
  buildAad: (...parts: string[]) => parts.join(":"),
  keyedHash: async (data: string) => `digest(${data})`,
}));

const pg = fakePostgres();
vi.mock("../db/client", () => ({ db: pg.db }));

const ORG = "org1";

// Keys in the `msteams_webhooks` column order, values driver-shaped — see
// helpers/fake-postgres.ts.
function webhook(overrides: Record<string, unknown> = {}) {
  return {
    id: "wh1",
    organizationId: ORG,
    label: "#alerts",
    encryptedUrl: "ENC",
    urlIv: "IV",
    urlDigest: "digest(url)",
    urlHost: "acme.webhook.office.com",
    urlHint: "acme.webhook.office.com · …/def",
    createdByUserId: null,
    createdAt: "2026-08-01T00:00:00.000",
    updatedAt: "2026-08-01T00:00:00.000",
    ...overrides,
  };
}

let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  pg.reset();
  fetchSpy = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async () => new Response("", { status: 200 }));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("parseWebhookUrl", () => {
  const good = [
    "https://acme.webhook.office.com/webhookb2/abc/IncomingWebhook/def",
    "https://prod-30.westus.logic.azure.com:443/workflows/abc/triggers/manual/paths/invoke?sig=xyz",
    "https://default1234.05.environment.api.powerplatform.com:443/powerautomate/automations/direct/workflows/abc/triggers/manual/paths/invoke",
    "https://x.api.powerautomate.com/foo",
    "https://emea.flow.microsoft.com/hook",
  ];
  for (const url of good) {
    it(`accepts ${new URL(url).hostname}`, async () => {
      const { parseWebhookUrl } = await import("../msteams");
      expect(parseWebhookUrl(url).url).toBe(url);
    });
  }

  it("rejects a non-Microsoft host", async () => {
    const { parseWebhookUrl } = await import("../msteams");
    expect(() => parseWebhookUrl("https://evil.example.com/hook")).toThrow(
      /not a Microsoft Teams webhook host/,
    );
  });

  /**
   * The allowlist is suffix-matched, so a lookalike registered domain that
   * merely *contains* an allowed host must not slip through.
   */
  it("rejects a lookalike domain", async () => {
    const { parseWebhookUrl } = await import("../msteams");
    expect(() => parseWebhookUrl("https://logic.azure.com.evil.example/hook")).toThrow(
      /not a Microsoft Teams webhook host/,
    );
  });

  it("rejects plaintext http even on an allowed host", async () => {
    const { parseWebhookUrl } = await import("../msteams");
    expect(() => parseWebhookUrl("http://acme.webhook.office.com/hook")).toThrow(/https/);
  });

  it("rejects a non-http scheme that could reach the local filesystem", async () => {
    const { parseWebhookUrl } = await import("../msteams");
    expect(() => parseWebhookUrl("file:///etc/passwd")).toThrow(/https/);
  });

  it("rejects junk", async () => {
    const { parseWebhookUrl } = await import("../msteams");
    expect(() => parseWebhookUrl("not a url")).toThrow(/doesn't look like a URL/);
    expect(() => parseWebhookUrl("   ")).toThrow(/required/);
  });

  it("derives a hint that reveals the host but not the signature", async () => {
    const { parseWebhookUrl } = await import("../msteams");
    const { hint } = parseWebhookUrl(
      "https://prod-30.westus.logic.azure.com/workflows/abc?sig=SUPERSECRETVALUE",
    );
    expect(hint).toContain("prod-30.westus.logic.azure.com");
    expect(hint).not.toContain("SUPERSECRET");
  });
});

describe("fan-out", () => {
  it("posts nothing when the org has no webhooks", async () => {
    const { sendMsTeamsToWebhooks } = await import("../msteams");
    const res = await sendMsTeamsToWebhooks(ORG, ["row1"], { title: "t", body: "b" });
    expect(res).toEqual({ attempted: 0, succeeded: 0, failed: 0 });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("scopes the read to the requested row ids and the caller's org", async () => {
    // The trigger columns this used to filter on are gone; a webhook is
    // addressed by stored row id and the org scoping is what stops one org
    // routing an alert into another's channel.
    const { sendMsTeamsToWebhooks } = await import("../msteams");
    pg.setRows([webhook()]);
    await sendMsTeamsToWebhooks(ORG, ["row1", "row2"], { title: "t", body: "b" });
    expect(pg.lastQuery().sql).toContain('from "msteams_webhooks"');
    // The org scoping and both requested ids, as rendered parameters.
    expect(pg.lastQuery().params).toEqual([ORG, "row1", "row2"]);
  });

  it("posts an Adaptive Card in a message envelope", async () => {
    const { sendMsTeamsToWebhooks } = await import("../msteams");
    pg.setRows([webhook()]);
    const res = await sendMsTeamsToWebhooks(ORG, ["row1"], {
      title: "Budget at 90%",
      body: "prod is over",
      url: "https://app.example/org/1/budgets/2",
      context: "2026-07 · forecast",
    });

    expect(res).toEqual({ attempted: 1, succeeded: 1, failed: 0 });
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://acme.webhook.office.com/webhookb2/abc/IncomingWebhook/def");
    expect(init.method).toBe("POST");

    const payload = JSON.parse(init.body as string);
    expect(payload.type).toBe("message");
    const card = payload.attachments[0];
    expect(card.contentType).toBe("application/vnd.microsoft.card.adaptive");
    expect(card.content.type).toBe("AdaptiveCard");
    expect(card.content.body[0].text).toBe("Budget at 90%");
    expect(card.content.body[1].text).toBe("prod is over");
    expect(card.content.body[2].text).toBe("2026-07 · forecast");
    expect(card.content.actions[0]).toMatchObject({
      type: "Action.OpenUrl",
      url: "https://app.example/org/1/budgets/2",
    });
  });

  it("omits the action when there is no deep link", async () => {
    const { sendMsTeamsToWebhooks } = await import("../msteams");
    pg.setRows([webhook()]);
    await sendMsTeamsToWebhooks(ORG, ["row1"], { title: "t", body: "b" });
    const payload = JSON.parse((fetchSpy.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(payload.attachments[0].content.actions).toBeUndefined();
  });

  /**
   * Alert bodies carry provider error text. An unescaped `[` would make the
   * card renderer eat the rest of the line as a malformed link.
   */
  it("escapes markdown in alert text", async () => {
    const { sendMsTeamsToWebhooks } = await import("../msteams");
    pg.setRows([webhook()]);
    await sendMsTeamsToWebhooks(ORG, ["row1"], {
      title: "t",
      body: "unexpected [token] in *config*_v2",
    });
    const payload = JSON.parse((fetchSpy.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(payload.attachments[0].content.body[1].text).toBe(
      String.raw`unexpected \[token\] in \*config\*\_v2`,
    );
  });

  it("counts a failed webhook without throwing", async () => {
    const { sendMsTeamsToWebhooks } = await import("../msteams");
    pg.setRows([webhook()]);
    fetchSpy.mockResolvedValue(new Response("Flow not found", { status: 404 }));
    const res = await sendMsTeamsToWebhooks(ORG, ["row1"], { title: "t", body: "b" });
    expect(res).toEqual({ attempted: 1, succeeded: 0, failed: 1 });
  });

  it("keeps delivering when one webhook of several fails", async () => {
    const { sendMsTeamsToWebhooks } = await import("../msteams");
    pg.setRows([webhook({ id: "a" }), webhook({ id: "b" })]);
    fetchSpy
      .mockResolvedValueOnce(new Response("nope", { status: 500 }))
      .mockResolvedValueOnce(new Response("", { status: 200 }));
    // The requested ids match the fixture rows, so this reads as the two-webhook
    // fan-out it is meant to be.
    const res = await sendMsTeamsToWebhooks(ORG, ["a", "b"], { title: "t", body: "b" });
    expect(res).toEqual({ attempted: 2, succeeded: 1, failed: 1 });
    expect(pg.lastQuery().params).toEqual([ORG, "a", "b"]);
  });

  it("skips a row whose URL cannot be decrypted", async () => {
    const { sendMsTeamsToWebhooks } = await import("../msteams");
    pg.setRows([webhook({ encryptedUrl: "THROW" })]);
    const res = await sendMsTeamsToWebhooks(ORG, ["row1"], { title: "t", body: "b" });
    expect(res).toEqual({ attempted: 0, succeeded: 0, failed: 0 });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("counts a rejected post as a failure instead of throwing", async () => {
    const { sendMsTeamsToWebhooks } = await import("../msteams");
    pg.setRows([webhook()]);
    fetchSpy.mockRejectedValue(new Error("network down"));
    await expect(sendMsTeamsToWebhooks(ORG, ["row1"], { title: "t", body: "b" })).resolves.toEqual({
      attempted: 1,
      succeeded: 0,
      failed: 1,
    });
  });

  it("never throws, even when the query itself blows up", async () => {
    // The outer try/catch, which the per-post rejection above never reaches: a
    // database failure must return NO_DELIVERY rather than propagate into the
    // poller that raised the alert.
    const { sendMsTeamsToWebhooks } = await import("../msteams");
    // A row the recording driver cannot decode makes the select itself reject
    // — the closest a canned driver gets to "connection refused".
    pg.queueRows([null as never]);
    await expect(sendMsTeamsToWebhooks(ORG, ["row1"], { title: "t", body: "b" })).resolves.toEqual({
      attempted: 0,
      succeeded: 0,
      failed: 0,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("throttling", () => {
  it("retries once after a 429 and succeeds", async () => {
    vi.useFakeTimers();
    try {
      const { sendMsTeamsToWebhooks } = await import("../msteams");
      pg.setRows([webhook()]);
      fetchSpy
        .mockResolvedValueOnce(new Response("", { status: 429, headers: { "retry-after": "1" } }))
        .mockResolvedValueOnce(new Response("", { status: 200 }));

      const pending = sendMsTeamsToWebhooks(ORG, ["row1"], { title: "t", body: "b" });
      await vi.runAllTimersAsync();
      expect(await pending).toEqual({ attempted: 1, succeeded: 1, failed: 0 });
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives up after a second 429 rather than looping", async () => {
    vi.useFakeTimers();
    try {
      const { sendMsTeamsToWebhooks } = await import("../msteams");
      pg.setRows([webhook()]);
      fetchSpy.mockResolvedValue(
        new Response("", { status: 429, headers: { "retry-after": "1" } }),
      );

      const pending = sendMsTeamsToWebhooks(ORG, ["row1"], { title: "t", body: "b" });
      await vi.runAllTimersAsync();
      expect(await pending).toEqual({ attempted: 1, succeeded: 0, failed: 1 });
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("sendMsTeamsTest", () => {
  it("refuses when nothing is configured", async () => {
    const { sendMsTeamsTest } = await import("../msteams");
    await expect(sendMsTeamsTest(ORG)).rejects.toThrow(/No Teams channels configured/);
  });

  it("surfaces the webhook's error, labelled, when every send fails", async () => {
    const { sendMsTeamsTest } = await import("../msteams");
    pg.setRows([webhook({ label: "#ops" })]);
    fetchSpy.mockResolvedValue(new Response("Flow not found", { status: 404 }));
    await expect(sendMsTeamsTest(ORG)).rejects.toThrow(/#ops: HTTP 404 — Flow not found/);
  });

  it("ignores trigger opt-ins and reports a summary", async () => {
    const { sendMsTeamsTest } = await import("../msteams");
    pg.setRows([webhook({ id: "a" }), webhook({ id: "b" })]);
    await expect(sendMsTeamsTest(ORG)).resolves.toEqual({
      webhookCount: 2,
      attempted: 2,
      succeeded: 2,
    });
  });
});
