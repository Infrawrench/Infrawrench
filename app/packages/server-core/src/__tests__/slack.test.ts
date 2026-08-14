import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";

import { fakePostgres } from "./helpers/fake-postgres";

/**
 * Slack transport tests. Two halves:
 *
 *  - the signed install `state`, which is the only thing binding an OAuth
 *    round-trip to an org — a forgeable one would let anyone attach their
 *    workspace to someone else's org;
 *  - the fan-out, where the interesting behavior is that channels are addressed
 *    by stored row id (routing itself is `alerts/route.ts`' job now), and that
 *    alert text is escaped before it reaches Slack's mrkdwn parser.
 *
 * The DB is real Drizzle over a recording driver (helpers/fake-postgres.ts);
 * a fan-out issues the channel-resolution join first and the installation load
 * second, so results are queued FIFO in that order. `fetch` is spied on
 * `globalThis`.
 */

vi.mock("../encryption", () => ({
  encrypt: async () => ({ ciphertext: "CT", iv: "IV" }),
  decrypt: async (ct: string) => (ct === "THROW" ? Promise.reject(new Error("bad key")) : "xoxb-1"),
  buildAad: (...parts: string[]) => parts.join(":"),
}));

const pg = fakePostgres();
vi.mock("../db/client", () => ({ db: pg.db }));

const ORG = "org1";

/** One live installation whose token decrypts to `xoxb-1`. */
function installation(overrides: Record<string, unknown> = {}) {
  // Keys in slack_installations column order — see helpers/fake-postgres.ts.
  return {
    id: "inst1",
    organizationId: ORG,
    teamId: "T1",
    teamName: "Acme",
    botUserId: "U1",
    scopes: null,
    encryptedBotToken: "ENC",
    botTokenIv: "IV",
    installedByUserId: null,
    deletedAt: null,
    createdAt: "2026-01-01 00:00:00",
    updatedAt: "2026-01-01 00:00:00",
    ...overrides,
  };
}

/** Queue the `resolveSlackChannels` join result. Keys in projection order. */
function queueChannels(
  rows: Array<{ channelId: string; channelName: string; installationId: string }>,
) {
  pg.queueRows(
    rows.map((r) => ({
      channelId: r.channelId,
      channelName: r.channelName,
      installationId: r.installationId,
    })),
  );
}

/** Queue the org's live-installation load (`select().from(slackInstallations)`). */
function queueInstallations(rows: Array<Record<string, unknown>>) {
  pg.queueRows(rows);
}

let fetchSpy: ReturnType<typeof vi.spyOn>;

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  process.env["SLACK_CLIENT_ID"] = "cid";
  process.env["SLACK_CLIENT_SECRET"] = "csecret";
  pg.reset();
  // A fresh Response per call — a body can only be read once, so a shared one
  // would make every call after the first look like a failure.
  fetchSpy = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async () => jsonResponse({ ok: true }));
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env["SLACK_CLIENT_ID"];
  delete process.env["SLACK_CLIENT_SECRET"];
});

describe("install state", () => {
  it("round-trips the org and the installing user", async () => {
    const { signSlackState, verifySlackState } = await import("../slack");
    const state = signSlackState(ORG, "user1");
    expect(verifySlackState(state)).toEqual({ organizationId: ORG, userId: "user1" });
  });

  it("round-trips without a user id", async () => {
    const { signSlackState, verifySlackState } = await import("../slack");
    expect(verifySlackState(signSlackState(ORG))).toEqual({ organizationId: ORG, userId: null });
  });

  it("rejects a tampered payload", async () => {
    const { signSlackState, verifySlackState } = await import("../slack");
    const [, mac] = signSlackState(ORG).split(".");
    const forged = Buffer.from(JSON.stringify({ o: "other-org" })).toString("base64url");
    expect(verifySlackState(`${forged}.${mac}`)).toBeNull();
  });

  it("rejects a state signed with a different client secret", async () => {
    const { signSlackState, verifySlackState } = await import("../slack");
    const state = signSlackState(ORG);
    process.env["SLACK_CLIENT_SECRET"] = "rotated";
    expect(verifySlackState(state)).toBeNull();
  });

  it("rejects malformed states", async () => {
    const { verifySlackState } = await import("../slack");
    expect(verifySlackState("")).toBeNull();
    expect(verifySlackState("no-dot")).toBeNull();
    expect(verifySlackState("a.b")).toBeNull();
  });
});

describe("authorize URL", () => {
  it("carries the scopes, state, and redirect", async () => {
    const { slackAuthorizeUrl, SLACK_SCOPES } = await import("../slack");
    const url = new URL(slackAuthorizeUrl("st4te", "https://app.example/api/slack/oauth/callback"));
    expect(url.origin + url.pathname).toBe("https://slack.com/oauth/v2/authorize");
    expect(url.searchParams.get("client_id")).toBe("cid");
    expect(url.searchParams.get("state")).toBe("st4te");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://app.example/api/slack/oauth/callback",
    );
    expect(url.searchParams.get("scope")).toBe(SLACK_SCOPES.join(","));
  });

  it("requests chat:write.public so public channels need no invite", async () => {
    const { SLACK_SCOPES } = await import("../slack");
    expect(SLACK_SCOPES).toContain("chat:write.public");
  });
});

describe("sendSlackToChannels", () => {
  const alert = { title: "Disk full", body: "node-1 at 98%" };

  it("is a no-op when the server has no Slack app", async () => {
    delete process.env["SLACK_CLIENT_ID"];
    const { sendSlackToChannels } = await import("../slack");
    expect(await sendSlackToChannels(ORG, ["row1"], alert)).toEqual({
      attempted: 0,
      succeeded: 0,
      failed: 0,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("is a no-op when the named rows resolve to nothing", async () => {
    queueChannels([]); // the join resolves nothing; the install load never runs
    const { sendSlackToChannels } = await import("../slack");
    expect(await sendSlackToChannels(ORG, ["row1"], alert)).toEqual({
      attempted: 0,
      succeeded: 0,
      failed: 0,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("is a no-op when the rule named no channels at all, without querying", async () => {
    // The empty-selection short circuit in `resolveSlackChannels` runs before
    // the query. Worth its own case: a rule whose Slack destinations were all
    // removed must not fall through to "every channel in the org", which is
    // what an unguarded `inArray(…, [])` would risk.
    queueChannels([{ channelId: "C1", channelName: "alerts", installationId: "inst1" }]);
    const { sendSlackToChannels } = await import("../slack");
    expect(await sendSlackToChannels(ORG, [], alert)).toEqual({
      attempted: 0,
      succeeded: 0,
      failed: 0,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    // "Without querying" is now literal: the queued rows were never consumed.
    expect(pg.queries).toEqual([]);
  });

  it("posts to every named channel", async () => {
    // The fixture reads as the result of the `inArray(slackChannels.id, rowIds)`
    // filter rather than as every row in the org. (The recording driver ignores
    // predicates; the filter itself is the query's job, covered by the route
    // tests — but the rendered SQL below pins that the filter is issued.)
    queueChannels([
      { channelId: "C1", channelName: "alerts", installationId: "inst1" },
      { channelId: "C2", channelName: "oncall", installationId: "inst1" },
    ]);
    queueInstallations([installation()]);
    const { sendSlackToChannels } = await import("../slack");
    const result = await sendSlackToChannels(ORG, ["row1", "row2"], alert);
    expect(result).toEqual({ attempted: 2, succeeded: 2, failed: 0 });
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    expect(pg.queries[0]!.sql).toContain('from "slack_channels"');
    expect(pg.queries[0]!.params).toEqual([ORG, "row1", "row2"]);

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://slack.com/api/chat.postMessage");
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer xoxb-1");
    expect(JSON.parse(init.body as string).channel).toBe("C1");
  });

  it("counts an ok:false envelope as a failure", async () => {
    queueChannels([{ channelId: "C1", channelName: "secret", installationId: "inst1" }]);
    queueInstallations([installation()]);
    fetchSpy.mockImplementation(async () => jsonResponse({ ok: false, error: "not_in_channel" }));
    const { sendSlackToChannels } = await import("../slack");
    expect(await sendSlackToChannels(ORG, ["row1"], alert)).toEqual({
      attempted: 1,
      succeeded: 0,
      failed: 1,
    });
  });

  it("escapes mrkdwn delimiters in alert text", async () => {
    queueChannels([{ channelId: "C1", channelName: "alerts", installationId: "inst1" }]);
    queueInstallations([installation()]);
    const { sendSlackToChannels } = await import("../slack");
    await sendSlackToChannels(ORG, ["row1"], {
      title: "5 > 3",
      body: 'connect failed: <host "db" & port>',
    });
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const sent = JSON.parse(init.body as string) as {
      blocks: Array<{ text?: { text: string } }>;
    };
    const section = sent.blocks[0]?.text?.text ?? "";
    expect(section).toContain("5 &gt; 3");
    expect(section).toContain("&lt;host");
    expect(section).toContain("&amp; port&gt;");
    expect(section).not.toMatch(/<host/);
  });

  it("never throws when a transport error escapes", async () => {
    queueChannels([{ channelId: "C1", channelName: "alerts", installationId: "inst1" }]);
    queueInstallations([installation()]);
    fetchSpy.mockRejectedValue(new Error("network down"));
    const { sendSlackToChannels } = await import("../slack");
    expect(await sendSlackToChannels(ORG, ["row1"], alert)).toEqual({
      attempted: 1,
      succeeded: 0,
      failed: 1,
    });
  });

  it("skips a channel whose install has been disconnected", async () => {
    // resolveSlackChannels joins on a live install, but the token map is built
    // separately — a row that survives the join without a token must not post.
    queueChannels([{ channelId: "C1", channelName: "alerts", installationId: "gone" }]);
    queueInstallations([]);
    const { sendSlackToChannels } = await import("../slack");
    expect(await sendSlackToChannels(ORG, ["row1"], alert)).toEqual({
      attempted: 1,
      succeeded: 0,
      failed: 1,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("listSlackChannels", () => {
  /**
   * Slack's reference says `conversations.list` accepts `application/json`, but
   * it does not honour arguments sent that way: it answers `ok: true` with
   * `types` defaulted to public channels only. That is invisible from the
   * response — the bug looked like a missing scope or a missing invite — so the
   * encoding is pinned here rather than left to whoever edits slackCall next.
   */
  it("asks for private channels form-encoded, because JSON is silently ignored", async () => {
    queueInstallations([installation()]);
    fetchSpy.mockImplementation(async () =>
      jsonResponse({
        ok: true,
        channels: [
          { id: "C1", name: "general", is_private: false },
          { id: "C2", name: "alerting", is_private: true },
        ],
      }),
    );

    const { listSlackChannels } = await import("../slack");
    const channels = await listSlackChannels(ORG, "inst1");

    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("conversations.list");
    expect((init.headers as Record<string, string>)["Content-Type"]).toMatch(
      /application\/x-www-form-urlencoded/,
    );
    const sent = new URLSearchParams(String(init.body));
    expect(sent.get("types")).toBe("public_channel,private_channel");
    expect(sent.get("exclude_archived")).toBe("true");

    expect(channels).toEqual([
      { id: "C2", name: "alerting", isPrivate: true },
      { id: "C1", name: "general", isPrivate: false },
    ]);
  });

  it("drops archived channels and follows the cursor", async () => {
    queueInstallations([installation()]);
    let call = 0;
    fetchSpy.mockImplementation(async () => {
      call += 1;
      return call === 1
        ? jsonResponse({
            ok: true,
            channels: [
              { id: "C1", name: "keep", is_private: false },
              { id: "C2", name: "gone", is_archived: true },
            ],
            response_metadata: { next_cursor: "page2" },
          })
        : jsonResponse({ ok: true, channels: [{ id: "C3", name: "second-page" }] });
    });

    const { listSlackChannels } = await import("../slack");
    const channels = await listSlackChannels(ORG, "inst1");
    expect(channels.map((c) => c.name)).toEqual(["keep", "second-page"]);
    const [, secondInit] = fetchSpy.mock.calls[1] as unknown as [string, RequestInit];
    expect(new URLSearchParams(String(secondInit.body)).get("cursor")).toBe("page2");
  });

  it("still posts messages as JSON, which chat.postMessage does honour", async () => {
    queueChannels([{ channelId: "C1", channelName: "alerts", installationId: "inst1" }]);
    queueInstallations([installation()]);
    const { sendSlackToChannels } = await import("../slack");
    await sendSlackToChannels(ORG, ["row1"], { title: "t", body: "b" });
    const [, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>)["Content-Type"]).toMatch(/application\/json/);
  });
});

/**
 * Inbound request authentication. The signature is the *only* thing standing
 * between the public /api/slack/* endpoints and anyone on the internet, so
 * the scheme is pinned exactly: HMAC-SHA256 over `v0:<timestamp>:<raw body>`,
 * hex, `v0=` prefix, constant-time compare, 5-minute replay window.
 */
describe("verifySlackRequestSignature", () => {
  const SECRET = "8f742231b10e8888abcd99yyyzzz85a5";
  const BODY = "token=x&team_id=T1&user_id=U1&command=%2Finfrawrench&text=costs";

  function sign(secret: string, timestamp: string, body: string): string {
    return "v0=" + createHmac("sha256", secret).update(`v0:${timestamp}:${body}`).digest("hex");
  }

  beforeEach(() => {
    process.env["SLACK_SIGNING_SECRET"] = SECRET;
  });
  afterEach(() => {
    delete process.env["SLACK_SIGNING_SECRET"];
  });

  it("accepts a correctly signed, fresh request", async () => {
    const { verifySlackRequestSignature } = await import("../slack");
    const now = 1_722_700_000_000;
    const ts = String(Math.floor(now / 1000) - 30);
    expect(
      verifySlackRequestSignature({
        rawBody: BODY,
        timestamp: ts,
        signature: sign(SECRET, ts, BODY),
        nowMs: now,
      }),
    ).toBe(true);
  });

  it("rejects a signature made with a different secret", async () => {
    const { verifySlackRequestSignature } = await import("../slack");
    const now = 1_722_700_000_000;
    const ts = String(Math.floor(now / 1000));
    expect(
      verifySlackRequestSignature({
        rawBody: BODY,
        timestamp: ts,
        signature: sign("some-other-secret", ts, BODY),
        nowMs: now,
      }),
    ).toBe(false);
  });

  it("rejects a tampered body", async () => {
    const { verifySlackRequestSignature } = await import("../slack");
    const now = 1_722_700_000_000;
    const ts = String(Math.floor(now / 1000));
    expect(
      verifySlackRequestSignature({
        rawBody: BODY.replace("costs", "status prod-db"),
        timestamp: ts,
        signature: sign(SECRET, ts, BODY),
        nowMs: now,
      }),
    ).toBe(false);
  });

  it("rejects a replayed (stale) timestamp even with a valid signature", async () => {
    const { verifySlackRequestSignature } = await import("../slack");
    const now = 1_722_700_000_000;
    const ts = String(Math.floor(now / 1000) - 6 * 60);
    expect(
      verifySlackRequestSignature({
        rawBody: BODY,
        timestamp: ts,
        signature: sign(SECRET, ts, BODY),
        nowMs: now,
      }),
    ).toBe(false);
  });

  it("rejects missing headers and refuses everything without the secret", async () => {
    const { verifySlackRequestSignature } = await import("../slack");
    const now = 1_722_700_000_000;
    const ts = String(Math.floor(now / 1000));
    const good = sign(SECRET, ts, BODY);
    expect(
      verifySlackRequestSignature({ rawBody: BODY, timestamp: undefined, signature: good }),
    ).toBe(false);
    expect(
      verifySlackRequestSignature({ rawBody: BODY, timestamp: ts, signature: undefined }),
    ).toBe(false);
    delete process.env["SLACK_SIGNING_SECRET"];
    expect(
      verifySlackRequestSignature({ rawBody: BODY, timestamp: ts, signature: good, nowMs: now }),
    ).toBe(false);
  });

  it("rejects malformed signatures — truncated or missing the v0= prefix — without throwing", async () => {
    const { verifySlackRequestSignature } = await import("../slack");
    const now = 1_722_700_000_000;
    const ts = String(Math.floor(now / 1000));
    const good = sign(SECRET, ts, BODY);
    // Truncated: different length must fail cleanly, not trip timingSafeEqual.
    expect(
      verifySlackRequestSignature({
        rawBody: BODY,
        timestamp: ts,
        signature: good.slice(0, 12),
        nowMs: now,
      }),
    ).toBe(false);
    // Right length, wrong scheme prefix: the digest may match but the version
    // marker is part of what is signed and compared.
    expect(
      verifySlackRequestSignature({
        rawBody: BODY,
        timestamp: ts,
        signature: `v1=${good.slice(3)}`,
        nowMs: now,
      }),
    ).toBe(false);
    // Prefixless hex of the right digest, same length as `v0=` + digest minus
    // the marker: still refused.
    expect(
      verifySlackRequestSignature({
        rawBody: BODY,
        timestamp: ts,
        signature: good.slice(3),
        nowMs: now,
      }),
    ).toBe(false);
  });
});

/**
 * Account-link tokens: the ephemeral "link your account" URL a slash command
 * hands an unknown Slack user. A forgeable token would let anyone attach their
 * Slack identity to someone else's org, so tamper and expiry both refuse.
 */
describe("slack link tokens", () => {
  beforeEach(() => {
    process.env["SLACK_SIGNING_SECRET"] = "signing-secret";
  });
  afterEach(() => {
    delete process.env["SLACK_SIGNING_SECRET"];
  });

  const REQ = { organizationId: ORG, teamId: "T1", slackUserId: "U42" };

  it("round-trips org, workspace and Slack user", async () => {
    const { signSlackLinkToken, verifySlackLinkToken } = await import("../slack");
    expect(verifySlackLinkToken(signSlackLinkToken(REQ))).toEqual(REQ);
  });

  it("expires after 15 minutes", async () => {
    const { signSlackLinkToken, verifySlackLinkToken } = await import("../slack");
    const now = 1_722_700_000_000;
    const token = signSlackLinkToken(REQ, now);
    expect(verifySlackLinkToken(token, now + 14 * 60_000)).toEqual(REQ);
    expect(verifySlackLinkToken(token, now + 16 * 60_000)).toBeNull();
  });

  it("rejects a tampered payload", async () => {
    const { signSlackLinkToken, verifySlackLinkToken } = await import("../slack");
    const [, mac] = signSlackLinkToken(REQ).split(".");
    const forged = Buffer.from(
      JSON.stringify({ o: "other-org", t: "T1", s: "U42", e: Date.now() + 60_000 }),
    ).toString("base64url");
    expect(verifySlackLinkToken(`${forged}.${mac}`)).toBeNull();
  });

  it("rejects a token signed under a rotated secret", async () => {
    const { signSlackLinkToken, verifySlackLinkToken } = await import("../slack");
    const token = signSlackLinkToken(REQ);
    process.env["SLACK_SIGNING_SECRET"] = "rotated";
    expect(verifySlackLinkToken(token)).toBeNull();
  });
});

/**
 * The tracked fan-out behind interactive approval messages: buttons render as
 * a Block Kit actions block, and each delivered message comes back with its
 * channel + ts so a decision can rewrite it later.
 */
describe("sendSlackToChannelsTracked", () => {
  it("renders buttons and returns the posted message refs", async () => {
    queueChannels([{ channelId: "C1", channelName: "approvals", installationId: "inst1" }]);
    queueInstallations([installation()]);
    fetchSpy.mockImplementation(async () =>
      jsonResponse({ ok: true, ts: "1722700000.000100", channel: "C1" }),
    );
    const { sendSlackToChannelsTracked } = await import("../slack");
    const result = await sendSlackToChannelsTracked(ORG, ["row1"], {
      title: "Approval needed",
      body: "Roll the API to v42?",
      buttons: [
        {
          text: "Approve",
          actionId: "infrawrench_approval_approve",
          value: "v1",
          style: "primary",
        },
        { text: "Deny", actionId: "infrawrench_approval_deny", value: "v1", style: "danger" },
      ],
    });

    expect(result).toMatchObject({ attempted: 1, succeeded: 1, failed: 0 });
    expect(result.messages).toEqual([
      { installationId: "inst1", channelId: "C1", ts: "1722700000.000100" },
    ]);

    const [, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    const sent = JSON.parse(String(init.body)) as {
      blocks: Array<{ type: string; elements?: Array<Record<string, unknown>> }>;
    };
    const actions = sent.blocks.find((b) => b.type === "actions");
    expect(actions?.elements).toHaveLength(2);
    expect(actions?.elements?.[0]).toMatchObject({
      type: "button",
      action_id: "infrawrench_approval_approve",
      value: "v1",
      style: "primary",
    });
  });

  it("keeps sendSlackToChannels' shape for untracked callers", async () => {
    queueChannels([{ channelId: "C1", channelName: "alerts", installationId: "inst1" }]);
    queueInstallations([installation()]);
    const { sendSlackToChannels } = await import("../slack");
    expect(await sendSlackToChannels(ORG, ["row1"], { title: "t", body: "b" })).toEqual({
      attempted: 1,
      succeeded: 1,
      failed: 0,
    });
  });
});
