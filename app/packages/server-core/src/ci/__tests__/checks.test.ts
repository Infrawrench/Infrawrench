import { beforeEach, describe, expect, it, vi } from "vitest";

// The database, GitHub and the proxy are stubbed: these tests pin what a
// finished run shows on GitHub.
vi.mock("../../db/client.js", () => {
  const where = () => Promise.resolve();
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

beforeEach(() => vi.clearAllMocks());

describe("CI checks on GitHub", () => {
  it("names a check after its event, so a push run cannot hide a pull request's", () => {
    expect(checkName("push")).toBe("Infrawrench CI / push");
    expect(checkName("pull-request")).toBe("Infrawrench CI / pull request");
    // Its own name: a nightly never stands in for a push's required check.
    expect(checkName("schedule")).toBe("Infrawrench CI / schedule");
  });

  it("concludes a run that matched no pipeline as skipped, not passed", async () => {
    mockProxyJson.mockResolvedValue(finished([]));
    await syncRun(row("push"));
    expect(mockUpsert).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ conclusion: "skipped", title: "No pipeline runs on this push" }),
    );
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

  it("waits out a 404 just after the run started", async () => {
    mockProxyJson.mockRejectedValue(new CiProxyError("no such run", 404));
    await syncRun(row("pull-request"));
    expect(mockUpsert).not.toHaveBeenCalled();
  });
});
