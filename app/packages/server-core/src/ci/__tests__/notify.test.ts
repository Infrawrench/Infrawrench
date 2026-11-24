import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A runner's notice that a run changed (`notify.ts`, `acceptRunNotice`):
// the database, GitHub and the proxy are stubbed.
const dbState = vi.hoisted(() => ({
  row: null as Record<string, unknown> | null,
  claimed: true,
  selects: 0,
}));
vi.mock("../../db/client.js", () => {
  const where = () =>
    Object.assign(Promise.resolve(), {
      returning: async () => (dbState.claimed ? [{ id: "run-1" }] : []),
      limit: async () => {
        dbState.selects++;
        return dbState.row ? [dbState.row] : [];
      },
    });
  return {
    db: {
      update: () => ({ set: () => ({ where }) }),
      select: () => ({ from: () => ({ where }) }),
    },
  };
});
vi.mock("../../github/app.js", () => ({
  getInstallationToken: vi.fn(),
  githubInstallationFetch: vi.fn(async () => new Response(JSON.stringify({ id: 1 }))),
}));
const mockUpsert = vi.fn();
vi.mock("../checks.js", async (orig) => ({
  ...(await orig<typeof import("../checks.js")>()),
  upsertCheck: (...a: unknown[]) => mockUpsert(...a),
}));
const mockProxyJson = vi.fn();
vi.mock("../proxy.js", async (orig) => ({
  ...(await orig<typeof import("../proxy.js")>()),
  proxyJson: (...a: unknown[]) => mockProxyJson(...a),
}));

const { CI_NOTIFY_PATH, noticeTarget, noticeToken, noticeTokenValid, withNotify } =
  await import("../notify");
const { acceptRunNotice, CiNoticeError, refusesNotify } = await import("../runs");

const RUN = "4a0e3c52-6c1f-4f5e-9d0c-2b8f6f1d7a10";
/** A fixed test key, not a real secret. */
const PROXY_KEY = "proxy-test-key-not-a-real-secret";

const running = () => ({
  id: RUN,
  organizationId: "org-1",
  installationId: 7,
  repoFullName: "acme/web",
  ownerKey: "github.com-acme",
  sha: "a".repeat(40),
  event: "push",
  status: "running",
  proxyRunId: "ci-2.abc",
  checkRunId: 5,
  jobChecks: {},
  fromFork: false,
  createdAt: new Date(),
  startedAt: new Date(),
  updatedAt: new Date(),
  nextAttemptAt: new Date(),
});

const finished = {
  id: "ci-2.abc",
  state: "finished",
  result: {
    passed: true,
    usage: { vcpu_seconds: 1, memory_gib_seconds: 1 },
    pipelines: [
      {
        file: "p.yml",
        outcome: "ran",
        report: { pipeline: "P", jobs: [{ id: "build", name: "build", status: "passed" }] },
      },
    ],
  },
};

async function refusal(promise: Promise<unknown>): Promise<number | null> {
  try {
    await promise;
    return null;
  } catch (err) {
    if (err instanceof CiNoticeError) return err.status;
    throw err;
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("CI_PROXY_KEY", PROXY_KEY);
  vi.stubEnv("APP_URL", "https://app.example/");
  dbState.row = running();
  dbState.claimed = true;
  dbState.selects = 0;
});
afterEach(() => vi.unstubAllEnvs());

describe("where a run's notices go", () => {
  it("is the run's own route, with a token that is the run's alone", () => {
    const target = noticeTarget(RUN);
    expect(target?.url).toBe(`https://app.example${CI_NOTIFY_PATH}/${RUN}`);
    expect(target?.token).toMatch(/^[0-9a-f]{64}$/);
    expect(noticeTokenValid(RUN, target!.token)).toBe(true);
    // Not another run's, nor under another key.
    expect(noticeTokenValid("5b1f4d63-7d2a-4a6f-8e1d-3c9a7a2e8b21", target!.token)).toBe(false);
    vi.stubEnv("CI_PROXY_KEY", "another-test-key-not-a-real-secret");
    expect(noticeTokenValid(RUN, target!.token)).toBe(false);
    for (const bad of ["", "zz", target!.token.toUpperCase(), `${target!.token}00`]) {
      expect(noticeTokenValid(RUN, bad)).toBe(false);
    }
  });

  it("is left out without an https APP_URL or the proxy key, and the run is polled", () => {
    vi.stubEnv("APP_URL", "http://localhost:3000");
    const body: Record<string, unknown> = {};
    expect(withNotify(body, RUN)).toBe(false);
    expect(body).toEqual({});
    vi.stubEnv("APP_URL", "https://app.example");
    vi.stubEnv("CI_PROXY_KEY", "");
    expect(noticeToken(RUN)).toBeNull();
    expect(noticeTokenValid(RUN, "0".repeat(64))).toBe(false);
    expect(withNotify(body, RUN)).toBe(false);
    vi.stubEnv("CI_PROXY_KEY", PROXY_KEY);
    expect(withNotify(body, RUN)).toBe(true);
    expect(body["notify"]).toEqual(noticeTarget(RUN));
  });

  it("is sent again without `notify` only when a runner refused it for that field", async () => {
    const refused = (text: string, status = 400) => new Response(text, { status });
    expect(
      await refusesNotify(
        refused('{"error":"body: unknown field `notify`, expected one of `repo`, `sha`"}'),
      ),
    ).toBe(true);
    expect(await refusesNotify(refused('{"error":"give `sha`, `branch`, or both"}'))).toBe(false);
    expect(await refusesNotify(refused("unknown field `notify`", 429))).toBe(false);
    expect(await refusesNotify(new Response('{"id":"ci-2.abc"}', { status: 202 }))).toBe(false);
  });
});

describe("a runner's notice", () => {
  it("ends a finished run and posts its check at once", async () => {
    mockProxyJson.mockResolvedValue(finished);
    expect(await acceptRunNotice(RUN, noticeToken(RUN)!)).toBe("ended");
    expect(mockProxyJson).toHaveBeenCalledWith("/v1/runs/ci-2.abc?owner=github.com-acme");
    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ id: RUN }),
      expect.objectContaining({ status: "completed", conclusion: "success" }),
    );
  });

  it("follows a run that is still going, job checks included", async () => {
    mockProxyJson.mockResolvedValue({
      id: "ci-2.abc",
      state: "running",
      progress: {
        pipelines: [
          { name: "P", jobs: [{ key: "build" }], states: { build: { status: "running" } } },
        ],
      },
    });
    const { githubInstallationFetch } = await import("../../github/app.js");
    expect(await acceptRunNotice(RUN, noticeToken(RUN)!)).toBe("running");
    expect(vi.mocked(githubInstallationFetch)).toHaveBeenCalledTimes(1);
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it("is refused without the run's token, before anything is read", async () => {
    expect(await refusal(acceptRunNotice(RUN, ""))).toBe(401);
    expect(await refusal(acceptRunNotice(RUN, "0".repeat(64)))).toBe(401);
    expect(dbState.selects).toBe(0);
    expect(mockProxyJson).not.toHaveBeenCalled();
  });

  it("asks to be sent again while the run is not recorded as started, its start is not on GitHub, or the proxy cannot be read", async () => {
    const token = noticeToken(RUN)!;
    dbState.row = { ...running(), status: "queued", proxyRunId: null };
    expect(await refusal(acceptRunNotice(RUN, token))).toBe(409);
    expect(mockProxyJson).not.toHaveBeenCalled();
    dbState.row = { ...running(), nextAttemptAt: new Date(Date.now() + 110_000) };
    mockProxyJson.mockResolvedValue(finished);
    expect(await refusal(acceptRunNotice(RUN, token))).toBe(409);
    expect(mockUpsert).not.toHaveBeenCalled();
    dbState.row = running();
    mockProxyJson.mockRejectedValue(new Error("the proxy did not answer"));
    expect(await refusal(acceptRunNotice(RUN, token))).toBe(503);
  });

  it("is a no-op for a run already ended, by the poller or an earlier notice", async () => {
    const token = noticeToken(RUN)!;
    dbState.row = { ...running(), status: "passed" };
    expect(await acceptRunNotice(RUN, token)).toBe("settled");
    expect(mockProxyJson).not.toHaveBeenCalled();
    dbState.row = running();
    dbState.claimed = false;
    mockProxyJson.mockResolvedValue(finished);
    expect(await acceptRunNotice(RUN, token)).toBe("settled");
    expect(mockUpsert).not.toHaveBeenCalled();
    dbState.row = null;
    expect(await refusal(acceptRunNotice(RUN, token))).toBe(404);
  });
});
