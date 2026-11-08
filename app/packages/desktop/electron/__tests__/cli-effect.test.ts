import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The effect/cli runner end to end: parsing, rendering and exit codes, with the
// Electron app object and the token store stubbed. Nothing reaches a network.
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

import { scanCommandLine } from "../cli/args";
import { CliError, listOrgs, orgFetch, orgFetchText } from "../cli/context";
import { migratedCommands } from "../cli/effect/root";
import { runEffectCli } from "../cli/effect/run";
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

describe("effect/cli bridge: routing", () => {
  it("lists the migrated commands", () => {
    expect([...migratedCommands].sort()).toEqual([
      "access",
      "accounts",
      "agents",
      "ai-spend",
      "alerts",
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
      "cost-visibility",
      "costs",
      "credits",
      "currency",
      "dashboards",
      "declared-incidents",
      "dns",
      "dora",
      "estimate",
      "expiring",
      "export",
      "exports",
      "extended-support",
      "github-issues",
      "graph",
      "hygiene",
      "idle-rules",
      "incidents",
      "invoices",
      "issues",
      "k8s-efficiency",
      "k8s-network",
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
      "search",
      "showback",
      "slos",
      "starred",
      "status-pages",
      "tag-keys",
      "tags",
      "unit-costs",
      "virtual-tags",
      "webhooks",
      "whoami",
    ]);
  });

  it("finds the command word past global and legacy flags with values", () => {
    expect(scanCommandLine(["--org", "acme", "whoami"]).command).toBe("whoami");
    expect(scanCommandLine(["-a", "prod", "--json", "orgs"]).command).toBe("orgs");
    expect(scanCommandLine(["--limit", "5", "vulns"]).command).toBe("vulns");
    expect(scanCommandLine(["--no-color", "whoami"])).toEqual({ command: "whoami", noColor: true });
    expect(scanCommandLine(["--version"]).command).toBeUndefined();
  });
});

describe("effect/cli bridge: global flags", () => {
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

describe("effect/cli bridge: pilot commands", () => {
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

describe("effect/cli bridge: exit codes and rendering", () => {
  it("prints the version alone", async () => {
    expect(await run("whoami", "--version")).toBe(0);
    expect(stdout).toBe("9.9.9\n");
  });

  it("shows a migrated command's own help on stdout", async () => {
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

  it("renders a legacy CliError thrown underneath as one line with its exit code", async () => {
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

describe("legacy Promise helpers over CloudApi", () => {
  const respond = (body: string, init: ResponseInit) =>
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(body, init)),
    );

  it("decodes JSON", async () => {
    respond('{"ok":true}', { status: 200 });
    expect(await orgFetch<{ ok: boolean }>("org_1", "/x")).toEqual({ ok: true });
  });

  it("keeps the failed-request sentence", async () => {
    respond('{"error":"nope"}', { status: 500 });
    await expect(orgFetch("org_1", "/x")).rejects.toThrow(
      new CliError('Cloud request failed: 500 /x {"error":"nope"}'),
    );
  });

  it("names a web page answering for a missing route", async () => {
    respond("<!doctype html><html></html>", { status: 200 });
    await expect(orgFetchText("org_1", "/rec")).rejects.toThrow(
      "/rec is not available on http://localhost:3000.\nThe server answered with a web page instead of data, which usually means it is running a version without this endpoint.",
    );
  });

  it("reports a malformed body", async () => {
    respond("not json", { status: 200 });
    await expect(orgFetch("org_1", "/x")).rejects.toThrow(
      "Cloud request returned a malformed response for /x not json",
    );
  });

  it("rejects with a CliError when signed out", async () => {
    tokens.getAccessToken.mockResolvedValue(null);
    const error = await listOrgs().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CliError);
    expect(error).toMatchObject({ exitCode: 1 });
  });
});
