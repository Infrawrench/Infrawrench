import { describe, expect, it } from "vitest";
import { runUsage, type ProxyRun } from "../proxy";

// A run split across two runners, as the runner that has it reports it
// (ci-runner README, "Split runs"): `web` ran there, `desktop` on the
// runner that helped, each for 100 s at 4 GiB and a quarter of a vCPU.
const split: ProxyRun = {
  id: "ci-1.0123456789abcdef0123456789abcdef",
  state: "finished",
  result: {
    passed: true,
    usage: { vcpu_seconds: 50, memory_gib_seconds: 800 },
    pipelines: [
      {
        file: "test.yml",
        outcome: "ran",
        report: {
          pipeline: "Test",
          jobs: [
            { id: "test[web]", status: "passed", duration_ms: 100_000, memory_mib: 4096 },
            {
              id: "test[desktop]",
              status: "passed",
              duration_ms: 100_000,
              memory_mib: 4096,
              remote: "ci-2",
            },
            { id: "build", status: "passed", duration_ms: 3, cached: true },
          ],
        },
      },
    ],
  },
};

describe("billing a split CI run", () => {
  it("bills the jobs another runner ran with the run, once", () => {
    const billed = runUsage(split);
    // The runner's totals are the bill, and they hold both jobs: what each
    // job that ran comes to on its own adds up to them, the remote one
    // included.
    const ran = (split.result?.pipelines?.[0]?.report?.jobs ?? []).filter((j) => !j.cached);
    const seconds = (ms?: number) => (ms ?? 0) / 1000;
    expect(billed.vcpuSeconds).toBe(ran.reduce((n, j) => n + seconds(j.duration_ms) / 4, 0));
    expect(billed.memoryGibSeconds).toBe(
      ran.reduce((n, j) => n + (seconds(j.duration_ms) * (j.memory_mib ?? 0)) / 1024, 0),
    );
    expect(ran.some((j) => j.remote === "ci-2")).toBe(true);
    expect(billed).toEqual({ vcpuSeconds: 50, memoryGibSeconds: 800 });
  });

  it("bills nothing for a run that reports no usage", () => {
    expect(runUsage({ id: "x", state: "failed" })).toEqual({ vcpuSeconds: 0, memoryGibSeconds: 0 });
  });
});
