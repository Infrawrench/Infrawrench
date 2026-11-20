import { existsSync, readFileSync, statSync } from "node:fs";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { configPath } from "../config";
import {
  KEY,
  ORG,
  OTHER_ORG,
  cleanupTempDirs,
  mockApi,
  runCli,
  tempDir,
  whoamiRoute,
  type MockApi,
} from "./harness";

let api: MockApi;

afterEach(async () => api?.close());
afterAll(cleanupTempDirs);

const stored = (home: string) => configPath({ env: {}, home, platform: process.platform });

describe("infraenv login", () => {
  it("checks the key with whoami and stores it with its organization, mode 0600", async () => {
    api = await mockApi({ "GET /api/v1/whoami": whoamiRoute() });
    const home = tempDir();
    const result = await runCli(["login", "--key-stdin"], {
      cwd: home,
      home,
      env: { INFRAWRENCH_BASE_URL: api.url },
      stdin: `${KEY}\n`,
    });
    expect(result.err).toBe("");
    expect(result.code).toBe(0);
    expect(result.out).toContain(`Logged in to organization ${ORG}.`);
    expect(api.requests[0]!.authorization).toBe(`Bearer ${KEY}`);
    const path = stored(home);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      apiKey: KEY,
      orgId: ORG,
      baseUrl: api.url,
    });

    // The stored key is now what whoami and pull use.
    const who = await runCli(["whoami", "--json"], { cwd: home, home });
    expect(who.code).toBe(0);
    expect(JSON.parse(who.out)).toMatchObject({
      source: path,
      baseUrl: api.url,
      organizationId: ORG,
      principal: "api_key",
    });

    const out = await runCli(["logout"], { cwd: home, home });
    expect(out.out).toContain("Removed the stored key");
    expect(existsSync(path)).toBe(false);
    expect((await runCli(["logout"], { cwd: home, home })).out).toBe("No stored key.\n");
  });

  it("refuses something that is not an API key, and a key for another organization", async () => {
    api = await mockApi({ "GET /api/v1/whoami": whoamiRoute() });
    const home = tempDir();
    const notKey = await runCli(["login", "--key-stdin"], {
      cwd: home,
      home,
      env: { INFRAWRENCH_BASE_URL: api.url },
      stdin: "hunter2",
    });
    expect(notKey.code).toBe(1);
    expect(notKey.err).toContain("they start with iwk_");

    const wrongOrg = await runCli(["login", "--key-stdin", "--org", OTHER_ORG], {
      cwd: home,
      home,
      env: { INFRAWRENCH_BASE_URL: api.url },
      stdin: KEY,
    });
    expect(wrongOrg.code).toBe(1);
    expect(wrongOrg.err).toContain(`That key belongs to organization ${ORG}, not ${OTHER_ORG}.`);
    expect(existsSync(stored(home))).toBe(false);
  });

  it("does not store a key the server rejects", async () => {
    api = await mockApi({
      "GET /api/v1/whoami": () => ({ status: 401, body: { error: "Unauthorized" } }),
    });
    const home = tempDir();
    const result = await runCli(["login", "--key-stdin"], {
      cwd: home,
      home,
      env: { INFRAWRENCH_BASE_URL: api.url },
      stdin: KEY,
    });
    expect(result.code).toBe(1);
    expect(result.err).toMatch(/did not accept the API key/);
    expect(existsSync(stored(home))).toBe(false);
  });

  it("asks for --key-stdin when there is no terminal", async () => {
    const home = tempDir();
    const result = await runCli(["login"], { cwd: home, home });
    expect(result.code).toBe(1);
    expect(result.err).toContain("infraenv login --key-stdin");
  });
});

describe("infraenv whoami", () => {
  it("names INFRAWRENCH_API_KEY as the source when it is set", async () => {
    api = await mockApi({ "GET /api/v1/whoami": whoamiRoute() });
    const home = tempDir();
    const result = await runCli(["whoami"], {
      cwd: home,
      home,
      env: { INFRAWRENCH_API_KEY: KEY, INFRAWRENCH_BASE_URL: api.url },
    });
    expect(result.code).toBe(0);
    expect(result.out).toContain(`organization  ${ORG}`);
    expect(result.out).toContain("from          INFRAWRENCH_API_KEY");
  });

  it("fails without a key", async () => {
    const home = tempDir();
    const result = await runCli(["whoami"], { cwd: home, home });
    expect(result.code).toBe(1);
    expect(result.err).toContain("infraenv login");
  });
});
