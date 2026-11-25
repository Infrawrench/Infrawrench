import { describe, expect, it } from "vitest";
import { jobKey, parseSse, pickJob, reduceFrames, runFromReport, type SseFrame } from "../live";

const frame = (event: string, data: unknown): string =>
  `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

describe("parseSse", () => {
  it("reads complete frames and keeps the one still arriving", () => {
    const text =
      frame("job-started", { job: "fmt" }) + 'event: output\ndata: {"job":"fmt","line":"hal';
    const { frames, rest } = parseSse(text);
    expect(frames).toEqual([{ event: "job-started", data: { job: "fmt" } }]);
    expect(rest).toBe('event: output\ndata: {"job":"fmt","line":"hal');
    expect(parseSse(`${rest}f"}\n\n`).frames).toEqual([
      { event: "output", data: { job: "fmt", line: "half" } },
    ]);
  });

  it("skips comments, takes CRLF, and joins data lines", () => {
    const { frames } = parseSse(
      ": keep-alive\r\n\r\nevent: note\r\ndata: one\r\ndata: two\r\n\r\n",
    );
    expect(frames).toEqual([{ event: "note", data: "one\ntwo" }]);
  });

  it("keeps data that is not JSON as text and names an unnamed frame message", () => {
    expect(parseSse("data: hello\n\n").frames).toEqual([{ event: "message", data: "hello" }]);
  });
});

const PLAN: SseFrame = {
  event: "pipeline-started",
  data: {
    event: "pipeline-started",
    pipeline: "terraform",
    jobs: [
      { key: "fmt", name: "fmt", needs: [], ids: ["fmt"] },
      { key: "validate", name: "validate", needs: [], ids: ["validate-a", "validate-b"] },
      { key: "lint", name: "lint", needs: ["fmt"], ids: ["lint"] },
    ],
  },
};
const event = (name: string, data: Record<string, unknown>): SseFrame => ({
  event: name,
  data: { event: name, ...data },
});

describe("reduceFrames", () => {
  it("lists planned jobs as pending before anything runs", () => {
    const run = reduceFrames([PLAN]);
    expect(run.jobs.map((job) => [job.id, job.status])).toEqual([
      ["fmt", "pending"],
      ["validate-a", "pending"],
      ["validate-b", "pending"],
      ["lint", "pending"],
    ]);
    expect(run.jobs[3]!.needs).toEqual(["fmt"]);
    expect(run.finished).toBe(false);
  });

  it("follows a job from start to finish with what it printed", () => {
    const run = reduceFrames([
      PLAN,
      event("job-started", { job: "fmt", name: "fmt" }),
      event("output", { job: "fmt", stream: "stdout", line: "checking" }),
      event("output", { job: "fmt", stream: "stderr", line: "1 file is not formatted" }),
      event("job-finished", { job: "fmt", status: "failed", duration_ms: 6000 }),
      event("job-started", { job: "validate-a", name: "validate (staging)" }),
    ]);
    expect(run.jobs[0]).toMatchObject({
      status: "failed",
      durationMs: 6000,
      lines: [
        { stream: "stdout", line: "checking" },
        { stream: "stderr", line: "1 file is not formatted" },
      ],
    });
    expect(run.jobs[1]).toMatchObject({ status: "running", name: "validate (staging)" });
  });

  it("keeps the jobs of two pipelines apart when they share an id", () => {
    const run = reduceFrames([
      event("pipeline-started", {
        pipeline: "a",
        jobs: [{ key: "test", name: "test", needs: [], ids: ["test"] }],
      }),
      event("job-finished", { job: "test", status: "passed", duration_ms: 1 }),
      event("pipeline-started", {
        pipeline: "b",
        jobs: [{ key: "test", name: "test", needs: [], ids: ["test"] }],
      }),
      event("job-started", { job: "test", name: "test" }),
    ]);
    expect(run.jobs.map((job) => [jobKey(job), job.status])).toEqual([
      ["a/test", "passed"],
      ["b/test", "running"],
    ]);
  });

  it("skips frames it does not know, and reads the event name from the frame when the data has none", () => {
    const run = reduceFrames([
      PLAN,
      { event: "heartbeat", data: { at: 1 } },
      { event: "job-started", data: { job: "fmt", name: "fmt" } },
      { event: "output", data: "not an object" },
      { event: "truncated", data: { after_bytes: 10 } },
    ]);
    expect(run.jobs[0]!.status).toBe("running");
    expect(run.truncated).toBe(true);
  });

  it("marks what never finished as cancelled once the run has ended", () => {
    const run = reduceFrames([
      PLAN,
      event("job-started", { job: "fmt", name: "fmt" }),
      { event: "run-finished", data: { passed: false, error: null } },
    ]);
    expect(run.finished).toBe(true);
    expect(run.jobs.every((job) => job.status === "cancelled")).toBe(true);
  });

  it("reads a status it does not know as an error", () => {
    const run = reduceFrames([
      PLAN,
      event("job-finished", { job: "fmt", status: "exploded", duration_ms: 1 }),
    ]);
    expect(run.jobs[0]!.status).toBe("error");
  });
});

describe("runFromReport and pickJob", () => {
  const run = runFromReport([
    {
      pipeline: "terraform",
      id: "fmt",
      name: "fmt",
      status: "passed",
      reason: null,
      durationMs: 5000,
      stdout: "one\ntwo\n",
      stderr: "",
    },
    {
      pipeline: "terraform",
      id: "validate",
      name: "validate",
      status: "failed",
      reason: "exit code 1",
      durationMs: 9000,
      needs: ["fmt"],
      stdout: "init\n",
      stderr: "Error: nope",
    },
  ]);

  it("turns a report into lines, output before errors", () => {
    expect(run.finished).toBe(true);
    expect(run.jobs[0]!.lines).toEqual([
      { stream: "stdout", line: "one" },
      { stream: "stdout", line: "two" },
    ]);
    expect(run.jobs[1]!.lines).toEqual([
      { stream: "stdout", line: "init" },
      { stream: "stderr", line: "Error: nope" },
    ]);
    expect(run.jobs[1]!.needs).toEqual(["fmt"]);
  });

  it("picks the job asked for, else a failed one, else the first", () => {
    expect(pickJob(run, "terraform/fmt")?.id).toBe("fmt");
    expect(pickJob(run, undefined)?.id).toBe("validate");
    expect(pickJob(run, "terraform/gone")?.id).toBe("validate");
    expect(pickJob({ ...run, jobs: [run.jobs[0]!] }, undefined)?.id).toBe("fmt");
    expect(pickJob({ ...run, jobs: [] }, undefined)).toBeNull();
  });
});
