import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The effect/cli runner end to end: parsing, rendering and exit codes, with the
// Electron app object and the token store stubbed. Nothing reaches a network.
// Pin the cloud URL: env.ts is generated per machine, and CI's points at production.
vi.mock("../../env", async (original) => ({
  ...(await original<typeof import("../../env")>()),
  CLOUD_URL: "http://localhost:3000",
}));
vi.mock("electron", () => ({
  app: { getPath: () => "/tmp", getVersion: () => "9.9.9" },
  shell: { openExternal: vi.fn() },
  ipcMain: { handle: () => {} },
  safeStorage: { isEncryptionAvailable: () => false },
}));

const tokens = vi.hoisted(() => ({
  getAccessToken: vi.fn<() => Promise<string | null>>(),
  forceRefreshAccessToken: vi.fn<() => Promise<string | null>>(),
  fetchCloudOrgs: vi.fn<() => Promise<Array<{ id: string; displayName: string; role: string }>>>(),
  getAuthStatus: vi.fn<() => Promise<{ authenticated: boolean; email?: string }>>(),
  clearStoredTokens: vi.fn<() => Promise<void>>(),
}));

vi.mock("../cloud-tokens", () => ({
  ...tokens,
  createPkceChallenge: vi.fn(),
  buildAuthorizeUrl: vi.fn(),
  exchangeAuthorizationCode: vi.fn(),
  setTokenStoreReadOnly: vi.fn(),
}));

import { Effect } from "effect";
import { CliError } from "../cli/context";
import { CloudApi } from "../cli/effect/cloud-api";
import { commandNames } from "../cli/effect/root";
import { runEffectCli } from "../cli/effect/run";
import { HELP } from "../cli/help";
import { UserFacingError } from "../main-utils";

const ORGS = [
  { id: "org_1", displayName: "Acme", role: "admin" },
  { id: "org_2", displayName: "Globex", role: "member" },
];

let stdout = "";
let stderr = "";

beforeEach(() => {
  stdout = "";
  stderr = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    stdout += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderr += String(chunk);
    return true;
  });
  tokens.getAccessToken.mockResolvedValue("tok");
  tokens.forceRefreshAccessToken.mockResolvedValue(null);
  tokens.fetchCloudOrgs.mockResolvedValue(ORGS);
  tokens.getAuthStatus.mockResolvedValue({ authenticated: true, email: "ada@example.com" });
  tokens.clearStoredTokens.mockResolvedValue();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const run = (...argv: string[]) => runEffectCli(argv, { version: "9.9.9", guiRunning: false });

describe("effect/cli: routing", () => {
  it("knows every command", () => {
    expect([...commandNames].sort()).toEqual([
      "access",
      "accounts",
      "agents",
      "ai-spend",
      "alerts",
      "apps",
      "billing-rules",
      "blast-radius",
      "budgets",
      "canvas",
      "canvases",
      "carbon",
      "changes",
      "cli",
      "commitments",
      "compliance",
      "config",
      "cost-visibility",
      "costs",
      "credits",
      "currency",
      "dashboards",
      "declared-incidents",
      "deploy",
      "diff",
      "dns",
      "dora",
      "estimate",
      "expiring",
      "export",
      "exports",
      "extended-support",
      "github-issues",
      "graph",
      "help",
      "hygiene",
      "idle-rules",
      "incidents",
      "invoices",
      "issues",
      "jit",
      "k8s-efficiency",
      "k8s-network",
      "leaks",
      "leases",
      "login",
      "logout",
      "metrics",
      "moment",
      "network-reports",
      "orgs",
      "orphans",
      "oversized",
      "ownership",
      "page",
      "paging",
      "posture",
      "pr-check",
      "prices",
      "probes",
      "recordings",
      "reports",
      "resource",
      "resource-reports",
      "resources",
      "routing",
      "savings",
      "scenarios",
      "schedules",
      "scorecards",
      "search",
      "seats",
      "services",
      "showback",
      "slos",
      "ssh-fanout",
      "starred",
      "status-pages",
      "tag-keys",
      "tags",
      "tui",
      "unit-costs",
      "virtual-tags",
      "vulnerabilities",
      "vulns",
      "webhooks",
      "whoami",
    ]);
  });
});

describe("effect/cli: bare infrawrench, tui and help", () => {
  const realStdoutTTY = process.stdout.isTTY;
  const realStdinTTY = process.stdin.isTTY;
  afterEach(() => {
    process.stdout.isTTY = realStdoutTTY;
    process.stdin.isTTY = realStdinTTY;
  });

  it.each([
    [[]],
    [["tui"]],
    [["help"]],
    [["help", "costs"]],
    [["--help"]],
    [["-h"]],
    [["--org", "acme"]],
  ])("prints the root help for %j off a terminal", async (argv) => {
    process.stdout.isTTY = false;
    expect(await run(...argv)).toBe(0);
    expect(stdout).toBe(`${HELP}\n`);
    expect(stderr).toBe("");
  });

  it("refuses the TUI when only stdout is a terminal", async () => {
    process.stdout.isTTY = true;
    process.stdin.isTTY = false;
    expect(await run("--no-color")).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toBe(
      "The TUI needs an interactive terminal. Use `infrawrench accounts --json` for scripts.\n",
    );
  });

  it("answers an unknown command with the sentence it always has, exit 2", async () => {
    expect(await run("frobnicate")).toBe(2);
    expect(stdout).toBe("");
    expect(stderr).toBe('Unknown command "frobnicate". Run `infrawrench help`.\n');
  });

  it("answers an unknown root flag with the error and where the list is, exit 2", async () => {
    expect(await run("--bogus")).toBe(2);
    expect(stdout).toBe("");
    expect(stderr).toContain("Unrecognized flag: --bogus");
    expect(stderr).toContain("Run `infrawrench help` for the commands and their flags.");
  });

  it("prints the version alone at the root", async () => {
    expect(await run("--version")).toBe(0);
    expect(stdout).toBe("9.9.9\n");
    stdout = "";
    expect(await run("-v")).toBe(0);
    expect(stdout).toBe("9.9.9\n");
  });
});

describe("effect/cli: global flags", () => {
  it.each([
    [["--json", "whoami"]],
    [["whoami", "--json"]],
    [["whoami", "--output=json"]],
    [["-o", "json", "whoami"]],
    [["--org", "acme", "whoami", "-a", "prod", "--json"]],
    [["whoami", "--org=acme", "--account=prod", "--no-color", "--json"]],
  ])("parses %j", async (argv) => {
    expect(await run(...argv)).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ authenticated: true });
    expect(stderr).toBe("");
  });

  it("keeps the legacy sentence for contradictory flags, wherever they sit", async () => {
    expect(await run("--org", "acme", "whoami", "--local")).toBe(2);
    expect(stderr).toBe("--org and --local are mutually exclusive\n");
    stderr = "";
    expect(await run("whoami", "--text", "--json")).toBe(2);
    expect(stderr).toBe("--json and --text are mutually exclusive\n");
    expect(stdout).toBe("");
  });
});

describe("effect/cli: auth commands", () => {
  it("prints whoami as JSON with the session's orgs", async () => {
    expect(await run("whoami", "--json")).toBe(0);
    expect(JSON.parse(stdout)).toEqual({
      authenticated: true,
      email: "ada@example.com",
      orgs: ORGS,
    });
  });

  it("prints whoami as text", async () => {
    expect(await run("whoami")).toBe(0);
    expect(stdout).toBe("Signed in as ada@example.com\nOrganizations: Acme, Globex\n");
  });

  it("prints orgs as JSON and as a table", async () => {
    expect(await run("orgs", "--json")).toBe(0);
    expect(JSON.parse(stdout)).toEqual(ORGS);
    stdout = "";
    expect(await run("orgs")).toBe(0);
    expect(stdout.split("\n")[0]).toMatch(/^ID\s+NAME\s+ROLE\s*$/);
    expect(stdout).toContain("Plus the local workspace: use --local on any command.");
  });

  it("refuses to sign out while the GUI owns the session", async () => {
    const code = await runEffectCli(["logout"], { version: "9.9.9", guiRunning: true });
    expect(code).toBe(1);
    expect(stderr).toBe(
      "The Infrawrench desktop app is running. Sign out from the app instead (the CLI shares its session).\n",
    );
    expect(tokens.clearStoredTokens).not.toHaveBeenCalled();
  });

  it("signs out with --json", async () => {
    expect(await run("logout", "--json")).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ signedOut: true });
    expect(tokens.clearStoredTokens).toHaveBeenCalledOnce();
  });
});

describe("effect/cli: exit codes and rendering", () => {
  it("prints the version alone", async () => {
    expect(await run("whoami", "--version")).toBe(0);
    expect(stdout).toBe("9.9.9\n");
  });

  it("shows a command's own help on stdout", async () => {
    expect(await run("cli", "--help")).toBe(0);
    expect(stdout).toContain("infrawrench cli");
    expect(stdout).toContain("install");
    expect(stderr).toBe("");
  });

  it("answers an unknown flag with the command's help and an error on stderr, exit 2", async () => {
    expect(await run("whoami", "--bogus")).toBe(2);
    expect(stdout).toBe("");
    expect(stderr).toContain("Unrecognized flag: --bogus");
    expect(stderr).toContain("infrawrench whoami");
  });

  it("exits 2 for an unknown subcommand", async () => {
    expect(await run("cli", "frobnicate")).toBe(2);
    expect(stdout).toBe("");
  });

  it("renders a typed failure as one line, exit 1", async () => {
    tokens.getAccessToken.mockResolvedValue(null);
    expect(await run("orgs")).toBe(1);
    expect(stderr).toBe(
      "Not signed in to Infrawrench Cloud. Run `infrawrench login` (or sign in from the desktop app; the CLI shares its session).\n",
    );
  });

  it("renders a CliError thrown underneath as one line with its exit code", async () => {
    tokens.getAuthStatus.mockRejectedValue(new CliError("Keychain is locked.", 3));
    expect(await run("whoami")).toBe(3);
    expect(stderr).toBe("Keychain is locked.\n");
  });

  it("renders a UserFacingError as one line, exit 1", async () => {
    tokens.getAuthStatus.mockRejectedValue(new UserFacingError("No master key."));
    expect(await run("whoami")).toBe(1);
    expect(stderr).toBe("No master key.\n");
  });

  it("prints the stack for anything else, exit 1", async () => {
    tokens.getAuthStatus.mockRejectedValue(new TypeError("boom"));
    expect(await run("whoami")).toBe(1);
    expect(stderr).toMatch(/^TypeError: boom\n\s+at /);
  });
});

describe("CloudApi's sentences", () => {
  const respond = (body: string, init: ResponseInit) =>
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(body, init)),
    );
  const call = <A, E>(f: (api: CloudApi["Service"]) => Effect.Effect<A, E>) =>
    Effect.runPromise(
      CloudApi.use(f).pipe(
        Effect.flip,
        Effect.map((e) => (e instanceof Error ? e.message : String(e))),
        Effect.provide(CloudApi.layer),
      ),
    );

  it("decodes JSON", async () => {
    respond('{"ok":true}', { status: 200 });
    expect(
      await Effect.runPromise(
        CloudApi.use((api) => api.json("org_1", "/x")).pipe(Effect.provide(CloudApi.layer)),
      ),
    ).toEqual({ ok: true });
  });

  it("keeps the failed-request sentence", async () => {
    respond('{"error":"nope"}', { status: 500 });
    expect(await call((api) => api.json("org_1", "/x"))).toBe(
      'Cloud request failed: 500 /x {"error":"nope"}',
    );
  });

  it("names a web page answering for a missing route", async () => {
    respond("<!doctype html><html></html>", { status: 200 });
    expect(await call((api) => api.text("org_1", "/rec"))).toBe(
      "/rec is not available on http://localhost:3000.\nThe server answered with a web page instead of data, which usually means it is running a version without this endpoint.",
    );
  });

  it("reports a malformed body", async () => {
    respond("not json", { status: 200 });
    expect(await call((api) => api.json("org_1", "/x"))).toBe(
      "Cloud request returned a malformed response for /x not json",
    );
  });

  it("says so when signed out", async () => {
    tokens.getAccessToken.mockResolvedValue(null);
    expect(await call((api) => api.listOrgs)).toMatch(/^Not signed in to Infrawrench Cloud\./);
  });
});
