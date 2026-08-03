import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";

/**
 * Slack transport tests. Two halves:
 *
 *  - the signed install `state`, which is the only thing binding an OAuth
 *    round-trip to an org — a forgeable one would let anyone attach their
 *    workspace to someone else's org;
 *  - the fan-out, where the interesting behavior is that a channel only gets
 *    the triggers it opted into, and that alert text is escaped before it
 *    reaches Slack's mrkdwn parser.
 *
 * The DB is mocked with a chainable fake; `fetch` is spied on `globalThis`.
 */

vi.mock("../encryption", () => ({
  encrypt: async () => ({ ciphertext: "CT", iv: "IV" }),
  decrypt: async (ct: string) => (ct === "THROW" ? Promise.reject(new Error("bad key")) : "xoxb-1"),
  buildAad: (...parts: string[]) => parts.join(":"),
}));

const tables = {
  slackInstallations: {
    __t: "slackInstallations" as const,
    id: "id",
    organizationId: "organizationId",
    deletedAt: "deletedAt",
  },
  slackChannels: {
    __t: "slackChannels" as const,
    id: "id",
    organizationId: "organizationId",
    installationId: "installationId",
    channelId: "channelId",
    channelName: "channelName",
    syncIncidents: "syncIncidents",
    budgetAlerts: "budgetAlerts",
    workflowPages: "workflowPages",
  },
};
vi.mock("../db/schema", () => tables);

/** Rows the next `select().from(<table>)` chain resolves to. */
let installationRows: unknown[] = [];
let channelRows: unknown[] = [];

vi.mock("../db/client", () => {
  const chain = (rows: () => unknown[]) => {
    const self: Record<string, unknown> = {};
    for (const m of ["where", "innerJoin", "leftJoin", "orderBy", "limit"]) {
      self[m] = () => self;
    }
    self["then"] = (resolve: (v: unknown) => unknown) => Promise.resolve(rows()).then(resolve);
    return self;
  };
  return {
    db: {
      select: () => ({
        from: (t: { __t: string }) =>
          chain(() => (t.__t === "slackInstallations" ? installationRows : channelRows)),
      }),
    },
  };
});

const ORG = "org1";

/** One live installation whose token decrypts to `xoxb-1`. */
function installation(overrides: Record<string, unknown> = {}) {
  return {
    id: "inst1",
    organizationId: ORG,
    teamId: "T1",
    teamName: "Acme",
    encryptedBotToken: "ENC",
    botTokenIv: "IV",
    deletedAt: null,
    ...overrides,
  };
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
  installationRows = [];
  channelRows = [];
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

describe("sendSlackToOrg", () => {
  const alert = { title: "Disk full", body: "node-1 at 98%" };

  it("is a no-op when the server has no Slack app", async () => {
    delete process.env["SLACK_CLIENT_ID"];
    const { sendSlackToOrg } = await import("../slack");
    expect(await sendSlackToOrg(ORG, "workflowPages", alert)).toEqual({
      attempted: 0,
      succeeded: 0,
      failed: 0,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("is a no-op when no channel opted into the trigger", async () => {
    installationRows = [installation()];
    channelRows = [];
    const { sendSlackToOrg } = await import("../slack");
    expect(await sendSlackToOrg(ORG, "budgetAlerts", alert)).toEqual({
      attempted: 0,
      succeeded: 0,
      failed: 0,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("posts to every opted-in channel", async () => {
    installationRows = [installation()];
    channelRows = [
      { channelId: "C1", channelName: "alerts", installationId: "inst1" },
      { channelId: "C2", channelName: "oncall", installationId: "inst1" },
    ];
    const { sendSlackToOrg } = await import("../slack");
    const result = await sendSlackToOrg(ORG, "syncIncidents", alert);
    expect(result).toEqual({ attempted: 2, succeeded: 2, failed: 0 });
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://slack.com/api/chat.postMessage");
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer xoxb-1");
    expect(JSON.parse(init.body as string).channel).toBe("C1");
  });

  it("counts an ok:false envelope as a failure", async () => {
    installationRows = [installation()];
    channelRows = [{ channelId: "C1", channelName: "secret", installationId: "inst1" }];
    fetchSpy.mockImplementation(async () => jsonResponse({ ok: false, error: "not_in_channel" }));
    const { sendSlackToOrg } = await import("../slack");
    expect(await sendSlackToOrg(ORG, "workflowPages", alert)).toEqual({
      attempted: 1,
      succeeded: 0,
      failed: 1,
    });
  });

  it("escapes mrkdwn delimiters in alert text", async () => {
    installationRows = [installation()];
    channelRows = [{ channelId: "C1", channelName: "alerts", installationId: "inst1" }];
    const { sendSlackToOrg } = await import("../slack");
    await sendSlackToOrg(ORG, "workflowPages", {
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
    installationRows = [installation()];
    channelRows = [{ channelId: "C1", channelName: "alerts", installationId: "inst1" }];
    fetchSpy.mockRejectedValue(new Error("network down"));
    const { sendSlackToOrg } = await import("../slack");
    expect(await sendSlackToOrg(ORG, "workflowPages", alert)).toEqual({
      attempted: 1,
      succeeded: 0,
      failed: 1,
    });
  });

  it("skips a channel whose install has been disconnected", async () => {
    // resolveTargets joins on a live install, but the token map is built
    // separately — a row that survives the join without a token must not post.
    installationRows = [];
    channelRows = [{ channelId: "C1", channelName: "alerts", installationId: "gone" }];
    const { sendSlackToOrg } = await import("../slack");
    expect(await sendSlackToOrg(ORG, "workflowPages", alert)).toEqual({
      attempted: 1,
      succeeded: 0,
      failed: 1,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("listSlackChannels", () => {
  beforeEach(() => {
    installationRows = [installation()];
  });

  /**
   * Slack's reference says `conversations.list` accepts `application/json`, but
   * it does not honour arguments sent that way: it answers `ok: true` with
   * `types` defaulted to public channels only. That is invisible from the
   * response — the bug looked like a missing scope or a missing invite — so the
   * encoding is pinned here rather than left to whoever edits slackCall next.
   */
  it("asks for private channels form-encoded, because JSON is silently ignored", async () => {
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
    channelRows = [
      { channelId: "C1", channelName: "alerts", installationId: "inst1", workflowPages: true },
    ];
    const { sendSlackToOrg } = await import("../slack");
    await sendSlackToOrg(ORG, "workflowPages", { title: "t", body: "b" });
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
describe("sendSlackToOrgTracked", () => {
  it("renders buttons and returns the posted message refs", async () => {
    installationRows = [installation()];
    channelRows = [{ channelId: "C1", channelName: "approvals", installationId: "inst1" }];
    fetchSpy.mockImplementation(async () =>
      jsonResponse({ ok: true, ts: "1722700000.000100", channel: "C1" }),
    );
    const { sendSlackToOrgTracked } = await import("../slack");
    const result = await sendSlackToOrgTracked(ORG, "workflowPages", {
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

  it("keeps sendSlackToOrg's shape for untracked callers", async () => {
    installationRows = [installation()];
    channelRows = [{ channelId: "C1", channelName: "alerts", installationId: "inst1" }];
    const { sendSlackToOrg } = await import("../slack");
    expect(await sendSlackToOrg(ORG, "workflowPages", { title: "t", body: "b" })).toEqual({
      attempted: 1,
      succeeded: 1,
      failed: 0,
    });
  });
});
