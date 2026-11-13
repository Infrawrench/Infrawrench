import { describe, expect, it } from "vitest";
import type { SshHostServices } from "@infrawrench/plugin-base";

import {
  ciListTagged,
  ciPreflight,
  ciStart,
  ciStatus,
  ciTeardown,
  listScript,
  startScript,
  statusScript,
  teardownScript,
  workName,
} from "../ci-executor.js";

const JOB = "5f0c1c2e-1111-4a4a-9b9b-0123456789ab";
const tags = {
  "infrawrench-ci": "org-1",
  "infrawrench-ci-run": "run-1",
  "infrawrench-ci-job": JOB,
};
const spec = {
  kind: "host" as const,
  bootstrap: "#!/bin/sh\necho 'hi'\n",
  tags,
  name: "infrawrench-ci-build",
  maxSeconds: 1800,
};
const NAME = "job-5f0c1c2e11114a4a9b9b0123456789ab";
const handle = { id: NAME, label: `ssh build.example.test ${NAME}`, data: { name: NAME } };

/** A fake SSH service: answers each script with the test's output, recording it. No network. */
function fakeSsh(answer: (script: string) => string | Error) {
  const scripts: string[] = [];
  const ssh: SshHostServices = {
    async exec(script) {
      scripts.push(script);
      const out = answer(script);
      if (out instanceof Error) throw out;
      return out;
    },
  };
  return { ssh, scripts };
}

describe("scripts", () => {
  it("starts the job detached in its own session, under a watchdog, in its own work directory", () => {
    const script = startScript(spec);
    expect(script).toContain(`W="$R/${NAME}"`);
    expect(script).toContain('R="${HOME:-/tmp}/.infrawrench-ci"');
    expect(script).toMatch(/IWCI_WORK="\$W" HOME="\$W\/home" TMPDIR="\$W\/tmp" setsid sh -c '/);
    expect(script).toContain('iwci 1800 "$W" >');
    expect(script).toContain("kill -KILL 0");
    // The bootstrap and the tags go over as base64, never as shell text.
    expect(script).toContain(Buffer.from(spec.bootstrap).toString("base64"));
    expect(script).toContain(Buffer.from(JSON.stringify(tags)).toString("base64"));
    expect(script).not.toContain("echo 'hi'");
  });

  it("only ever touches a job's own work directory", () => {
    expect(() => statusScript("../etc")).toThrow();
    expect(() => teardownScript("job-a/../../x")).toThrow();
    expect(workName({ tags: { "infrawrench-ci-job": "../x y" }, name: "n" })).toMatch(
      /^job-[0-9a-f]{32}$/,
    );
    const teardown = teardownScript(NAME);
    expect(teardown).toContain('rm -rf -- "$W"');
    expect(teardown).toContain("IWCI_WORK=$W");
    expect(listScript()).toContain('"$R"/job-*');
  });
});

describe("ciPreflight", () => {
  it("passes on a Linux host with everything installed", async () => {
    const { ssh } = fakeSsh(() => "IWCI_OS Linux\nIWCI_WRITABLE\n");
    expect(await ciPreflight(ssh, "host")).toEqual({ ok: true, missing: [], problems: [] });
  });

  it("names what to install, and other hosts it cannot use", async () => {
    const { ssh } = fakeSsh(() => "IWCI_OS Darwin\nIWCI_NO setsid\nIWCI_NO curl\n");
    const result = await ciPreflight(ssh, "host");
    expect(result.ok).toBe(false);
    expect(result.problems).toEqual([
      "The host runs Darwin; CI jobs need a Linux host.",
      "The host has no setsid. Install util-linux (apt-get install util-linux, or apk add util-linux).",
      "The host has no curl. Install curl.",
      expect.stringMatching(/cannot write its home directory/),
    ]);
  });

  it("says so when the host offers no SSH service, or the host cannot be reached", async () => {
    expect((await ciPreflight(undefined, "host")).problems[0]).toMatch(/cannot open SSH sessions/);
    const down = fakeSsh(() => new Error("connect ETIMEDOUT"));
    expect((await ciPreflight(down.ssh, "host")).problems[0]).toMatch(/ETIMEDOUT/);
    await expect(ciPreflight(down.ssh, "vm")).rejects.toThrow(/host/);
  });
});

describe("ciStart", () => {
  it("starts the job and hands back its work directory", async () => {
    const { ssh, scripts } = fakeSsh(() => "IWCI_STARTED 4242\n");
    expect(await ciStart(ssh, "build.example.test", spec)).toEqual(handle);
    expect(scripts[0]).toBe(startScript(spec));
  });

  it("explains what stopped it", async () => {
    const run = (out: string) => ciStart(fakeSsh(() => out).ssh, "h", spec);
    await expect(run("IWCI_MISSING setsid curl\n")).rejects.toThrow(/no setsid, curl/);
    await expect(run("IWCI_TAKEN\n")).rejects.toThrow(/another job/);
    await expect(run("garbage")).rejects.toThrow(/did not start/);
    await expect(ciStart(undefined, "h", spec)).rejects.toThrow(/SSH sessions/);
    await expect(ciStart(fakeSsh(() => "").ssh, "h", { ...spec, image: "ubuntu" })).rejects.toThrow(
      /as it is/,
    );
  });
});

describe("ciStatus, ciTeardown and ciListTagged", () => {
  it("reads the job's state", async () => {
    const status = (out: string) => ciStatus(fakeSsh(() => out).ssh, handle);
    expect(await status("IWCI_STATE running\n")).toEqual({ state: "running" });
    expect(await status("IWCI_STATE stopped 0\n")).toEqual({
      state: "stopped",
      detail: "exit code 0",
    });
    expect(await status("IWCI_STATE stopped timeout\n")).toEqual({
      state: "stopped",
      detail: "timed out",
    });
    expect(await status("IWCI_STATE stopped\n")).toEqual({ state: "stopped" });
    expect(await status("IWCI_STATE gone\n")).toEqual({ state: "gone" });
    await expect(status("")).rejects.toThrow(/no state/);
  });

  it("tears down, and wants the host to confirm", async () => {
    const { ssh, scripts } = fakeSsh(() => "IWCI_REMOVED\n");
    await ciTeardown(ssh, handle);
    expect(scripts[0]).toBe(teardownScript(NAME));
    await expect(ciTeardown(fakeSsh(() => "").ssh, handle)).rejects.toThrow(/did not confirm/);
  });

  it("lists every job's work directory with its tags", async () => {
    const encoded = Buffer.from(JSON.stringify(tags)).toString("base64");
    const { ssh } = fakeSsh(
      () =>
        `IWCI_JOB ${NAME} 1 2026-11-13T10:00:00Z ${encoded}\nIWCI_JOB job-old 0 - \nIWCI_JOB ../evil 1 - x\n`,
    );
    const found = await ciListTagged(ssh, "build.example.test", "infrawrench-ci");
    expect(found).toEqual([
      { handle, tags, createdAt: "2026-11-13T10:00:00Z", live: true },
      {
        handle: {
          id: "job-old",
          label: "ssh build.example.test job-old",
          data: { name: "job-old" },
        },
        tags: { "infrawrench-ci": "" },
        live: false,
      },
    ]);
  });
});
