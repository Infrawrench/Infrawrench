import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

// `ssh-fanout` on effect/cli: the host list, saved snippets, a run collapsed
// into groups with the outlier diffed, the confirmation gate (answered at a
// fake terminal), `--json`, and the refusals, against fixtures.
vi.mock("electron", () => ({
  app: { getPath: () => "/tmp", getVersion: () => "9.9.9" },
  shell: { openExternal: vi.fn() },
  ipcMain: { handle: () => {} },
  safeStorage: { isEncryptionAvailable: () => false },
}));

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

import { run, serveRoutes, useCliCapture } from "./cli-harness";

const out = useCliCapture();

const cli = (...argv: string[]) => {
  out.stdout = "";
  out.stderr = "";
  return run(...argv);
};

const target = (id: string, label: string, over: Record<string, unknown> = {}) => ({
  kind: "resource",
  id,
  accountId: "acc_1",
  label,
  pluginId: "hetzner",
  resourceTypeId: "server",
  host: `10.0.0.${id.length}`,
  defaultUsername: "root",
  running: true,
  needsKey: false,
  tags: ["env:prod"],
  ...over,
});

const targets = [
  target("srv_1", "web-1"),
  target("srv_22", "web-2"),
  target("srv_333", "web-3"),
  target("srv_4444", "db-1", { tags: ["env:prod", "role:db"], needsKey: true }),
  target("srv_5", "old", { running: false, tags: [] }),
  {
    kind: "account",
    id: "acc_ssh",
    accountId: "acc_ssh",
    label: "bastion",
    pluginId: "ssh",
    running: true,
    needsKey: false,
    tags: [],
  },
];

const snippets = [
  {
    id: "sn_1",
    name: "kernel",
    command: "uname -r",
    description: null,
    createdAt: "x",
    updatedAt: "x",
  },
  {
    id: "sn_2",
    name: "long",
    command: `echo ${"x".repeat(80)}\nsecond line`,
    description: "Two lines",
    createdAt: "x",
    updatedAt: "x",
  },
];

const host = (
  targetId: string,
  label: string,
  stdout: string,
  over: Record<string, unknown> = {},
) => ({
  targetId,
  label,
  status: "done",
  exitCode: 0,
  stdout,
  stderr: "",
  durationMs: 120,
  ...over,
});

const baseRoutes = {
  "GET /ssh-fanout/targets": { targets },
  "GET /ssh-fanout/snippets": { snippets },
  "GET /ssh-keys": [{ id: "6f9c1a2e-0000-4000-8000-000000000001", name: "deploy" }],
  "POST /ssh-fanout/run": {
    results: [
      host("srv_1", "web-1", "6.8.0-45\nok\n"),
      host("srv_22", "web-2", "6.8.0-45\nok\n"),
      host("srv_333", "web-3", "6.8.0-31\nok\n"),
      host("srv_4444", "db-1", "", { status: "error", exitCode: null, error: "host key mismatch" }),
      host("acc_ssh", "bastion", "6.8.0-45\nok", {
        status: "rebooting",
        exitCode: null,
        error: "rebooting",
      }),
    ],
  },
};

const routes = baseRoutes;

/** Every route, the run answering only with statuses this build knows. */
const known = {
  ...baseRoutes,
  "POST /ssh-fanout/run": { results: baseRoutes["POST /ssh-fanout/run"].results.slice(0, 4) },
};

/** The request bodies sent with `method`, parsed. */
const sentBodies = (method: string) =>
  vi
    .mocked(fetch)
    .mock.calls.filter(([, init]) => init?.method === method)
    .map(([, init]) => JSON.parse(String(init?.body)));

describe("ssh-fanout", () => {
  it("lists the selectable hosts, filtered, as text and --json", async () => {
    serveRoutes(out, routes);
    expect(await cli("ssh-fanout", "--list")).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "HOST     PLUGIN   TYPE         ADDRESS    STATE  
      web-1    hetzner  server       10.0.0.5   running
      web-2    hetzner  server       10.0.0.6   running
      web-3    hetzner  server       10.0.0.7   running
      db-1     hetzner  server       10.0.0.8   running
      old      hetzner  server       10.0.0.5   stopped
      bastion  ssh      ssh account  (account)  running
      "
    `);
    serveRoutes(out, routes);
    expect(await cli("ssh-fanout", "--list", "--hosts", "WEB", "--json")).toBe(0);
    expect(JSON.parse(out.stdout)).toEqual({ org: "org_1", targets: targets.slice(0, 3) });
    serveRoutes(out, routes);
    expect(await cli("ssh-fanout", "--list", "--tag", "role:db", "--plugin", "hetzner")).toBe(0);
    serveRoutes(out, routes);
    expect(await cli("ssh-fanout", "--list", "--plugin", "aws")).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "No SSH-capable hosts match.
      "
    `);
  });

  it("lists the saved snippets", async () => {
    serveRoutes(out, routes);
    expect(await cli("ssh-fanout", "snippets")).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "NAME    COMMAND                                                   
      kernel  uname -r                                                  
      long    echo xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx…
      "
    `);
    serveRoutes(out, routes);
    expect(await cli("ssh-fanout", "snippets", "--json")).toBe(0);
    expect(JSON.parse(out.stdout)).toEqual({ org: "org_1", snippets });
    serveRoutes(out, { ...routes, "GET /ssh-fanout/snippets": { snippets: [] } });
    expect(await cli("ssh-fanout", "snippets")).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "No saved snippets. Save one from the Fan-out screen in the app.
      "
    `);
  });

  it("runs on the running hosts, collapsing output and diffing the outlier", async () => {
    serveRoutes(out, routes);
    expect(
      await cli(
        "ssh-fanout",
        "-y",
        "--key",
        "deploy",
        "--user",
        "ops",
        "--concurrency",
        "4",
        "--",
        "uname",
        "-r",
      ),
    ).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "
      5 hosts · 3 ok · 2 failed · 4 distinct outputs

      majority 2 hosts exit 0
        web-1, web-2
        6.8.0-45
        ok

      outlier 1 host exit 0
        web-3
        - 6.8.0-45
        + 6.8.0-31
          ok

      failed 1 host
        db-1
        host key mismatch

      failed 1 host
        bastion
        rebooting
      "
    `);
    expect(sentBodies("POST")).toEqual([
      {
        command: "uname -r",
        targets: [
          { kind: "resource", id: "srv_1" },
          { kind: "resource", id: "srv_22" },
          { kind: "resource", id: "srv_333" },
          { kind: "resource", id: "srv_4444" },
          { kind: "account", id: "acc_ssh" },
        ],
        sshKeyId: "6f9c1a2e-0000-4000-8000-000000000001",
        username: "ops",
        concurrency: 4,
      },
    ]);
    serveRoutes(out, known);
    expect(await cli("ssh-fanout", "-y", "--key", "deploy", "--snippet", "kernel", "--json")).toBe(
      0,
    );
    expect(JSON.parse(out.stdout)).toEqual({
      org: "org_1",
      command: "uname -r",
      results: known["POST /ssh-fanout/run"].results,
    });
  });

  it("asks before running at a terminal, and refuses without one", async () => {
    serveRoutes(out, routes);
    expect(await cli("ssh-fanout", "--hosts", "web", "uptime")).toBe(2);
    expect(out.stdout).toMatchInlineSnapshot(`
      "uptime
        on 3 hosts: web-1, web-2, web-3
      "
    `);
    expect(out.stderr).toMatchInlineSnapshot(`
      "Refusing to fan out without confirmation on a non-interactive terminal. Pass --yes to run unattended.
      "
    `);
  });

  describe("at a terminal", () => {
    const realStdin = Object.getOwnPropertyDescriptor(process, "stdin");
    const realIsTTY = process.stdout.isTTY;
    afterEach(() => {
      if (realStdin) Object.defineProperty(process, "stdin", realStdin);
      process.stdout.isTTY = realIsTTY;
    });

    /** A terminal whose user presses `key` once the program starts listening. */
    const terminalAnswering = (key: string) => {
      const stdin = Object.assign(new PassThrough(), {
        isTTY: true,
        isRaw: false,
        setRawMode(raw: boolean) {
          stdin.isRaw = raw;
          return stdin;
        },
      });
      const resume = stdin.resume.bind(stdin);
      stdin.resume = () => {
        setImmediate(() => stdin.write(key));
        return resume();
      };
      Object.defineProperty(process, "stdin", { configurable: true, get: () => stdin });
      process.stdout.isTTY = true;
    };

    it("runs once the user says yes", async () => {
      terminalAnswering("y");
      serveRoutes(out, known);
      expect(await cli("ssh-fanout", "--no-color", "--hosts", "web", "uptime")).toBe(0);
      expect(out.stdout.split("\n").slice(0, 3)).toMatchInlineSnapshot(`
        [
          "uptime",
          "  on 3 hosts: web-1, web-2, web-3",
          "Run on 3 hosts? [y/N] [?25l[?25hyes",
        ]
      `);
    });

    it("stops when the user says no", async () => {
      terminalAnswering("n");
      serveRoutes(out, known);
      expect(await cli("ssh-fanout", "--no-color", "--hosts", "web", "uptime")).toBe(0);
      expect(out.stdout).toMatchInlineSnapshot(`
        "uptime
          on 3 hosts: web-1, web-2, web-3
        Run on 3 hosts? [y/N] [?25l[?25hno
        Canceled.
        "
      `);
      expect(out.requests).not.toContain("POST /ssh-fanout/run");
    });
  });

  it("refuses what it cannot run, in the legacy sentences", async () => {
    const said: string[] = [];
    const cases: Array<[string[], Record<string, unknown>]> = [
      [["ssh-fanout", "--local", "uptime"], routes],
      [["ssh-fanout", "-y"], routes],
      [["ssh-fanout", "-y", "--snippet", "nope"], routes],
      [["ssh-fanout", "-y", "--plugin", "aws", "uptime"], routes],
      [["ssh-fanout", "-y", "uptime"], routes],
      [["ssh-fanout", "-y", "--key", "missing", "uptime"], routes],
      [["ssh-fanout", "-y", "--key", "x", "uptime"], { ...routes, "GET /ssh-keys": [] }],
      [
        ["ssh-fanout", "-y", "uptime"],
        {
          ...routes,
          "GET /ssh-fanout/targets": {
            targets: Array.from({ length: 101 }, (_, i) => target(`s${i}`, `h${i}`)),
          },
        },
      ],
    ];
    for (const [argv, fixtures] of cases) {
      serveRoutes(out, fixtures);
      expect(await cli(...argv)).toBe(2);
      said.push(out.stderr);
    }
    expect(said).toMatchInlineSnapshot(`
      [
        "Fan-out SSH runs server-side (change freezes, the org keystore and the audit trail live there). Drop --local, or use the desktop app's Fan-out screen for local SSH accounts.
      ",
        "Nothing to run. Pass a command (infrawrench ssh-fanout "uname -r"), --snippet <name>, or --list. If the remote command has flags of its own, put -- before it so they are not parsed here: infrawrench ssh-fanout -y -- uptime -p.
      ",
        "No saved snippet named "nope". Run \`infrawrench ssh-fanout snippets\` to list them.
      ",
        "No running hosts match. Use --list to see what is selectable, and --hosts/--plugin/--tag to filter.
      ",
        "Some selected hosts are VMs that need one of your org SSH keys. Pass --key <id|name>.
      ",
        "No SSH key "missing" in this organization. Available: deploy
      ",
        "No SSH key "x" in this organization.
      ",
        "101 hosts match. The server accepts at most 100 per run. Narrow with --hosts/--plugin/--tag.
      ",
      ]
    `);
  });

  it("checks --concurrency at parse time", async () => {
    expect(await cli("ssh-fanout", "-y", "--concurrency", "0", "uptime")).toBe(2);
    expect(out.stderr).toContain('--concurrency must be a whole number of at least 1, got "0"');
  });
});
