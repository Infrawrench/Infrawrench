import { beforeEach, describe, expect, it, vi } from "vitest";

// GitHub and the database are stubbed: these tests pin what each job's
// check says, and that a poll only calls GitHub for what changed.
const mockFetch = vi.fn();
vi.mock("../../github/app.js", () => ({
  githubInstallationFetch: (...a: unknown[]) => mockFetch(...a),
}));
const mockSet = vi.fn();
vi.mock("../../db/client.js", () => ({
  db: { update: () => ({ set: (v: unknown) => (mockSet(v), { where: () => Promise.resolve() }) }) },
}));

const {
  groupsFromJobs,
  groupsFromProgress,
  jobCheckKey,
  jobCheckName,
  jobCheckState,
  syncJobChecks,
} = await import("../job-checks");

const progress = (states: Record<string, { status: string; duration_ms?: number }>) => ({
  pipelines: [
    {
      name: "Test",
      jobs: [
        { key: "prep", name: "Prepare", ids: ["prep"] },
        { key: "build[a]", name: "Library a", ids: ["build[a]"] },
        { key: "build[b]", name: "Library b", ids: ["build[b]"] },
        { key: "lint", name: "Lint", ids: null },
      ],
      states,
    },
  ],
});

const target = () => ({
  id: "run-1",
  organizationId: "org-1",
  installationId: 7,
  repoFullName: "acme/web",
  sha: "a".repeat(40),
  event: "pull-request" as const,
  jobChecks: {} as Record<string, { id: number; sent: string }>,
});

beforeEach(() => {
  vi.clearAllMocks();
  let next = 100;
  mockFetch.mockImplementation(async () => new Response(JSON.stringify({ id: next++ })));
});

describe("a check per job", () => {
  it("groups a packages: job's packages into one check, named after the pipeline and event", () => {
    const groups = groupsFromProgress(progress({ prep: { status: "passed", duration_ms: 1500 } }));
    expect(groups.map((g) => [g.key, g.name, g.entries.length])).toEqual([
      ["prep", "Prepare", 1],
      ["build", "build", 2],
      ["lint", "Lint", 1],
    ]);
    expect(jobCheckName(groups[1]!, "pull-request")).toBe("Test / build (pull request)");
    expect(jobCheckName(groups[0]!, "push")).toBe("Test / Prepare (push)");
    expect(jobCheckName(groups[0]!, "schedule")).toBe("Test / Prepare (schedule)");
  });

  it("says waiting, going, or how it finished", () => {
    const groups = groupsFromProgress(
      progress({
        prep: { status: "passed", duration_ms: 1500 },
        "build[a]": { status: "passed", duration_ms: 4000 },
        "build[b]": { status: "running" },
      }),
    );
    expect(jobCheckState(groups[0]!)).toMatchObject({
      status: "completed",
      conclusion: "success",
      title: "Passed in 2s",
    });
    expect(jobCheckState(groups[1]!)).toMatchObject({
      status: "in_progress",
      title: "1 of 2 passed, 1 running",
    });
    expect(jobCheckState(groups[2]!)).toMatchObject({ status: "queued", title: "Waiting" });
    const failed = groupsFromJobs(
      [
        {
          pipeline: "Test",
          id: "build[a]",
          name: "a",
          status: "passed",
          reason: null,
          durationMs: 1,
        },
        {
          pipeline: "Test",
          id: "build[b]",
          name: "b",
          status: "failed",
          reason: "exited with 1",
          durationMs: 1,
        },
      ],
      "Cached: x",
    );
    expect(jobCheckState(failed[0]!)).toMatchObject({ status: "completed", conclusion: "failure" });
  });

  it("concludes a cancelled job's check as cancelled, and a failure over it as a failure", () => {
    const job = (id: string, status: "passed" | "failed" | "cancelled") => ({
      pipeline: "Test",
      id,
      name: id,
      status,
      reason: status === "cancelled" ? "cancelled" : null,
      durationMs: 1,
    });
    const [only] = groupsFromJobs([job("unit", "cancelled")], "Cached: x");
    expect(jobCheckState(only!)).toMatchObject({
      status: "completed",
      conclusion: "cancelled",
      title: "Cancelled",
    });
    const [mixed] = groupsFromJobs(
      [job("build[a]", "passed"), job("build[b]", "cancelled")],
      "Cached: x",
    );
    expect(jobCheckState(mixed!)).toMatchObject({
      conclusion: "cancelled",
      title: "1 of 2 passed, 1 cancelled",
    });
    const [failed] = groupsFromJobs(
      [job("build[a]", "failed"), job("build[b]", "cancelled")],
      "Cached: x",
    );
    expect(jobCheckState(failed!)).toMatchObject({ conclusion: "failure" });
  });

  it("creates each check once and updates only what changed", async () => {
    const run = target();
    await syncJobChecks(run, groupsFromProgress(progress({ prep: { status: "running" } })));
    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(
      mockFetch.mock.calls.every(
        ([, path, init]) => path === "/repos/acme/web/check-runs" && init.method === "POST",
      ),
    ).toBe(true);
    const created = JSON.parse(mockFetch.mock.calls[0]![2].body);
    expect(created).toMatchObject({
      name: "Test / Prepare (pull request)",
      status: "in_progress",
      head_sha: run.sha,
    });
    expect(mockSet).toHaveBeenCalledTimes(1);

    // The same poll again: nothing to send.
    mockFetch.mockClear();
    await syncJobChecks(run, groupsFromProgress(progress({ prep: { status: "running" } })));
    expect(mockFetch).not.toHaveBeenCalled();

    // prep finished: one PATCH, to its own check.
    await syncJobChecks(
      run,
      groupsFromProgress(progress({ prep: { status: "passed", duration_ms: 1000 } })),
    );
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [, path, init] = mockFetch.mock.calls[0]!;
    expect(path).toBe(
      `/repos/acme/web/check-runs/${run.jobChecks[jobCheckKey("Test", "prep")]!.id}`,
    );
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body)).toMatchObject({ status: "completed", conclusion: "success" });
  });

  it("keeps checks under keys Postgres will store", async () => {
    // jsonb refuses \u0000, which the keys once joined their halves with:
    // every save failed, every poll created the checks again, and a run's
    // own check was never finished.
    await syncJobChecks(target(), groupsFromProgress(progress({})));
    const saved = JSON.stringify(mockSet.mock.calls[0]![0]);
    expect(saved).not.toContain("\\u0000");
    expect(jobCheckKey("Test", "prep")).not.toBe(jobCheckKey("Test/prep", ""));
  });

  it("does not throw when the checks cannot be kept", async () => {
    mockSet.mockImplementationOnce(() => {
      throw new Error("unsupported Unicode escape sequence");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const run = target();
    await expect(syncJobChecks(run, groupsFromProgress(progress({})))).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("keeps going when GitHub refuses one check", async () => {
    mockFetch.mockResolvedValueOnce(new Response("", { status: 403 }));
    const run = target();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await syncJobChecks(run, groupsFromProgress(progress({})));
    expect(Object.keys(run.jobChecks)).toHaveLength(2);
    warn.mockRestore();
  });
});
