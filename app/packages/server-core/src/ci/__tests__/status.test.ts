import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const githubFetch = vi.fn(async () => new Response(JSON.stringify({ id: 4242 }), { status: 201 }));
const kept: Array<Record<string, unknown>> = [];

vi.mock("../../github/app.js", () => ({ githubInstallationFetch: githubFetch }));
vi.mock("../../db/client.js", () => ({
  db: {
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: async () => {
          kept.push(values);
        },
      }),
    }),
  },
}));

const { upsertCheck } = await import("../checks");
const { abandonJobChecks, syncJobChecks } = await import("../job-checks");
const { commitStatusState, setGitStatusWriter } = await import("../status");
type GitCommitStatus = import("../status").GitCommitStatus;
type JobGroup = import("../job-checks").JobGroup;

const A = "a".repeat(40);
const written: GitCommitStatus[] = [];

const gitRun = () => ({
  id: "run-1",
  event: "push" as const,
  organizationId: "org-1",
  installationId: 0,
  gitRepositoryId: "repo-1" as string | null,
  repoFullName: "acme/web",
  sha: A,
  checkRunId: null as number | null,
  jobChecks: {} as Record<string, { id: number; sent: string; context?: string }>,
});

const group = (status: "running" | "passed" | "failed", name = "build"): JobGroup => ({
  pipeline: "Test",
  key: name,
  name,
  entries: [{ name, status, durationMs: 1200, cached: false }],
});

beforeEach(() => {
  written.length = 0;
  kept.length = 0;
  githubFetch.mockClear();
  process.env["APP_URL"] = "https://app.example.test";
  setGitStatusWriter(async (status) => {
    written.push(status);
  });
});

afterEach(() => {
  setGitStatusWriter(null);
  delete process.env["APP_URL"];
});

describe("commitStatusState", () => {
  it("is pending until the run has finished", () => {
    expect(commitStatusState("queued", undefined)).toBe("pending");
    expect(commitStatusState("in_progress", undefined)).toBe("pending");
  });

  it("maps a finished check's conclusion", () => {
    expect(commitStatusState("completed", "success")).toBe("success");
    expect(commitStatusState("completed", "failure")).toBe("failure");
    // A skipped check satisfies a required one, so a skipped status must too.
    expect(commitStatusState("completed", "skipped")).toBe("success");
    // Not run, or stopped: did not finish, which is not "the code is wrong".
    expect(commitStatusState("completed", "cancelled")).toBe("error");
    expect(commitStatusState("completed", "neutral")).toBe("error");
    expect(commitStatusState("completed", undefined)).toBe("error");
  });

  it("keeps a fork that waits for a maintainer pending: it has not run", () => {
    expect(commitStatusState("completed", "action_required")).toBe("pending");
  });
});

describe("a run on git.infrawrench.com", () => {
  it("gets a commit status under the check's name, linking to the run's page", async () => {
    await upsertCheck(gitRun(), { status: "in_progress", title: "Running", summary: "Running." });
    expect(written).toEqual([
      {
        repositoryId: "repo-1",
        sha: A,
        context: "Infrawrench CI / push",
        state: "pending",
        description: "Running",
        targetUrl: "https://app.example.test/org/org-1/ci/run-1",
        ciRunId: "run-1",
      },
    ]);
    expect(githubFetch).not.toHaveBeenCalled();
  });

  it("names a pull request's status apart from the push's", async () => {
    await upsertCheck(
      { ...gitRun(), event: "pull-request" },
      { status: "completed", conclusion: "success", title: "3 job(s) passed", summary: "" },
    );
    expect(written[0]).toMatchObject({
      context: "Infrawrench CI / pull request",
      state: "success",
      description: "3 job(s) passed",
    });
  });

  it("writes a failure as a failure", async () => {
    await upsertCheck(gitRun(), {
      status: "completed",
      conclusion: "failure",
      title: "1 of 3 job(s) failed",
      summary: "a table",
    });
    expect(written[0]).toMatchObject({ state: "failure", description: "1 of 3 job(s) failed" });
  });

  it("keeps a description to one short line", async () => {
    await upsertCheck(gitRun(), {
      status: "completed",
      conclusion: "failure",
      title: `first line\nsecond ${"x".repeat(300)}`,
      summary: "",
    });
    const description = written[0]!.description;
    expect(description.length).toBeLessThanOrEqual(140);
    expect(description).not.toContain("\n");
    expect(description.startsWith("first line second")).toBe(true);
  });

  it("has no link on a server without APP_URL", async () => {
    delete process.env["APP_URL"];
    await upsertCheck(gitRun(), { status: "queued", title: "Queued", summary: "" });
    expect(written[0]?.targetUrl).toBeNull();
  });

  it("goes on when the status cannot be written", async () => {
    setGitStatusWriter(async () => {
      throw new Error("the database is away");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(
      upsertCheck(gitRun(), { status: "queued", title: "Queued", summary: "" }),
    ).resolves.toBeUndefined();
    warn.mockRestore();
  });

  it("gets a status per job, written again only when the job's state changes", async () => {
    const run = gitRun();
    await syncJobChecks(run, [group("running")]);
    await syncJobChecks(run, [group("running")]);
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({
      context: "Test / build (push)",
      state: "pending",
      description: "Running",
    });
    await syncJobChecks(run, [group("passed"), group("failed", "lint")]);
    expect(written.slice(1).map((s) => [s.context, s.state])).toEqual([
      ["Test / build (push)", "success"],
      ["Test / lint (push)", "failure"],
    ]);
    // What was sent is kept with the run, as a GitHub run's checks are.
    expect(kept.at(-1)).toHaveProperty("jobChecks");
    expect(githubFetch).not.toHaveBeenCalled();
  });

  it("closes a lost run's unfinished jobs, and leaves the finished ones", async () => {
    const run = gitRun();
    await syncJobChecks(run, [group("running"), group("passed", "lint")]);
    written.length = 0;
    await abandonJobChecks(run, "The runner stopped reporting on this run.");
    expect(written).toEqual([
      expect.objectContaining({
        context: "Test / build (push)",
        state: "error",
        description: "The runner stopped reporting on this run.",
      }),
    ]);
  });
});

describe("a run on GitHub", () => {
  it("still gets a check run, and no commit status", async () => {
    await upsertCheck(
      { ...gitRun(), gitRepositoryId: null, installationId: 7 },
      { status: "in_progress", title: "Running", summary: "Running." },
    );
    expect(written).toEqual([]);
    expect(githubFetch).toHaveBeenCalledTimes(1);
    const [installation, path] = githubFetch.mock.calls[0] as unknown as [number, string];
    expect(installation).toBe(7);
    expect(path).toBe("/repos/acme/web/check-runs");
  });

  it("still gets a check per job", async () => {
    const run = { ...gitRun(), gitRepositoryId: null, installationId: 7 };
    await syncJobChecks(run, [group("running")]);
    expect(written).toEqual([]);
    expect(githubFetch).toHaveBeenCalledTimes(1);
  });
});
