import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
