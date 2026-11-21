// The standalone CLI (`electron/cli/edition.ts`, `scripts/build-cli.mjs`):
// what it refuses and leaves out, the Node stand-in for `electron`, and the
// built bundle itself, run on plain Node.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  desktopOnlyCommand,
  LOCAL_NEEDS_DESKTOP,
  setStandaloneCliForTesting,
} from "../cli/edition";
import { DESKTOP_ONLY_COMMANDS } from "../cli/effect/commands";
import {
  DESKTOP_FOOTER,
  DESKTOP_ONLY_HELP,
  HELP,
  rootHelp,
  STANDALONE_REWORDED,
} from "../cli/help";
import * as shim from "../cli/standalone/electron";
import { run, serveRoutes, useCliCapture } from "./cli-harness";

vi.mock("electron", () => ({
  app: { getPath: () => "/tmp", getVersion: () => "9.9.9" },
  shell: { openExternal: vi.fn() },
  safeStorage: { isEncryptionAvailable: () => false },
}));

vi.mock("../cloud-tokens", () => ({
  getAccessToken: vi.fn(async () => null),
  forceRefreshAccessToken: vi.fn(async () => null),
  fetchCloudOrgs: vi.fn(async () => []),
  getAuthStatus: vi.fn(async () => ({ authenticated: false })),
}));

vi.mock("../cli/context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../cli/context")>()),
  listLocalAccounts: vi.fn(async () => [{ id: "loc_1", pluginId: "aws", displayName: "Local" }]),
}));

describe("the standalone edition", () => {
  const captured = useCliCapture();
  beforeEach(() => setStandaloneCliForTesting(true));
  afterEach(() => setStandaloneCliForTesting(false));

  it("refuses --local with a usage error", async () => {
    serveRoutes(captured, {});
    expect(await run("accounts", "--local")).toBe(2);
    expect(captured.stderr).toContain(LOCAL_NEEDS_DESKTOP);
  });

  it("answers a desktop-only command by name", async () => {
    for (const name of DESKTOP_ONLY_COMMANDS) {
      captured.stderr = "";
      expect(await run(name)).toBe(2);
      expect(captured.stderr).toContain(desktopOnlyCommand(name));
    }
  });

  it("lists no local workspace, and says to sign in when that leaves nothing", async () => {
    serveRoutes(captured, {});
    expect(await run("accounts")).toBe(1);
    expect(captured.stdout).not.toContain("Local");
    expect(captured.stderr).toContain("infrawrench login");
    expect(captured.stderr).not.toContain("desktop app");
  });

  it("drops the desktop-only entries from the root help", () => {
    const help = rootHelp();
    for (const entry of DESKTOP_ONLY_HELP) expect(help).not.toContain(entry);
    expect(help).not.toContain(DESKTOP_FOOTER);
    expect(help).not.toMatch(/\bapps\b.*:/);
    expect(help).toContain("standalone CLI");
  });
});

describe("the desktop edition", () => {
  const captured = useCliCapture();

  it("keeps --local and the local scope", async () => {
    serveRoutes(captured, {});
    expect(await run("accounts")).toBe(0);
    expect(captured.stdout).toContain("Local");
  });

  it("prints the whole root help", () => {
    expect(rootHelp()).toBe(HELP);
  });

  // A reworded entry would otherwise silently stay in the standalone help.
  it("still has every entry the standalone help removes or rewords", () => {
    for (const entry of DESKTOP_ONLY_HELP) expect(HELP).toContain(entry);
    for (const [desktop] of STANDALONE_REWORDED) expect(HELP).toContain(desktop);
    expect(HELP).toContain(DESKTOP_FOOTER);
  });
});

describe("the electron stand-in", () => {
  it("keeps the session in a per-user directory of its own", () => {
    expect(shim.configDir({ INFRAWRENCH_CONFIG_DIR: "/srv/iw" })).toBe(path.resolve("/srv/iw"));
    const dir = shim.configDir({});
    expect(dir).toMatch(/infrawrench-cli$/);
    expect(dir.startsWith(os.homedir()) || process.platform === "win32").toBe(true);
  });

  it("opens a URL without a shell", () => {
    const url = "https://example.com/a?b=1&c=2";
    expect(shim.openerFor("darwin", url)).toEqual({ command: "open", args: [url] });
    expect(shim.openerFor("linux", url)).toEqual({ command: "xdg-open", args: [url] });
    expect(shim.openerFor("win32", url).args).toContain(url);
  });

  it("has no keychain, so the master key stays in an owner-only file", () => {
    expect(shim.safeStorage.isEncryptionAvailable()).toBe(false);
  });
});

// The bundle the npm package and the executables ship. Slow-ish (a full
// esbuild pass), so it is built once.
describe("the standalone bundle", () => {
  let out: string;
  let profile: string;
  let bundle: string;
  let meta: { inputs: Record<string, unknown> };

  beforeAll(() => {
    out = mkdtempSync(path.join(os.tmpdir(), "iw-cli-build-"));
    profile = mkdtempSync(path.join(os.tmpdir(), "iw-cli-profile-"));
    execFileSync(
      process.execPath,
      [path.join(__dirname, "../../scripts/build-cli.mjs"), "--out", out],
      {
        stdio: "pipe",
      },
    );
    bundle = path.join(out, "infrawrench.cjs");
    meta = JSON.parse(readFileSync(path.join(out, "meta.json"), "utf8")) as typeof meta;
  }, 120_000);

  afterAll(() => {
    rmSync(out, { recursive: true, force: true });
    rmSync(profile, { recursive: true, force: true });
  });

  const cli = (...args: string[]) =>
    spawnSync(process.execPath, [bundle, ...args], {
      encoding: "utf8",
      env: { ...process.env, INFRAWRENCH_CONFIG_DIR: profile, NO_COLOR: "1" },
    });

  it("runs on plain Node and reports the app's version", () => {
    const pkg = JSON.parse(readFileSync(path.join(__dirname, "../../package.json"), "utf8")) as {
      version: string;
    };
    expect(execFileSync(process.execPath, [bundle, "--version"], { encoding: "utf8" }).trim()).toBe(
      pkg.version,
    );
  });

  it("is the standalone edition", () => {
    const local = cli("accounts", "--local");
    expect(local.status).toBe(2);
    expect(local.stderr).toContain(LOCAL_NEEDS_DESKTOP);
    const apps = cli("apps");
    expect(apps.status).toBe(2);
    expect(apps.stderr).toContain(desktopOnlyCommand("apps"));
    expect(cli("help").stdout).toContain("standalone CLI");
  });

  it("starts signed out with a profile of its own", () => {
    const whoami = cli("whoami");
    expect(whoami.status).toBe(0);
    expect(whoami.stdout).toContain("Not signed in");
    const orgs = cli("orgs");
    expect(orgs.status).toBe(1);
  });

  it("carries no provider SDK and no local workspace", () => {
    const inputs = Object.keys(meta.inputs);
    expect(inputs.some((i) => i.includes("@aws-sdk"))).toBe(false);
    expect(inputs.some((i) => /electron\/local-[a-z-]+\.ts$/.test(i))).toBe(false);
    expect(inputs.some((i) => i.endsWith("electron/plugin-runtime.ts"))).toBe(false);
    expect(readFileSync(bundle).byteLength).toBeLessThan(12 * 1024 * 1024);
  });

  // `standalone/electron.ts` covers exactly what the bundled modules use. The
  // build checks the named imports; this checks the members.
  it("implements every electron member the bundled modules use", () => {
    const missing: string[] = [];
    const root = path.join(__dirname, "../..");
    for (const input of Object.keys(meta.inputs)) {
      if (input.includes("node_modules") || !input.endsWith(".ts")) continue;
      if (input.endsWith("cli/standalone/electron.ts")) continue;
      const file = path.resolve(root, input);
      const source = readFileSync(file, "utf8");
      const imported = /import\s*\{([^}]*)\}\s*from\s*"electron"/.exec(source);
      if (!imported?.[1]) continue;
      const names = imported[1].split(",").map((n) => n.trim().split(/\s+as\s+/)[0]!);
      for (const name of names) {
        const target = (shim as Record<string, unknown>)[name];
        if (!target) {
          missing.push(`${input}: ${name}`);
          continue;
        }
        for (const match of source.matchAll(new RegExp(`\\b${name}\\.(\\w+)`, "g"))) {
          if (!(match[1]! in (target as object))) missing.push(`${input}: ${name}.${match[1]}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });
});
