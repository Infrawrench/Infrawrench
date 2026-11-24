import { beforeEach, describe, expect, it, vi } from "vitest";

// The database, GitHub and the proxy are stubbed: these tests pin what a
// finished run shows on GitHub. `claimed: false` is another caller (the
// poller, or a runner's notice) having recorded the run's end first.
const dbState = vi.hoisted(() => ({ claimed: true }));
vi.mock("../../db/client.js", () => {
  const where = () =>
    Object.assign(Promise.resolve(), {
      returning: async () => (dbState.claimed ? [{ id: "run-1" }] : []),
    });
  const set = () => ({ where });
  return { db: { update: () => ({ set }) } };
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

const { checkName, fitCheckText } =
  await vi.importActual<typeof import("../checks.js")>("../checks.js");
const { syncRun, jobsOf, checkSummary, CACHED_REASON } = await import("../runs");
const { CiProxyError } = await vi.importActual<typeof import("../proxy.js")>("../proxy.js");
const { githubInstallationFetch } = await import("../../github/app.js");

const row = (event: "push" | "pull-request") =>
  ({
    id: "run-1",
    organizationId: "org-1",
    installationId: 7,
    repoFullName: "acme/web",
    ownerKey: "github.com-acme",
    sha: "a".repeat(40),
    event,
    status: "running",
    proxyRunId: "ci-1.abc",
    checkRunId: null,
    fromFork: false,
    createdAt: new Date(),
    startedAt: new Date(),
    updatedAt: new Date(),
  }) as unknown as Parameters<typeof syncRun>[0];

const finished = (jobs: Array<{ id: string; status: string; cached?: boolean }>) => ({
  id: "ci-1.abc",
  state: "finished",
  result: {
    passed: true,
    usage: { vcpu_seconds: 1, memory_gib_seconds: 1 },
    pipelines: jobs.length
      ? [
          {
            file: "p.yml",
            outcome: "ran",
            report: {
              pipeline: "P",
              jobs: jobs.map((j) => ({ ...j, name: j.id, duration_ms: 1 })),
            },
          },
        ]
      : [],
  },
});

beforeEach(() => {
  vi.clearAllMocks();
  dbState.claimed = true;
});

describe("CI checks on GitHub", () => {
  it("names a check after its event, so a push run cannot hide a pull request's", () => {
    expect(checkName("push")).toBe("Infrawrench CI / push");
    expect(checkName("pull-request")).toBe("Infrawrench CI / pull request");
    // Its own name: a nightly never stands in for a push's required check.
    expect(checkName("schedule")).toBe("Infrawrench CI / schedule");
  });

  it("shows nothing on GitHub for a push that matched no pipeline", async () => {
    // A workflow that does not run posts nothing; a green or grey check for
    // every branch push nothing runs on is noise beside the pull request's.
    mockProxyJson.mockResolvedValue(finished([]));
    await syncRun(row("push"));
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it("closes a push's check as skipped when it already has one", async () => {
    mockProxyJson.mockResolvedValue(finished([]));
    await syncRun({ ...row("push"), checkRunId: 99 });
    expect(mockUpsert).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ conclusion: "skipped", title: "No pipeline runs on this push" }),
    );
  });

  it("concludes a pull request that matched no pipeline as skipped, not passed", async () => {
    mockProxyJson.mockResolvedValue(finished([]));
    await syncRun(row("pull-request"));
    expect(mockUpsert).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        conclusion: "skipped",
        title: "No pipeline runs on this pull request",
      }),
    );
  });

  it("shows the runner's error for a run it could not start, not an empty pipeline", async () => {
    const why = "fetch abc: git: No credentials were returned";
    mockProxyJson.mockResolvedValueOnce({ id: "ci-1.abc", state: "error", error: why });
    await syncRun(row("push"));
    const update = mockUpsert.mock.calls.at(-1)?.[1];
    expect(update).toMatchObject({
      status: "completed",
      conclusion: "failure",
      title: "Could not run",
      summary: why,
    });
    expect(String(update?.summary)).not.toContain("No pipeline ran");
  });

  it("still passes a run whose jobs passed", async () => {
    mockProxyJson.mockResolvedValue(finished([{ id: "prettier", status: "passed" }]));
    await syncRun(row("pull-request"));
    expect(mockUpsert).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ conclusion: "success", title: "1 job(s) passed" }),
    );
  });

  it("says which jobs the task cache stood in for", async () => {
    mockProxyJson.mockResolvedValue(
      finished([
        { id: "build", status: "passed", cached: true },
        { id: "check", status: "passed" },
      ]),
    );
    await syncRun(row("push"));
    expect(mockUpsert).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        conclusion: "success",
        title: "2 job(s) passed, 1 from the task cache",
        summary: expect.stringMatching(/\| cached \|/),
      }),
    );
  });

  it("passes on what each job waited for, so the run can be drawn as a graph", () => {
    const run = finished([{ id: "build", status: "passed" }]);
    const report = run.result.pipelines[0]!.report as { jobs: Record<string, unknown>[] };
    report.jobs = [
      { id: "build", name: "build", status: "passed", needs: ["prep"] },
      { id: "old", name: "old", status: "passed" },
      { id: "odd", name: "odd", status: "passed", needs: [1] },
    ];
    const jobs = jobsOf(run as never, false);
    expect(jobs.map((j) => j.needs)).toEqual([["prep"], undefined, undefined]);
  });

  it("fits a 700-job summary under GitHub's limit, failures first", () => {
    const jobs = Array.from({ length: 700 }, (_, i) => ({
      pipeline: "Test",
      id: `test[app/packages/p${i}]`,
      name: `Test @infrawrench/a-fairly-long-package-name-${i}`,
      status: (i === 650 ? "failed" : "passed") as "failed" | "passed",
      reason: i === 650 ? "exited with 1" : CACHED_REASON,
      durationMs: 1000,
    }));
    const summary = checkSummary(jobs);
    // The failure leads, and a cached job says so in a word.
    expect(summary.split("\n")[2]).toContain("a-fairly-long-package-name-650");
    expect(summary).not.toContain(CACHED_REASON);
    const fitted = fitCheckText(summary.repeat(3));
    expect(new TextEncoder().encode(fitted).length).toBeLessThanOrEqual(60_000);
    // Cut between rows, with a note of what was left out.
    expect(fitted).toMatch(/\|\n\n_…and \d+ more line\(s\)/);
    expect(fitCheckText("short")).toBe("short");
  });

  it("gives up on a run its runner no longer has, closing its unfinished job checks", async () => {
    mockProxyJson.mockRejectedValue(new CiProxyError("no such run", 404));
    const gone = {
      ...row("pull-request"),
      checkRunId: 9,
      startedAt: new Date(Date.now() - 10 * 60_000),
      jobChecks: {
        a: { id: 11, sent: "completed:1" },
        b: { id: 12, sent: "in_progress:2" },
      },
    } as unknown as Parameters<typeof syncRun>[0];
    await syncRun(gone);
    expect(mockUpsert).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        status: "completed",
        conclusion: "failure",
        summary: expect.stringContaining("runner restarted"),
      }),
    );
    // Only the job check still going is closed.
    const fetch = vi.mocked(githubInstallationFetch);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [, path, init] = fetch.mock.calls[0]!;
    expect(path).toBe("/repos/acme/web/check-runs/12");
    expect(JSON.parse(String(init?.body))).toMatchObject({
      status: "completed",
      conclusion: "cancelled",
    });
  });

  it("finishes the run's own check before its jobs' checks", async () => {
    mockProxyJson.mockResolvedValue(
      finished([
        { id: "build", status: "passed" },
        { id: "check", status: "passed" },
      ]),
    );
    const fetch = vi.mocked(githubInstallationFetch);
    await syncRun({ ...row("push"), jobChecks: {} } as Parameters<typeof syncRun>[0]);
    // A required check never waits behind a GitHub call per job.
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(mockUpsert.mock.invocationCallOrder[0]).toBeLessThan(fetch.mock.invocationCallOrder[0]!);
  });

  it("follows a running run without writing its job checks when told not to", async () => {
    const running = {
      id: "ci-1.abc",
      state: "running",
      progress: {
        pipelines: [
          { name: "P", jobs: [{ key: "build" }], states: { build: { status: "running" } } },
        ],
      },
    };
    mockProxyJson.mockResolvedValue(running);
    const fetch = vi.mocked(githubInstallationFetch);
    const going = { ...row("push"), jobChecks: {} } as Parameters<typeof syncRun>[0];
    await syncRun(going, { jobChecks: false });
    expect(fetch).not.toHaveBeenCalled();
    await syncRun(going);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it("counts a run lost from its last good read, so a long run that reports is never lost", async () => {
    const HOUR = 60 * 60_000;
    mockProxyJson.mockRejectedValue(new Error("the proxy did not answer"));
    // Three hours in (a job may run six), read a minute ago: a blip.
    await syncRun({
      ...row("push"),
      startedAt: new Date(Date.now() - 3 * HOUR),
      updatedAt: new Date(Date.now() - 60_000),
    } as Parameters<typeof syncRun>[0]);
    expect(mockUpsert).not.toHaveBeenCalled();
    // Nothing read for over two hours: lost.
    await syncRun({
      ...row("push"),
      startedAt: new Date(Date.now() - 3 * HOUR),
      updatedAt: new Date(Date.now() - 2 * HOUR - 60_000),
      jobChecks: {},
    } as Parameters<typeof syncRun>[0]);
    expect(mockUpsert).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ title: "Lost", conclusion: "failure" }),
    );
  });

  it("waits out a 404 just after the run started", async () => {
    mockProxyJson.mockRejectedValue(new CiProxyError("no such run", 404));
    expect(await syncRun(row("pull-request"))).toBe("unread");
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it("says how following a run went", async () => {
    mockProxyJson.mockResolvedValueOnce({ id: "ci-1.abc", state: "running" });
    expect(await syncRun(row("push"))).toBe("running");
    mockProxyJson.mockResolvedValueOnce(finished([{ id: "build", status: "passed" }]));
    expect(await syncRun({ ...row("push"), jobChecks: {} } as never)).toBe("ended");
    mockProxyJson.mockRejectedValueOnce(new Error("the proxy did not answer"));
    expect(await syncRun(row("push"))).toBe("unread");
    expect(await syncRun({ ...row("push"), status: "passed" } as never)).toBe("settled");
  });

  it("posts nothing for a run another caller has already ended", async () => {
    // The poller and the runner's notice read the same finished run: only
    // the one whose update ends it posts its checks.
    dbState.claimed = false;
    for (const run of [
      finished([{ id: "build", status: "passed" }]),
      finished([]),
      { id: "ci-1.abc", state: "error", error: "refused" },
    ]) {
      mockProxyJson.mockResolvedValueOnce(run);
      expect(await syncRun({ ...row("pull-request"), jobChecks: {} } as never)).toBe("settled");
    }
    expect(mockUpsert).not.toHaveBeenCalled();
    expect(vi.mocked(githubInstallationFetch)).not.toHaveBeenCalled();
  });

  it("does not end a run before its dispatcher has said on GitHub that it started", async () => {
    // A run that ends within its first moments, told by its runner's
    // notice while the dispatcher still holds its claim: ending it now
    // would let the dispatcher's "in progress" land after the result.
    mockProxyJson.mockResolvedValue(finished([{ id: "build", status: "passed" }]));
    const dispatching = {
      ...row("push"),
      jobChecks: {},
      nextAttemptAt: new Date(Date.now() + 110_000),
    } as never;
    expect(await syncRun(dispatching)).toBe("announcing");
    expect(mockUpsert).not.toHaveBeenCalled();
    // Once it has, or its claim has lapsed, the run ends as usual.
    const announced = { ...row("push"), jobChecks: {}, nextAttemptAt: new Date() } as never;
    expect(await syncRun(announced)).toBe("ended");
    expect(mockUpsert).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: "completed", conclusion: "success" }),
    );
  });
});
