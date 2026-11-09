import { describe, expect, it } from "vitest";
import { ciLiveJobKey, ciLogEvent, emptyCiLiveRun, reduceCiLog, type CiLogEvent } from "../ci-live";
import { parseSseFrames } from "../sse";

function streamOf(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({
    start(controller) {
      // Split mid-frame, as a network would.
      controller.enqueue(bytes.slice(0, 30));
      controller.enqueue(bytes.slice(30));
      controller.close();
    },
  });
}

describe("the CI live log", () => {
  it("reads the runner's frames, named and unnamed", async () => {
    const text =
      'event: pipeline-started\ndata: {"event":"pipeline-started","pipeline":"Test","jobs":[{"key":"a","name":"a","needs":[],"ids":["a"]}]}\n\n' +
      ": keep-alive\n\n" +
      'event: job-started\ndata: {"event":"job-started","job":"a","name":"a"}\n\n' +
      'event: truncated\ndata: {"after_bytes":8388608}\n\n' +
      'event: run-finished\ndata: {"id":"ci-1.x","state":"finished","passed":true,"error":null}\n\n' +
      'event: something-new\ndata: {"x":1}\n\n';
    const events: CiLogEvent[] = [];
    for await (const frame of parseSseFrames(streamOf(text))) {
      const event = ciLogEvent(frame);
      if (event) events.push(event);
    }
    expect(events.map((e) => e.event)).toEqual([
      "pipeline-started",
      "job-started",
      "truncated",
      "run-finished",
    ]);
  });

  it("follows each job through the pipeline it belongs to", () => {
    const events: CiLogEvent[] = [
      {
        event: "pipeline-started",
        pipeline: "Test",
        jobs: [
          { key: "build", name: "build", needs: [], ids: ["build"] },
          { key: "check", name: "check", needs: ["build"], ids: ["check"] },
        ],
      },
      { event: "job-started", job: "build", name: "Build" },
      { event: "output", job: "build", stream: "stdout", line: "compiling" },
      { event: "output", job: "build", stream: "stderr", line: "warning" },
      { event: "job-finished", job: "build", status: "passed", duration_ms: 1200, cached: true },
      { event: "job-started", job: "check", name: "Check" },
      { event: "pipeline-started", pipeline: "Lint", jobs: [] },
      { event: "job-started", job: "check", name: "Check (lint)" },
      { event: "job-finished", job: "check", status: "something-new", duration_ms: 5 },
      { event: "run-finished", passed: false },
    ];
    let run = emptyCiLiveRun();
    for (const event of events) run = reduceCiLog(run, event, 1000);
    const build = run.jobs[ciLiveJobKey("Test", "build")]!;
    expect(build).toMatchObject({
      status: "passed",
      durationMs: 1200,
      cached: true,
      name: "Build",
    });
    expect(build.lines).toEqual([
      { stream: "stdout", line: "compiling" },
      { stream: "stderr", line: "warning" },
    ]);
    expect(run.jobs[ciLiveJobKey("Test", "check")]).toMatchObject({
      status: "running",
      startedAt: 1000,
    });
    // A status this build does not know reads as an error, never as a pass.
    expect(run.jobs[ciLiveJobKey("Lint", "check")]?.status).toBe("error");
    expect(run.pipelines.map((p) => p.name)).toEqual(["Test", "Lint"]);
    expect(run.finished).toBe(true);
  });

  it("returns a new run for every change, so React re-renders", () => {
    const before = emptyCiLiveRun();
    const after = reduceCiLog(before, { event: "job-started", job: "a", name: "a" });
    expect(after).not.toBe(before);
    expect(before.jobs).toEqual({});
  });
});
