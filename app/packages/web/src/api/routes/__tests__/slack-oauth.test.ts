import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";

/**
 * The Slack install round trip: `install-url` -> `start` -> Slack -> `callback`.
 *
 * What is pinned is the browser binding. A signed state alone used to be
 * enough for the public callback, so an install link forwarded to another
 * company's Slack admin attached their workspace to the sender's org. Now the
 * state expires, `start` only lets the user it was minted for through (and is
 * the only thing that sets the nonce cookie), and the callback requires that
 * cookie and consumes it.
 *
 * The state crypto is the real server-core code; only the Slack token exchange
 * and the DB write are stubbed.
 */

vi.hoisted(() => {
  process.env["DATABASE_URL"] ??= "postgres://test:test@127.0.0.1:1/test";
  process.env["SLACK_CLIENT_ID"] = "cid";
  process.env["SLACK_CLIENT_SECRET"] = "csecret";
  process.env["APP_URL"] = "https://app.example";
});

const exchangeSlackCode = vi.fn();
const recordSlackInstall = vi.fn();
vi.mock("@infrawrench/server-core/slack", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@infrawrench/server-core/slack")>()),
  exchangeSlackCode: (...a: unknown[]) => exchangeSlackCode(...a),
  recordSlackInstall: (...a: unknown[]) => recordSlackInstall(...a),
}));
vi.mock("@/db/client", () => ({ db: {} }));
vi.mock("@/db/schema", () => ({ slackChannels: {}, slackInstallations: {} }));

let sessionUserId: string | null = "user-1";
vi.mock("@/api/auth-middleware", () => ({
  sessionMiddleware: async (
    c: { set: (k: string, v: unknown) => void; json: (b: unknown, s: number) => Response },
    next: () => Promise<void>,
  ) => {
    if (!sessionUserId) return c.json({ error: "Unauthorized" }, 401);
    c.set("session", { userId: sessionUserId, email: "user@example.com" });
    return next();
  },
}));

const { signSlackState, SLACK_STATE_TTL_MS } = await import("@infrawrench/server-core/slack");
const { slackRoutes, slackOauthRoute } = await import("@/api/routes/slack");
const { buildTestApp } = await import("./test-utils");

const oauthApp = new Hono().route("/api", slackOauthRoute);

/** `install-url` as user-1 in org-1; returns the state it minted. */
async function mintState(): Promise<string> {
  const res = await buildTestApp(slackRoutes).request("/install-url");
  expect(res.status).toBe(200);
  const { url } = (await res.json()) as { url: string };
  const parsed = new URL(url);
  expect(`${parsed.origin}${parsed.pathname}`).toBe("https://app.example/api/slack/oauth/start");
  return parsed.searchParams.get("state") ?? "";
}

/** Visit `start` with a signed-in browser; returns the nonce cookie it set. */
async function start(state: string): Promise<{ res: Response; cookie: string | null }> {
  const res = await oauthApp.request(`/api/slack/oauth/start?state=${encodeURIComponent(state)}`, {
    headers: { cookie: "wos-session=sealed" },
  });
  const set = res.headers.get("set-cookie") ?? "";
  const match = /iw_slack_oauth=([^;]+)/.exec(set);
  return { res, cookie: match ? match[1]! : null };
}

function callback(state: string, cookie?: string) {
  return oauthApp.request(
    `/api/slack/oauth/callback?code=c0de&state=${encodeURIComponent(state)}`,
    cookie ? { headers: { cookie: `iw_slack_oauth=${cookie}` } } : undefined,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  sessionUserId = "user-1";
  exchangeSlackCode.mockResolvedValue({ teamId: "T1", teamName: "Acme" });
  recordSlackInstall.mockResolvedValue(undefined);
});

describe("Slack install round trip", () => {
  it("installs when the starting browser finishes the flow", async () => {
    const state = await mintState();
    const { res, cookie } = await start(state);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toMatch(/^https:\/\/slack\.com\/oauth\/v2\/authorize\?/);
    const set = res.headers.get("set-cookie") ?? "";
    expect(set).toMatch(/HttpOnly/i);
    expect(set).toMatch(/Secure/i);
    expect(set).toMatch(/SameSite=Lax/i);
    expect(set).toMatch(/Path=\/api\/slack\/oauth/);
    expect(cookie).toBeTruthy();

    const done = await callback(state, cookie!);
    expect(done.headers.get("location")).toBe(
      "https://app.example/org/org-1/settings/paging?slack=connected",
    );
    expect(recordSlackInstall).toHaveBeenCalledWith("org-1", "user-1", expect.anything());
    // The nonce is consumed.
    expect(done.headers.get("set-cookie")).toMatch(/iw_slack_oauth=;.*Max-Age=0/i);
  });

  it("refuses a callback without the nonce cookie (link finished in another browser)", async () => {
    const state = await mintState();
    const res = await callback(state);
    expect(res.headers.get("location")).toBe("https://app.example/?slack=error");
    expect(exchangeSlackCode).not.toHaveBeenCalled();
    expect(recordSlackInstall).not.toHaveBeenCalled();
  });

  it("refuses a callback whose cookie holds a different install's nonce", async () => {
    const state = await mintState();
    const other = await start(await mintState());
    const res = await callback(state, other.cookie!);
    expect(res.headers.get("location")).toBe("https://app.example/?slack=error");
    expect(recordSlackInstall).not.toHaveBeenCalled();
  });

  it("refuses an expired state even with the right cookie", async () => {
    const state = await mintState();
    const { cookie } = await start(state);
    vi.useFakeTimers({ now: Date.now() + SLACK_STATE_TTL_MS + 1000 });
    try {
      const res = await callback(state, cookie!);
      expect(res.headers.get("location")).toBe("https://app.example/?slack=error");
    } finally {
      vi.useRealTimers();
    }
    expect(exchangeSlackCode).not.toHaveBeenCalled();
  });

  it("refuses a replay once the cookie has been consumed", async () => {
    const state = await mintState();
    const { cookie } = await start(state);
    const first = await callback(state, cookie!);
    expect(first.headers.get("location")).toMatch(/slack=connected$/);
    // The browser drops the cookie on the first callback's Max-Age=0, so a
    // second hit with the same state arrives without it.
    const replay = await callback(state);
    expect(replay.headers.get("location")).toBe("https://app.example/?slack=error");
    expect(recordSlackInstall).toHaveBeenCalledTimes(1);
  });

  it("start refuses a signed-in user other than the one the state was minted for", async () => {
    const state = await mintState();
    sessionUserId = "victim";
    const { res, cookie } = await start(state);
    expect(res.headers.get("location")).toBe("https://app.example/?slack=error");
    expect(cookie).toBeNull();
  });

  it("start bounces a signed-out browser through sign-in back to itself", async () => {
    const state = await mintState();
    const res = await oauthApp.request(`/api/slack/oauth/start?state=${encodeURIComponent(state)}`);
    const location = new URL(res.headers.get("location") ?? "", "https://app.example");
    expect(location.pathname).toBe("/api/auth/sign-in");
    expect(location.searchParams.get("return_to")).toBe(
      `/api/slack/oauth/start?state=${encodeURIComponent(state)}`,
    );
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("start refuses an expired state", async () => {
    const state = signSlackState("org-1", "user-1", "n", Date.now() - SLACK_STATE_TTL_MS - 1);
    const { res, cookie } = await start(state);
    expect(res.headers.get("location")).toBe("https://app.example/?slack=error");
    expect(cookie).toBeNull();
  });
});
