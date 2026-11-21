import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GENERATED_DOTENV_MARKER, type CloudFetch } from "@infrawrench/client-core";
import type { Client } from "../lib/client";
import {
  loadInfraenvReport,
  locateInfraenv,
  planDotenvPull,
  pullDotenv,
  writeSecretFile,
} from "../lib/infraenv";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "infraenv-raycast-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function client(org: (orgId: string, p: string, init?: RequestInit) => Promise<unknown>): Client {
  return {
    api: { org } as unknown as CloudFetch,
    orgId: "o",
    cloudUrl: "https://x.test",
    openIn: "web",
  };
}

describe("locateInfraenv", () => {
  it("takes the file, the folder's file, or the one beside another file", async () => {
    const file = path.join(dir, ".infraenv");
    writeFileSync(file, "A = 1\n");
    writeFileSync(path.join(dir, "package.json"), "{}");
    expect(await locateInfraenv(file)).toBe(file);
    expect(await locateInfraenv(dir)).toBe(file);
    expect(await locateInfraenv(path.join(dir, "package.json"))).toBe(file);
    const named = path.join(dir, "web.infraenv");
    writeFileSync(named, "");
    expect(await locateInfraenv(named)).toBe(named);
  });

  it("answers null when there is none", async () => {
    mkdirSync(path.join(dir, "empty"));
    expect(await locateInfraenv(path.join(dir, "empty"))).toBeNull();
    expect(await locateInfraenv(path.join(dir, "missing"))).toBeNull();
  });
});

describe("loadInfraenvReport", () => {
  it("keeps the source when the references cannot be checked", async () => {
    const file = path.join(dir, ".infraenv");
    writeFileSync(file, 'A = secret("X")\n');
    const report = await loadInfraenvReport(file, () => {
      throw new Error("The Organization preference should be…");
    });
    expect(report.source).toContain("secret");
    expect(report.describe).toBeNull();
    expect(report.failure).toMatch(/Organization/);
  });

  it("describes the file", async () => {
    const file = path.join(dir, ".infraenv");
    writeFileSync(file, "A = 1\n");
    const org = vi.fn(async () => ({ problems: [], environments: [], resources: [], secrets: [] }));
    const report = await loadInfraenvReport(file, () => client(org));
    expect(org).toHaveBeenCalledWith("o", "/env-files/describe", expect.anything());
    expect(report.failure).toBeNull();
  });
});

describe("pulling", () => {
  it("refuses a file with syntax problems", async () => {
    await expect(planDotenvPull(path.join(dir, ".infraenv"), "1BAD = x\n")).rejects.toThrow(
      /line 1/,
    );
  });

  it("writes beside the file, per its output setting, after asking about a hand-written one", async () => {
    const file = path.join(dir, ".infraenv");
    const source = "[infrawrench]\noutput = .env.local\n[env]\nA = 1\n";
    const fresh = await planDotenvPull(file, source);
    expect(fresh).toEqual({ target: path.join(dir, ".env.local"), needsConfirmation: false });

    writeFileSync(fresh.target, "HAND=written\n");
    expect((await planDotenvPull(file, source)).needsConfirmation).toBe(true);
    writeFileSync(fresh.target, `${GENERATED_DOTENV_MARKER}\nA=0\n`);
    expect((await planDotenvPull(file, source)).needsConfirmation).toBe(false);

    const org = vi.fn(async (_o: string, p: string, init?: RequestInit) => {
      expect(p).toBe("/env-files/resolve");
      expect(JSON.parse(String(init?.body))).toEqual({
        source,
        environment: "production",
        sourceName: ".infraenv",
      });
      return {
        environment: "production",
        values: [{ key: "A", value: "1" }],
        problems: [{ line: 5, key: "B", message: "No organization secret named B" }],
        dotenv: `${GENERATED_DOTENV_MARKER}\nA=1\n`,
      };
    });
    const result = await pullDotenv(client(org), file, source, "production", fresh);
    expect(result.count).toBe(1);
    expect(result.problems).toHaveLength(1);
    expect(readFileSync(fresh.target, "utf8")).toBe(`${GENERATED_DOTENV_MARKER}\nA=1\n`);
  });

  it("refuses an output that is the file itself", async () => {
    await expect(
      planDotenvPull(path.join(dir, ".infraenv"), "[infrawrench]\noutput = .infraenv\n"),
    ).rejects.toThrow(/itself/);
  });

  it.skipIf(process.platform === "win32")("writes the .env owner-only", async () => {
    const target = path.join(dir, "nested", ".env");
    await writeSecretFile(target, "A=1\n");
    expect(statSync(target).mode & 0o777).toBe(0o600);
  });
});
