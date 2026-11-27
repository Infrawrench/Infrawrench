import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseCiNotes } from "@infrawrench/client-core";

// No database: what a report's jobs are read as, and what a job's commands
// become before they are written. Landing them is tested against Postgres in
// the forge's `git/packages/worker/src/__tests__/db/ci-notes.test.ts`.
const touched = vi.hoisted(() => ({ count: 0 }));
vi.mock("../../db/client.js", () => ({
  db: new Proxy(
    {},
    {
      get() {
        touched.count += 1;
        throw new Error("the database is not part of this test");
      },
    },
  ),
}));

const { ciLogLineUrl, findingInputs, landCiNotes, landRunNotes, notesJobs, traceInputs } =
  await import("../git-notes");
const { jobsOf, CACHED_REASON } = await import("../runs");
import type { ProxyRun } from "../proxy";

type Report = NonNullable<
  NonNullable<NonNullable<ProxyRun["result"]>["pipelines"]>[number]["report"]
>;

const report = (jobs: Report): ProxyRun => ({
  id: "proxy-1",
  state: "finished",
  result: { passed: true, pipelines: [{ outcome: "ran", name: "lint", report: jobs }] },
});

const source = (note: { logLine: number }) => ({
  text: `line ${note.logLine}`,
  url: `https://git.example.test/run#L${note.logLine}`,
});

beforeEach(() => {
  touched.count = 0;
  vi.unstubAllEnvs();
});

describe("a report's jobs", () => {
  it("are named by the report's pipeline and the job's id, with their output", () => {
    const jobs = notesJobs(
      report({
        pipeline: "Lint and types",
        jobs: [
          { id: "eslint", status: "passed", execution: { stdout: "a\n", stderr: "b\n" } },
          { id: "tsc", status: "passed", cached: true, execution: null },
          { status: "failed", execution: { stdout: "no id" } },
        ],
      }),
    );
    expect(jobs).toEqual([
      {
        pipeline: "Lint and types",
        id: "eslint",
        status: "passed",
        cached: false,
        stdout: "a\n",
        stderr: "b\n",
      },
      {
        pipeline: "Lint and types",
        id: "tsc",
        status: "passed",
        cached: true,
        stdout: "",
        stderr: "",
      },
    ]);
  });

  it("are none for a pipeline that never ran", () => {
    expect(
      notesJobs({
        id: "p",
        state: "finished",
        result: { pipelines: [{ outcome: "invalid", file: "ci.yml", errors: ["bad"] }] },
      }),
    ).toEqual([]);
  });
});

describe("a job's commands, as what is written", () => {
  const { notes } = parseCiNotes({
    stdout: [
      "::must-fix file=src/a.ts,line=3,title=Unexpected any::first",
      "::must-fix file=src/a.ts,line=8,title=Unexpected any::second",
      "::must-fix file=src/b.ts,line=8,title=Unexpected any::another file",
      "::note::Coverage is 83%25.",
      "::doubt file=src/a.ts,line=3,title=Index::Still used?",
      "::step needs_code=false::Built.",
    ].join("\n"),
    stderr: "",
  });

  it("findings carry their place, their source and a fingerprint of their own", async () => {
    const inputs = await findingInputs("ci:lint/eslint", notes, source);
    expect(inputs).toHaveLength(4);
    expect(inputs[0]).toMatchObject({
      severity: "must_fix",
      title: "Unexpected any",
      body: "first",
      path: "src/a.ts",
      startLine: 3,
      endLine: null,
      needsCode: undefined,
      evidence: [{ kind: "ci", text: "line 1", url: "https://git.example.test/run#L1" }],
    });
    expect(inputs[3]).toMatchObject({ severity: "note", title: "Coverage is 83%.", body: "" });
    // The same title twice in one file, and once in another: three findings, not one.
    expect(new Set(inputs.map((input) => input.fingerprint)).size).toBe(4);
    // The same output gives the same fingerprints, whatever line the code moved to.
    const again = await findingInputs(
      "ci:lint/eslint",
      notes.map((note) => ({ ...note, line: note.line === null ? null : note.line + 40 })),
      source,
    );
    expect(again.map((input) => input.fingerprint)).toEqual(
      inputs.map((input) => input.fingerprint),
    );
    // Another job's are another reviewer's.
    const other = await findingInputs("ci:lint/biome", notes, source);
    expect(other[0]!.fingerprint).not.toBe(inputs[0]!.fingerprint);
  });

  it("trace entries carry the run and the line they were printed on", () => {
    expect(traceInputs("run-9", notes, source)).toEqual([
      {
        kind: "doubt",
        body: "**Index**\n\nStill used?",
        anchors: [{ path: "src/a.ts", startLine: 3, endLine: null }],
        needsCode: undefined,
        evidence: { ciRunId: "run-9", url: "https://git.example.test/run#L5" },
      },
      {
        kind: "step",
        body: "Built.",
        anchors: [],
        needsCode: false,
        evidence: { ciRunId: "run-9", url: "https://git.example.test/run#L6" },
      },
    ]);
  });
});

describe("the link to a job's log line", () => {
  it("is the run's page on the forge, at the job and the line", () => {
    vi.stubEnv("GIT_BASE_URL", "https://git.example.test/");
    expect(
      ciLogLineUrl({ id: "run 1", repoFullName: "acme/web app" }, "test/build[app/ui]", 12),
    ).toBe(
      "https://git.example.test/acme/web%20app/ci/runs/run%201?job=test%2Fbuild%5Bapp%2Fui%5D#L12",
    );
  });
});

describe("runs that have no branch page to write on", () => {
  const run = {
    id: "run-1",
    gitRepositoryId: null,
    repoFullName: "acme/web",
    event: "push" as const,
    headRef: "feature",
    sha: "a".repeat(40),
    pullNumber: null,
    fromFork: false,
    terraformRunId: null,
  };
  const job = {
    pipeline: "lint",
    id: "eslint",
    status: "passed",
    cached: false,
    stdout: "::must-fix::x\n",
    stderr: "",
  };

  it("a GitHub repository's run touches nothing", async () => {
    expect(await landCiNotes(run, [job])).toMatchObject({ skipped: "not-forge" });
    await landRunNotes(run, report({ pipeline: "lint", jobs: [] }));
    expect(touched.count).toBe(0);
  });

  it("a Terraform workspace's run touches nothing", async () => {
    expect(
      await landCiNotes({ ...run, gitRepositoryId: "repo-1", terraformRunId: "tf-1" }, [job]),
    ).toMatchObject({ skipped: "not-forge" });
    expect(touched.count).toBe(0);
  });

  it("a run in which nothing ran looks nothing up", async () => {
    expect(
      await landCiNotes({ ...run, gitRepositoryId: "repo-1" }, [{ ...job, status: "skipped" }]),
    ).toMatchObject({ skipped: null, findings: 0 });
    expect(touched.count).toBe(0);
  });

  it("a failure to write ends quietly, and logs nothing the job printed", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await landRunNotes(
      { ...run, gitRepositoryId: "repo-1" },
      report({
        pipeline: "lint",
        jobs: [
          { id: "eslint", status: "passed", execution: { stdout: "::note::hunter2-value\n" } },
        ],
      }),
    );
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain("run-1");
    expect(JSON.stringify(warn.mock.calls)).not.toContain("hunter2-value");
    warn.mockRestore();
  });
});

describe("a job's reason", () => {
  const one = (job: Record<string, unknown>) =>
    jobsOf(
      report({ pipeline: "lint", jobs: [{ id: "eslint", status: "passed", ...job }] }),
      false,
    )[0]!;

  it("says how many note commands were ignored", () => {
    expect(
      one({
        execution: {
          stdout: "::must-fix path=a.ts::typo in the parameter\n::note::fine\n",
          stderr: "::doubt line=3::no file\n",
        },
      }).reason,
    ).toBe("2 note commands ignored (2 malformed).");
  });

  it("keeps the reason it had, and adds to it", () => {
    expect(
      one({
        status: "failed",
        reason: "exit code 1",
        execution: { stdout: "::must-fix line=x::bad\n" },
      }).reason,
    ).toBe("exit code 1. 1 note command ignored (1 malformed).");
  });

  it("is untouched when every command was taken, and for a job that did not run", () => {
    expect(one({ execution: { stdout: "::note::fine\n::group::other tool\n" } }).reason).toBeNull();
    expect(one({ cached: true, execution: null }).reason).toBe(CACHED_REASON);
  });
});
