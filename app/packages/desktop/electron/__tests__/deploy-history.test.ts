import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { LocalDeployRun } from "../../src/lib/deploy-history-types";

const h = vi.hoisted(() => ({ userData: "" }));

vi.mock("electron", () => ({
  app: { getPath: (name: string) => (name === "userData" ? h.userData : h.userData) },
}));

import { recordLocalDeploy, readLocalDeploys } from "../deploy-history";

function run(overrides: Partial<LocalDeployRun> = {}): LocalDeployRun {
  return {
    id: "run-1",
    startedAt: "2026-07-29T10:00:00.000Z",
    env: "production",
    repo: "owner/name",
    branch: "main",
    gitSha: "abcdef1234567890",
    dirty: false,
    image: "registry.example.com/app:abcdef1",
    status: "success",
    stage: "deploy",
    durationMs: 42_000,
    dir: "/home/dev/app",
    notes: [],
    error: null,
    orgId: null,
    ...overrides,
  };
}

describe("deploy-history", () => {
  beforeEach(() => {
    h.userData = fs.mkdtempSync(path.join(os.tmpdir(), "iw-deploy-history-"));
  });

  afterEach(() => {
    fs.rmSync(h.userData, { recursive: true, force: true });
  });

  it("returns nothing before anything has been deployed", () => {
    expect(readLocalDeploys()).toEqual([]);
  });

  it("reads runs back newest first", () => {
    recordLocalDeploy(run({ id: "older" }));
    recordLocalDeploy(run({ id: "newer" }));
    expect(readLocalDeploys().map((r) => r.id)).toEqual(["newer", "older"]);
  });

  // A machine that lost power mid-append leaves a half-written line. Losing
  // that entry is acceptable; losing the whole history to it is not.
  it("skips a truncated line rather than failing the whole read", () => {
    recordLocalDeploy(run({ id: "intact" }));
    fs.appendFileSync(path.join(h.userData, "deploy-history.jsonl"), '{"id":"trunc"\n', "utf8");
    expect(readLocalDeploys().map((r) => r.id)).toEqual(["intact"]);
  });

  it("keeps the file from growing without bound", () => {
    for (let i = 0; i < 450; i++) recordLocalDeploy(run({ id: `run-${i}` }));
    const lines = fs
      .readFileSync(path.join(h.userData, "deploy-history.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean);
    expect(lines.length).toBeLessThanOrEqual(400);
    // Trimming keeps the newest, which is what the panel shows first.
    expect(readLocalDeploys()[0]?.id).toBe("run-449");
  });

  it("never throws out of a deploy when the history cannot be written", () => {
    h.userData = "/proc/definitely-not-writable";
    expect(() => recordLocalDeploy(run())).not.toThrow();
  });
});
