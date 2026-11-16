import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The exit status `runCli` (the `--cli` entry) hands Electron, which is what
// the shell sees. `app.exit(code)` exits with its argument and never reads
// `process.exitCode`, so the entry has to settle the status itself (#902).
const exit = vi.hoisted(() => vi.fn());
vi.mock("electron", () => ({
  app: {
    getPath: () => "/tmp",
    getVersion: () => "9.9.9",
    whenReady: async () => {},
    requestSingleInstanceLock: () => true,
    releaseSingleInstanceLock: () => {},
    commandLine: { appendSwitch: () => {} },
    dock: { hide: () => {} },
    exit,
  },
  shell: { openExternal: vi.fn() },
  ipcMain: { handle: () => {} },
  safeStorage: { isEncryptionAvailable: () => false },
}));

vi.mock("../db", () => ({ wireDbGetter: vi.fn(), setDatabaseReadOnly: vi.fn() }));

vi.mock("../cloud-tokens", () => ({
  getAccessToken: vi.fn(async () => "tok"),
  forceRefreshAccessToken: vi.fn(async () => null),
  fetchCloudOrgs: vi.fn(async () => [{ id: "org_1", displayName: "Acme", role: "admin" }]),
  getAuthStatus: vi.fn(async () => ({ authenticated: true, email: "ada@example.com" })),
  clearStoredTokens: vi.fn(),
  createPkceChallenge: vi.fn(),
  buildAuthorizeUrl: vi.fn(),
  exchangeAuthorizationCode: vi.fn(),
  setTokenStoreReadOnly: vi.fn(),
}));

// A command that reports failure the Node way, by setting `process.exitCode`
// and returning: what the commands listed in #902 did before effect/cli, and
// what any Promise code underneath a command can still do.
vi.mock("../cli/effect/run", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../cli/effect/run")>();
  return {
    ...actual,
    runEffectCli: async (argv: ReadonlyArray<string>, options: never) => {
      if (argv[0] !== "sets-exit-code") return actual.runEffectCli(argv, options);
      process.exitCode = 3;
      return 0;
    },
  };
});

import { runCli } from "../cli/main";
import { serveRoutes, useCliCapture } from "./cli-harness";

const out = useCliCapture();
const argv = process.argv;

/** Run `infrawrench <args>` through the real entry; resolves with the status it exits with. */
async function cli(...args: string[]): Promise<number> {
  process.argv = ["electron", ".", "--cli", ...args];
  await runCli();
  expect(exit).toHaveBeenCalledTimes(1);
  return exit.mock.calls[0]![0] as number;
}

describe("the exit status of `infrawrench`", () => {
  beforeEach(() => {
    exit.mockClear();
    // `runCli` installs its terminal guards on every call.
    vi.spyOn(process, "on").mockReturnValue(process);
    vi.spyOn(process.stdout, "on").mockReturnValue(process.stdout);
    vi.spyOn(process.stderr, "on").mockReturnValue(process.stderr);
  });
  afterEach(() => {
    process.argv = argv;
    // Left set, the test runner itself would exit non-zero.
    process.exitCode = undefined;
  });

  it("is 0 for a command that succeeds", async () => {
    expect(await cli("--version")).toBe(0);
    expect(out.stdout).toBe("9.9.9\n");
  });

  it("is a command's typed failure", async () => {
    serveRoutes(out, {});
    expect(await cli("webhooks", "--local")).toBe(1);
    expect(out.stderr).toContain("Event subscriptions live in Infrawrench Cloud");
  });

  it("is 2 for a command line that does not parse", async () => {
    expect(await cli("frobnicate")).toBe(2);
  });

  it("is what a command left in process.exitCode when it returned normally", async () => {
    expect(await cli("sets-exit-code")).toBe(3);
  });
});

describe("leaving", () => {
  beforeEach(() => {
    exit.mockClear();
    vi.spyOn(process, "on").mockReturnValue(process);
    vi.spyOn(process.stdout, "on").mockReturnValue(process.stdout);
    vi.spyOn(process.stderr, "on").mockReturnValue(process.stderr);
  });
  afterEach(() => {
    process.argv = argv;
  });

  // `app.exit` does not flush: output still queued for a pipe (asynchronous
  // on macOS) was cut off at the pipe's 64 KiB buffer (#1235).
  it("waits until queued output has left before exiting", async () => {
    const flushes: Array<() => void> = [];
    vi.spyOn(process.stdout, "write").mockImplementation(((_chunk: unknown, done?: unknown) => {
      if (typeof done === "function") flushes.push(done as () => void);
      return true;
    }) as typeof process.stdout.write);
    vi.spyOn(process.stdout, "writableLength", "get").mockReturnValue(65_536);

    process.argv = ["electron", ".", "--cli", "--version"];
    const running = runCli();
    await vi.waitFor(() => expect(flushes).toHaveLength(1));
    expect(exit).not.toHaveBeenCalled();

    flushes[0]!();
    await running;
    expect(exit).toHaveBeenCalledWith(0);
  });
});
