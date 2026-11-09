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

const { checkName } = await vi.importActual<typeof import("../checks.js")>("../checks.js");
const { syncRun, jobsOf } = await import("../runs");

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
        summary: expect.stringContaining("Cached: nothing it reads changed"),
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
});
