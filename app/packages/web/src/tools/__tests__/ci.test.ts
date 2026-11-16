import { describe, it, expect, vi, beforeEach } from "vitest";

// The permission gate's own imports reach db/client and the WorkOS client,
// which throw at import time without these. No connection is opened.
process.env["DATABASE_URL"] ??= "postgres://test:test@localhost:5432/test";
process.env["ENCRYPTION_MASTER_KEY"] ??= Buffer.alloc(32, 1).toString("base64");
process.env["WORKOS_API_KEY"] ??= "test_workos_api_key";
process.env["WORKOS_CLIENT_ID"] ??= "test_workos_client_id";

// The CI modules read Postgres and the CI proxy: stub them, they have their
// own tests. The tools are what is under test.
const ci = {
  ciStatus: vi.fn(),
  ciAccessOverview: vi.fn(),
  ciUsage: vi.fn(),
  approveRun: vi.fn(),
  cancelRun: vi.fn(),
  dispatchRun: vi.fn(async (_runId: string) => {}),
  getRun: vi.fn(),
  listRuns: vi.fn(),
  openRunLogs: vi.fn(),
  rejectRun: vi.fn(),
  retryRun: vi.fn(),
  startManualRun: vi.fn(),
  listCiRepositories: vi.fn(),
  listCiValues: vi.fn(),
};
class CiInputError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}
vi.mock("@infrawrench/server-core/ci/accounts", () => ({
  ciStatus: (...a: unknown[]) => ci.ciStatus(...a),
}));
vi.mock("@infrawrench/server-core/ci/access", () => ({
  ciAccessOverview: (...a: unknown[]) => ci.ciAccessOverview(...a),
}));
vi.mock("@infrawrench/server-core/ci/billing", () => ({
  ciUsage: (...a: unknown[]) => ci.ciUsage(...a),
}));
vi.mock("@infrawrench/server-core/ci/runs", () => ({
  CiInputError,
  approveRun: (...a: unknown[]) => ci.approveRun(...a),
  cancelRun: (...a: unknown[]) => ci.cancelRun(...a),
  dispatchRun: (runId: string) => ci.dispatchRun(runId),
  getRun: (...a: unknown[]) => ci.getRun(...a),
  listRuns: (...a: unknown[]) => ci.listRuns(...a),
  openRunLogs: (...a: unknown[]) => ci.openRunLogs(...a),
  rejectRun: (...a: unknown[]) => ci.rejectRun(...a),
  retryRun: (...a: unknown[]) => ci.retryRun(...a),
  startManualRun: (...a: unknown[]) => ci.startManualRun(...a),
}));
vi.mock("@infrawrench/server-core/ci/schedules", () => ({
  listCiRepositories: (...a: unknown[]) => ci.listCiRepositories(...a),
}));
vi.mock("@infrawrench/server-core/ci/values", () => ({
  listCiValues: (...a: unknown[]) => ci.listCiValues(...a),
}));
const mockLogAudit = vi.fn();
vi.mock("../../services/audit", () => ({ logAudit: (...a: unknown[]) => mockLogAudit(...a) }));

const mockResolvePerms = vi.fn();
vi.mock("@infrawrench/server-core/permissions", () => ({
  resolveEffectivePermissions: (...a: unknown[]) => mockResolvePerms(...a),
}));
const mockDisabledProducts = vi.fn(async (_org: string): Promise<string[]> => []);
vi.mock("@infrawrench/server-core/products/settings", () => ({
  disabledProducts: (org: string) => mockDisabledProducts(org),
}));

const { ciTools, pageLines, readLiveLog, splitLines } = await import("../ci");
const { forProduct } = await import("../products");
const { authorizeToolCall } = await import("../permissions");
const { needsApproval } = await import("../approval");

const tools = forProduct("delivery", ciTools());
const tool = (name: string) => {
  const found = tools.find((t) => t.name === name);
  if (!found) throw new Error(`no tool ${name}`);
  return found;
};
const auth = {
  userId: "u1",
  organizationId: "o1",
  email: "ada@example.com",
  source: "mcp" as const,
};
const text = (r: { content: Array<{ text: string }> }) => r.content[0]!.text;
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(text(r));

function run(overrides: Record<string, unknown> = {}) {
  return {
    id: "run-1",
    repoFullName: "acme/web",
    event: "push",
    headRef: "main",
    sha: "abc123",
    pullNumber: null,
    headRepoFullName: null,
    fromFork: false,
    actorLogin: "ada",
    status: "failed",
    statusReason: null,
    createdAt: "2026-11-16T10:00:00.000Z",
    startedAt: "2026-11-16T10:00:01.000Z",
    finishedAt: "2026-11-16T10:02:00.000Z",
    jobs: [
      {
        pipeline: "Tests",
        id: "unit",
        name: "Unit",
        status: "passed",
        reason: null,
        durationMs: 1000,
      },
      {
        pipeline: "Tests",
        id: "lint",
        name: "Lint",
        status: "failed",
        reason: "exit 1",
        durationMs: 500,
      },
    ],
    vcpuSeconds: 12,
    memoryGibSeconds: 24,
    githubUrl: "https://github.com/acme/web/commit/abc123",
    ...overrides,
  };
}

function jobOutput(overrides: Record<string, unknown> = {}) {
  return {
    pipeline: "Tests",
    id: "lint",
    name: "Lint",
    status: "failed",
    reason: "exit 1",
    durationMs: 500,
    stdout: "",
    stderr: "",
    ...overrides,
  };
}

/** A log stream that sends `frames` and then stays open, as a running run's does. */
function openLog(frames: readonly object[], opts: { close?: boolean } = {}) {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`));
      }
      if (opts.close) controller.close();
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockResolvePerms.mockResolvedValue({ permissions: ["*"], role: null });
  mockDisabledProducts.mockResolvedValue([]);
});

describe("permissions", () => {
  it("declares the permission each matching route requires", () => {
    const perms = Object.fromEntries(tools.map((t) => [t.name, t.permission]));
    expect(perms).toEqual({
      list_ci_repositories: "ci:read",
      list_ci_pipelines: "ci:read",
      list_ci_runs: "ci:read",
      get_ci_run: "ci:read",
      get_ci_job_log: "ci:read",
      start_ci_run: "ci:approve",
      retry_ci_run: "ci:approve",
      cancel_ci_run: "ci:approve",
      approve_ci_run: "ci:approve",
      reject_ci_run: "ci:approve",
      list_ci_values: "ci:write",
      get_ci_access: "ci:read",
      get_ci_usage: "ci:read",
    });
  });

  it("refuses the actions to a caller who may only read CI", async () => {
    mockResolvePerms.mockResolvedValue({ permissions: ["ci:read"], role: null });
    for (const name of ["start_ci_run", "retry_ci_run", "cancel_ci_run", "approve_ci_run"]) {
      const denied = await authorizeToolCall(tool(name), auth);
      expect(denied && text(denied), name).toBe("Missing permission: ci:approve");
    }
    const values = await authorizeToolCall(tool("list_ci_values"), auth);
    expect(values && text(values)).toBe("Missing permission: ci:write");
    expect(await authorizeToolCall(tool("list_ci_runs"), auth)).toBeNull();
    expect(await authorizeToolCall(tool("get_ci_job_log"), auth)).toBeNull();
  });

  it("refuses every CI tool to a caller without ci:read", async () => {
    mockResolvePerms.mockResolvedValue({ permissions: ["resources:read"], role: null });
    for (const t of tools) expect(await authorizeToolCall(t, auth), t.name).not.toBeNull();
  });

  it("belongs to Delivery, so turning that app off takes the tools away", async () => {
    mockDisabledProducts.mockResolvedValue(["delivery"]);
    for (const t of tools) {
      expect(t.product, t.name).toBe("delivery");
      const denied = await authorizeToolCall(t, auth);
      expect(denied && text(denied), t.name).toMatch(/Delivery app is turned off/);
    }
  });

  it("asks for approval in chat before every action, and never before a read", async () => {
    const chat = { ...auth, source: "chat" as const };
    for (const t of tools) {
      const action = t.permission === "ci:approve";
      expect(t.risk, t.name).toBe(action ? "destructive" : "read");
      expect(await needsApproval(t, {}, chat), t.name).toBe(action);
    }
  });
});

describe("list_ci_runs", () => {
  it("passes the filters through and hides runs with nothing to run unless asked", async () => {
    ci.listRuns.mockResolvedValue([run()]);
    await tool("list_ci_runs").handler(
      { repoFullName: "acme/web", branch: "main", event: "push", pullNumber: 7, status: "failed" },
      auth,
    );
    expect(ci.listRuns).toHaveBeenLastCalledWith("o1", {
      limit: 25,
      status: "failed",
      repo: "acme/web",
      branch: "main",
      event: "push",
      pullNumber: 7,
    });
    await tool("list_ci_runs").handler({}, auth);
    expect(ci.listRuns).toHaveBeenLastCalledWith("o1", { limit: 25 });
    await tool("list_ci_runs").handler({ includeSkipped: true }, auth);
    expect(ci.listRuns).toHaveBeenLastCalledWith("o1", { limit: 25, includeHidden: true });
    // Not a status: ignored rather than passed on.
    await tool("list_ci_runs").handler({ status: "exploded", event: "tag" }, auth);
    expect(ci.listRuns).toHaveBeenLastCalledWith("o1", { limit: 25 });
  });

  it("bounds the page and hands back the cursor for the next one", async () => {
    ci.listRuns.mockImplementation(async (_org: string, opts: { limit: number }) =>
      Array.from({ length: opts.limit }, (_, i) => run({ id: `run-${i}` })),
    );
    const big = parse(await tool("list_ci_runs").handler({ limit: 10_000 }, auth));
    expect(ci.listRuns).toHaveBeenLastCalledWith("o1", { limit: 100 });
    expect(big.runs).toHaveLength(100);
    expect(big.nextBefore).toBe("run-99");

    await tool("list_ci_runs").handler({ limit: 0 }, auth);
    expect(ci.listRuns).toHaveBeenLastCalledWith("o1", { limit: 1 });

    await tool("list_ci_runs").handler({ before: "run-99" }, auth);
    expect(ci.listRuns).toHaveBeenLastCalledWith("o1", { limit: 25, beforeRunId: "run-99" });

    ci.listRuns.mockResolvedValue([run()]);
    const last = parse(await tool("list_ci_runs").handler({}, auth));
    expect(last.nextBefore).toBeNull();
  });

  it("counts jobs and names the ones that failed, without listing every job", async () => {
    ci.listRuns.mockResolvedValue([run()]);
    const [entry] = parse(await tool("list_ci_runs").handler({}, auth)).runs;
    expect(entry.jobs).toBeUndefined();
    expect(entry.jobCounts).toEqual({ passed: 1, failed: 1 });
    expect(entry.failedJobs).toEqual([
      { pipeline: "Tests", id: "lint", name: "Lint", reason: "exit 1" },
    ]);
    expect(entry.vcpuSeconds).toBe(12);
  });
});

describe("get_ci_run", () => {
  it("returns the jobs without their output, counting its lines", async () => {
    ci.getRun.mockResolvedValue({
      run: run(),
      jobs: [jobOutput({ stdout: "a\nb\n", stderr: "SECRET-LOOKING\n" })],
    });
    const out = parse(await tool("get_ci_run").handler({ runId: "run-1" }, auth));
    expect(out.run.statusReason).toBeNull();
    expect(out.run.jobs).toBeUndefined();
    expect(out.jobs[0]).toMatchObject({ id: "lint", stdoutLines: 2, stderrLines: 1 });
    expect(out.jobs[0].stdout).toBeUndefined();
    expect(JSON.stringify(out)).not.toContain("SECRET-LOOKING");
    expect(out.outputAvailable).toBe(true);
  });

  it("says when a run is not the organization's", async () => {
    ci.getRun.mockRejectedValue(new CiInputError("No such run.", 404));
    const result = await tool("get_ci_run").handler({ runId: "elsewhere" }, auth);
    expect(result.isError).toBe(true);
    expect(text(result)).toBe("No such run.");
  });
});

describe("get_ci_job_log", () => {
  const many = Array.from({ length: 1500 }, (_, i) => `line ${i + 1}`).join("\n");

  it("tails both streams of a finished job's report by default", async () => {
    ci.getRun.mockResolvedValue({
      run: run(),
      jobs: [jobOutput({ stdout: `${many}\n`, stderr: "boom\n" })],
    });
    const out = parse(
      await tool("get_ci_job_log").handler({ runId: "run-1", jobId: "lint" }, auth),
    );
    expect(out.source).toBe("report");
    expect(out.stdout).toMatchObject({
      totalLines: 1500,
      fromLine: 1301,
      toLine: 1500,
      moreBefore: true,
      moreAfter: false,
    });
    expect(out.stdout.lines).toHaveLength(200);
    expect(out.stdout.lines[0]).toBe("line 1301");
    expect(out.stderr.lines).toEqual(["boom"]);
  });

  it("pages from a line, one stream, and caps the page size", async () => {
    ci.getRun.mockResolvedValue({ run: run(), jobs: [jobOutput({ stdout: many })] });
    const first = parse(
      await tool("get_ci_job_log").handler(
        { runId: "run-1", jobId: "lint", stream: "stdout", fromLine: 1, lines: 10 },
        auth,
      ),
    );
    expect(first.stderr).toBeUndefined();
    expect(first.stdout).toMatchObject({
      fromLine: 1,
      toLine: 10,
      moreBefore: false,
      moreAfter: true,
    });
    const capped = parse(
      await tool("get_ci_job_log").handler(
        { runId: "run-1", jobId: "lint", stream: "stdout", lines: 1_000_000 },
        auth,
      ),
    );
    expect(capped.stdout.lines).toHaveLength(1000);
    const past = parse(
      await tool("get_ci_job_log").handler(
        { runId: "run-1", jobId: "lint", stream: "stdout", fromLine: 9999 },
        auth,
      ),
    );
    expect(past.stdout).toMatchObject({
      totalLines: 1500,
      lines: [],
      fromLine: 0,
      moreAfter: false,
    });
  });

  it("asks for the pipeline when two pipelines share a job id, and names the jobs it has", async () => {
    ci.getRun.mockResolvedValue({
      run: run(),
      jobs: [jobOutput({ pipeline: "Tests" }), jobOutput({ pipeline: "Nightly" })],
    });
    const ambiguous = await tool("get_ci_job_log").handler({ runId: "run-1", jobId: "lint" }, auth);
    expect(ambiguous.isError).toBe(true);
    expect(text(ambiguous)).toContain("Tests, Nightly");
    const picked = parse(
      await tool("get_ci_job_log").handler(
        { runId: "run-1", jobId: "lint", pipeline: "Nightly" },
        auth,
      ),
    );
    expect(picked.pipeline).toBe("Nightly");
    const missing = await tool("get_ci_job_log").handler({ runId: "run-1", jobId: "nope" }, auth);
    expect(text(missing)).toContain("Tests / lint");
  });

  it("reads a running run's live log, masked as the runner sent it", async () => {
    ci.getRun.mockResolvedValue({ run: run({ status: "running", finishedAt: null }), jobs: null });
    ci.openRunLogs.mockImplementation(async () =>
      openLog([
        { event: "pipeline-started", pipeline: "Tests", jobs: [] },
        { event: "job-started", job: "lint", name: "Lint" },
        { event: "output", job: "lint", stream: "stdout", line: "token=***" },
        { event: "output", job: "lint", stream: "stderr", line: "warning" },
      ]),
    );
    const out = parse(
      await tool("get_ci_job_log").handler({ runId: "run-1", jobId: "lint" }, auth),
    );
    expect(ci.openRunLogs).toHaveBeenCalledWith("o1", "run-1", expect.any(AbortSignal));
    expect(out).toMatchObject({ source: "live", jobStatus: "running", pipeline: "Tests" });
    expect(out.stdout.lines).toEqual(["token=***"]);
    expect(out.stderr.lines).toEqual(["warning"]);
  });

  it("says a run that has not started has no output", async () => {
    ci.getRun.mockResolvedValue({ run: run({ status: "queued", finishedAt: null }), jobs: null });
    const result = await tool("get_ci_job_log").handler({ runId: "run-1", jobId: "lint" }, auth);
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("has not started");
    expect(ci.openRunLogs).not.toHaveBeenCalled();
  });
});

describe("readLiveLog", () => {
  const limits = { totalMs: 2000, idleMs: 50, maxBytes: 1024 * 1024 };

  it("stops when the stream goes quiet, and aborts the upstream read", async () => {
    let signal: AbortSignal | undefined;
    const out = await readLiveLog(async (s) => {
      signal = s;
      return openLog([{ event: "job-started", job: "a", name: "A" }]);
    }, limits);
    expect(out.events).toEqual([{ event: "job-started", job: "a", name: "A" }]);
    expect(out.complete).toBe(false);
    expect(signal?.aborted).toBe(true);
  });

  it("reports a stream that ended, and one cut at the byte limit", async () => {
    const ended = await readLiveLog(
      async () => openLog([{ event: "run-finished", passed: true }], { close: true }),
      limits,
    );
    expect(ended.complete).toBe(true);
    const cut = await readLiveLog(
      async () =>
        openLog(
          Array.from({ length: 50 }, () => ({
            event: "output",
            job: "a",
            stream: "stdout",
            line: "x".repeat(100),
          })),
        ),
      { ...limits, maxBytes: 500 },
    );
    expect(cut.cut).toBe(true);
  });
});

describe("pageLines and splitLines", () => {
  it("cuts a very long line", () => {
    const page = pageLines(["x".repeat(5000)], 10);
    expect(page.lines[0]).toMatch(/^x{2000}… \[3000 more characters\]$/);
  });

  it("does not count the empty line after a final newline", () => {
    expect(splitLines("")).toEqual([]);
    expect(splitLines("a\r\nb\n")).toEqual(["a", "b"]);
  });
});

describe("list_ci_values", () => {
  it("returns names only, never a value, whatever the proxy answered", async () => {
    ci.listCiValues.mockResolvedValue({
      installationId: 42,
      repo: "web",
      secrets: [{ name: "DEPLOY_TOKEN", updatedAt: "2026-11-01T00:00:00.000Z", value: "s3cr3t" }],
      variables: [{ name: "REGION", value: "eu-west-1", updatedAt: "2026-11-01T00:00:00.000Z" }],
    });
    const result = await tool("list_ci_values").handler({ installationId: 42, repo: "web" }, auth);
    expect(ci.listCiValues).toHaveBeenCalledWith("o1", 42, "web");
    expect(parse(result)).toEqual({
      installationId: 42,
      repo: "web",
      secrets: [{ name: "DEPLOY_TOKEN", updatedAt: "2026-11-01T00:00:00.000Z" }],
      variables: [{ name: "REGION", updatedAt: "2026-11-01T00:00:00.000Z" }],
    });
    expect(text(result)).not.toContain("s3cr3t");
    expect(text(result)).not.toContain("eu-west-1");
  });

  it("refuses an installation id that is not one", async () => {
    const result = await tool("list_ci_values").handler({ installationId: -1 }, auth);
    expect(result.isError).toBe(true);
    expect(ci.listCiValues).not.toHaveBeenCalled();
  });
});

describe("actions", () => {
  it("starts a manual run with its inputs, dispatches it and audits it", async () => {
    ci.startManualRun.mockResolvedValue(
      run({
        id: "run-2",
        event: "manual",
        status: "queued",
        jobs: null,
        pipelineFile: "deploy.yml",
        inputs: { env: "staging" },
      }),
    );
    const out = parse(
      await tool("start_ci_run").handler(
        {
          installationId: 42,
          repoFullName: "acme/web",
          pipelineFile: "deploy.yml",
          branch: "release",
          inputs: { env: "staging", dry: true },
        },
        auth,
      ),
    );
    expect(ci.startManualRun).toHaveBeenCalledWith("o1", "u1", "ada@example.com", {
      installationId: 42,
      repoFullName: "acme/web",
      pipelineFile: "deploy.yml",
      branch: "release",
      inputs: { env: "staging", dry: true },
    });
    expect(out.id).toBe("run-2");
    expect(ci.dispatchRun).toHaveBeenCalledWith("run-2");
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "ci.run.start",
        entityId: "run-2",
        metadata: expect.objectContaining({ inputs: { env: "staging" }, source: "mcp" }),
      }),
    );
  });

  it("passes a refusal through as the tool's error, and audits nothing", async () => {
    ci.startManualRun.mockRejectedValue(new CiInputError("acme/web has no branch nope.", 404));
    const result = await tool("start_ci_run").handler(
      { installationId: 42, repoFullName: "acme/web", pipelineFile: "deploy.yml", branch: "nope" },
      auth,
    );
    expect(text(result)).toBe("acme/web has no branch nope.");
    expect(ci.dispatchRun).not.toHaveBeenCalled();
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  it("retries, cancels, approves and rejects through the routes' functions", async () => {
    ci.retryRun.mockResolvedValue(run({ id: "run-3", status: "queued" }));
    await tool("retry_ci_run").handler({ runId: "run-1", noTaskCache: true }, auth);
    expect(ci.retryRun).toHaveBeenCalledWith("o1", "run-1", "u1", { noTaskCache: true });
    expect(ci.dispatchRun).toHaveBeenCalledWith("run-3");

    ci.cancelRun.mockResolvedValue(run({ status: "cancelled" }));
    await tool("cancel_ci_run").handler({ runId: "run-1" }, auth);
    expect(ci.cancelRun).toHaveBeenCalledWith("o1", "run-1");

    await tool("approve_ci_run").handler({ runId: "run-4" }, auth);
    expect(ci.approveRun).toHaveBeenCalledWith("o1", "run-4", "u1");
    expect(ci.dispatchRun).toHaveBeenCalledWith("run-4");

    await tool("reject_ci_run").handler({ runId: "run-5" }, auth);
    expect(ci.rejectRun).toHaveBeenCalledWith("o1", "run-5", "u1");

    expect(mockLogAudit.mock.calls.map(([entry]) => entry.action)).toEqual([
      "ci.run.retry",
      "ci.run.cancel",
      "ci.run.approve",
      "ci.run.reject",
    ]);
  });
});

describe("the read-only views", () => {
  it("lists repositories and their pipelines", async () => {
    ci.ciStatus.mockResolvedValue({
      enabled: true,
      configured: true,
      githubConfigured: true,
      planIncludesCi: true,
      accounts: [
        { installationId: 42, accountLogin: "acme", accountType: "Organization", ciEnabled: true },
      ],
    });
    const repo = {
      installationId: 42,
      repoFullName: "acme/web",
      defaultBranch: "main",
      sha: "abc",
      pipelines: [{ file: "nightly.yml", name: "Nightly", cron: ["0 3 * * *"], nextRunAt: null }],
      refreshedAt: "2026-11-16T00:00:00.000Z",
      error: null,
      manual: [{ file: "deploy.yml", name: "Deploy", inputs: [] }],
    };
    ci.listCiRepositories.mockResolvedValue([
      repo,
      { ...repo, repoFullName: "acme/api", manual: null },
    ]);
    const repos = parse(await tool("list_ci_repositories").handler({}, auth));
    expect(repos.repositories.map((r: { manualPipelines: number }) => r.manualPipelines)).toEqual([
      1, 0,
    ]);
    expect(repos.accounts[0].installationId).toBe(42);

    const pipelines = parse(
      await tool("list_ci_pipelines").handler({ repoFullName: "ACME/Web" }, auth),
    );
    expect(pipelines.repositories).toHaveLength(1);
    expect(pipelines.repositories[0].manual[0].file).toBe("deploy.yml");
    const none = await tool("list_ci_pipelines").handler({ repoFullName: "acme/none" }, auth);
    expect(none.isError).toBe(true);
  });

  it("reads access settings as the caller, and never as an agent's user row", async () => {
    ci.ciAccessOverview.mockResolvedValue({
      viewerUserId: "u1",
      connections: [],
      grants: [],
      sshKeys: [],
    });
    expect(parse(await tool("get_ci_access").handler({}, auth))).toEqual({
      connections: [],
      grants: [],
      sshKeys: [],
    });
    expect(ci.ciAccessOverview).toHaveBeenLastCalledWith("o1", "u1");
    await tool("get_ci_access").handler({}, { ...auth, agentRegistrationId: "reg-1" });
    expect(ci.ciAccessOverview).toHaveBeenLastCalledWith("o1", null);
  });

  it("reads a month's usage", async () => {
    ci.ciUsage.mockResolvedValue({ month: "2026-10", runs: 3 });
    await tool("get_ci_usage").handler({ month: "2026-10" }, auth);
    expect(ci.ciUsage).toHaveBeenCalledWith("o1", "2026-10");
  });
});
