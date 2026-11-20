import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  DEFAULT_BASE_URL,
  chooseOrg,
  configPath,
  findCredentials,
  readStored,
  writeStored,
  type Credentials,
} from "../config";
import { cleanupTempDirs, tempDir } from "./harness";

afterAll(cleanupTempDirs);

const stored = { apiKey: "iwk_stored", orgId: "org-from-login", baseUrl: "https://iw.example" };

describe("configPath", () => {
  it("honours XDG_CONFIG_HOME, then ~/.config, and %APPDATA% on Windows", () => {
    expect(configPath({ env: { XDG_CONFIG_HOME: "/x" }, home: "/h", platform: "linux" })).toBe(
      join("/x", "infrawrench", "infraenv.json"),
    );
    expect(configPath({ env: {}, home: "/h", platform: "darwin" })).toBe(
      join("/h", ".config", "infrawrench", "infraenv.json"),
    );
    expect(configPath({ env: { APPDATA: "C:\\AppData" }, home: "/h", platform: "win32" })).toBe(
      join("C:\\AppData", "infrawrench", "infraenv.json"),
    );
  });
});

describe("stored credentials", () => {
  it("are written with mode 0600 and read back", () => {
    const path = join(tempDir(), "nested", "infraenv.json");
    writeStored(path, stored);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readStored(path)).toEqual(stored);
    expect(JSON.parse(readFileSync(path, "utf8")).apiKey).toBe("iwk_stored");
  });

  it("are absent when the file is missing", () => {
    expect(readStored(join(tempDir(), "missing.json"))).toBeNull();
  });
});

describe("findCredentials", () => {
  it("prefers INFRAWRENCH_API_KEY over the stored key, and never pairs it with the stored org", () => {
    const found = findCredentials({ INFRAWRENCH_API_KEY: " iwk_env " }, stored);
    expect(found).toEqual({
      apiKey: "iwk_env",
      source: "env",
      baseUrl: DEFAULT_BASE_URL,
      storedOrg: null,
    });
  });

  it("uses the stored key with its org and origin, INFRAWRENCH_BASE_URL winning", () => {
    expect(findCredentials({}, stored)).toEqual({
      apiKey: "iwk_stored",
      source: "stored",
      baseUrl: "https://iw.example",
      storedOrg: "org-from-login",
    });
    expect(
      findCredentials({ INFRAWRENCH_BASE_URL: "http://localhost:3000/" }, stored)?.baseUrl,
    ).toBe("http://localhost:3000");
  });

  it("is null with neither", () => {
    expect(findCredentials({}, null)).toBeNull();
  });

  it("refuses a base URL that is not http(s)", () => {
    expect(() =>
      findCredentials({ INFRAWRENCH_API_KEY: "iwk_x", INFRAWRENCH_BASE_URL: "ftp://x" }, null),
    ).toThrow(/must be http/);
  });
});

describe("chooseOrg", () => {
  const withLogin: Credentials = {
    apiKey: "iwk_stored",
    source: "stored",
    baseUrl: DEFAULT_BASE_URL,
    storedOrg: "loginorg",
  };
  const fromEnvKey: Credentials = { ...withLogin, source: "env", storedOrg: null };

  it("takes --org, then INFRAWRENCH_ORG_ID, then the file, then the login", () => {
    const env = { INFRAWRENCH_ORG_ID: "envorg1", INFRAWRENCH_ORG: "envorg2" };
    expect(chooseOrg({ flag: "flagorg", env, file: "fileorg", credentials: withLogin })).toEqual({
      id: "flagorg",
      from: "flag",
    });
    expect(chooseOrg({ flag: null, env, file: "fileorg", credentials: withLogin })).toEqual({
      id: "envorg1",
      from: "env",
    });
    expect(
      chooseOrg({
        flag: null,
        env: { INFRAWRENCH_ORG: "envorg2" },
        file: "x",
        credentials: withLogin,
      }),
    ).toEqual({ id: "envorg2", from: "env" });
    expect(chooseOrg({ flag: null, env: {}, file: "fileorg", credentials: withLogin })).toEqual({
      id: "fileorg",
      from: "file",
    });
    expect(chooseOrg({ flag: null, env: {}, file: undefined, credentials: withLogin })).toEqual({
      id: "loginorg",
      from: "login",
    });
  });

  it("leaves the key's own organization to whoami when nothing names one", () => {
    expect(chooseOrg({ flag: null, env: {}, file: "", credentials: fromEnvKey })).toBeNull();
  });

  it("reads an organization out of a pasted web address", () => {
    expect(
      chooseOrg({
        flag: "https://app.infrawrench.com/org/abcd-1234/settings/api-keys",
        env: {},
        file: null,
        credentials: fromEnvKey,
      }),
    ).toEqual({ id: "abcd-1234", from: "flag" });
    expect(() =>
      chooseOrg({ flag: "not an org!", env: {}, file: null, credentials: fromEnvKey }),
    ).toThrow(/must be an organization id/);
  });
});
