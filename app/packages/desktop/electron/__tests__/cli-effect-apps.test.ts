import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

// `apps` on effect/cli: listing a Linux host's applications over SSH, the
// host setup check and install, the desktop deep link, and the refusals. The
// SSH connection, the app server and the local workspace are all fakes.
vi.mock("electron", () => ({
  app: { getPath: () => "/tmp", getVersion: () => "9.9.9" },
  shell: { openExternal: vi.fn(async () => {}) },
  ipcMain: { handle: () => {} },
  safeStorage: { isEncryptionAvailable: () => false },
}));

vi.mock("../cloud-tokens", () => ({
  getAccessToken: vi.fn(async () => "tok"),
  forceRefreshAccessToken: vi.fn(async () => null),
  fetchCloudOrgs: vi.fn(async () => []),
  getAuthStatus: vi.fn(async () => ({ authenticated: false })),
  clearStoredTokens: vi.fn(),
  createPkceChallenge: vi.fn(),
  buildAuthorizeUrl: vi.fn(),
  exchangeAuthorizationCode: vi.fn(),
  setTokenStoreReadOnly: vi.fn(),
}));

const vm = {
  id: "acc_1:vm:i-1",
  pluginId: "linode",
  resourceTypeId: "vm",
  accountId: "acc_1",
  displayName: "web-1",
  externalId: "i-1",
  fields: { login: "" },
  outputs: {},
  parentResourceId: null,
};

vi.mock("../cli/context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../cli/context")>()),
  listLocalAccounts: vi.fn(async () => [{ id: "acc_1", pluginId: "linode", displayName: "Lab" }]),
  listLocalResources: vi.fn(async () => ({
    rows: [vm, { ...vm, id: "acc_1:vm:i-2" }],
    errors: [],
  })),
  loadLocalResourceOutputs: vi.fn(async (_account: unknown, row: typeof vm) => ({
    ...row,
    outputs: row.id === "acc_1:vm:i-2" ? {} : { ipv4: "203.0.113.7" },
  })),
}));

vi.mock("../../src/plugins/loader", () => ({
  getPlugin: vi.fn(async () => ({
    plugin: {
      resourceTypes: [
        {
          id: "vm",
          sshEndpoint: {
            hostOutputKey: "ipv4",
            usernameFieldKey: "login",
            defaultUsername: "ubuntu",
          },
        },
        { id: "bucket" },
      ],
    },
  })),
}));

const sshClient = { end: vi.fn() };
vi.mock("../ssh-shell", async () => {
  const { Effect } = await import("effect");
  const connect = vi.fn(async (_config: unknown) => ({ client: sshClient, intermediates: [] }));
  const end = vi.fn();
  return {
    connectSshChain: connect,
    endSshChain: end,
    acquireSshChain: (config: unknown) =>
      Effect.acquireRelease(
        Effect.promise(() => connect(config)),
        ({ client, intermediates }) => Effect.sync(() => end(client, intermediates)),
      ),
  };
});

vi.mock("../iwappd-archive", () => ({
  getx86_64GzBinary: () => new Uint8Array(),
  getArm64GzBinary: () => new Uint8Array(),
}));

const state = vi.hoisted(() => ({ blocked: false }));

const preflight = (ready: boolean) => ({
  osName: "Ubuntu 24.04",
  arch: "x86_64",
  ready,
  staging: ready ? "/dev/shm" : null,
  appCount: ready ? 3 : 0,
  requirements: [
    {
      id: "xkb",
      title: "Keyboard maps",
      ok: ready,
      severity: "required",
      summary: "xkb-data is needed",
    },
    { id: "fonts", title: "Fonts", ok: true, severity: "recommended", summary: "" },
    { id: "gl", title: "OpenGL", ok: false, severity: "recommended", summary: "Mesa is absent" },
  ],
});
const plan = {
  canInstall: true,
  blockedReason: null,
  commands: ["apt-get install -y xkb-data"],
};

vi.mock("@infrawrench/appstream-host", () => ({
  listApps: vi.fn(async () => [
    { id: "org.gnome.gedit", name: "Text Editor", comment: "Edit text", categories: ["Utility"] },
    { id: "htop", name: "htop", needsTerminal: true },
  ]),
  checkHost: vi.fn(async () => ({
    preflight: preflight(false),
    plan: state.blocked
      ? { ...plan, canInstall: false, blockedReason: "Not root and no sudo." }
      : plan,
  })),
  installRequirements: vi.fn(
    async (_client: unknown, _plan: unknown, options: { onOutput?: (line: string) => void }) => {
      options.onOutput?.("Reading package lists...");
      options.onOutput?.("Setting up xkb-data");
      return { preflight: preflight(true), failed: [] };
    },
  ),
  planInstall: vi.fn((p: { ready: boolean }) => (p.ready ? null : plan)),
}));

import { shell } from "electron";
import { listApps } from "@infrawrench/appstream-host";
import { connectSshChain, endSshChain } from "../ssh-shell";
import { run, serveRoutes, useCliCapture } from "./cli-harness";

const out = useCliCapture();

const cli = (...argv: string[]) => {
  out.stdout = "";
  out.stderr = "";
  return run(...argv);
};

const keyFile = path.join(mkdtempSync(path.join(tmpdir(), "iw-apps-")), "id_ed25519");
writeFileSync(keyFile, "-----BEGIN KEY-----\n");

describe("apps", () => {
  it("lists a host's applications over SSH, and ends the connection", async () => {
    serveRoutes(out, {});
    expect(await cli("apps", "acc_1:vm:i-1", "--local", "--key", keyFile)).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "NAME         ID                       
      Text Editor  org.gnome.gedit          
      htop         htop             terminal

      infrawrench apps acc_1:vm:i-1 --launch <id>   open one in Infrawrench
      "
    `);
    expect(vi.mocked(connectSshChain).mock.calls.at(-1)?.[0]).toEqual({
      host: "203.0.113.7",
      port: 22,
      username: "ubuntu",
      privateKey: "-----BEGIN KEY-----\n",
    });
    expect(vi.mocked(endSshChain)).toHaveBeenCalledTimes(1);
  });

  it("prints --json as the app server sent it, with a --user override", async () => {
    expect(
      await cli("apps", "acc_1:vm:i-1", "--local", "--key", keyFile, "--user", "ops", "--json"),
    ).toBe(0);
    expect(JSON.parse(out.stdout)).toEqual(await vi.mocked(listApps).mock.results[0]!.value);
    expect(vi.mocked(connectSshChain).mock.calls.at(-1)?.[0]).toMatchObject({ username: "ops" });
  });

  it("says so when the host has no applications", async () => {
    vi.mocked(listApps).mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    expect(await cli("apps", "acc_1:vm:i-1", "--local", "--key", keyFile)).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "No graphical applications are installed on this host.
      Infrawrench brings the display; the host brings the applications.
      "
    `);
  });

  it("checks the host, and exits 1 while it is not ready", async () => {
    expect(await cli("apps", "acc_1:vm:i-1", "--local", "--key", keyFile, "--check")).toBe(1);
    expect(out.stdout).toMatchInlineSnapshot(`
      "Ubuntu 24.04  x86_64

        Keyboard maps  missing
                       xkb-data is needed
        Fonts          ok
        OpenGL         absent
                       Mesa is absent

      No writable, exec-capable directory to run the app server from: /tmp and /dev/shm are unwritable or mounted noexec.

      No graphical applications are installed on this host either.

      Run with --install to install these:
        apt-get install -y xkb-data
      "
    `);
    expect(out.stderr).toBe("");
    // The legacy command meant exit 1 too (`process.exitCode`), which
    // `runCli`'s `app.exit(0)` overwrote, so it exited 0.
    expect(
      await cli("apps", "acc_1:vm:i-1", "--local", "--key", keyFile, "--check", "--json"),
    ).toBe(1);
    expect(JSON.parse(out.stdout)).toEqual({ preflight: preflight(false), plan });
  });

  it("installs what is missing, streaming the installer's output", async () => {
    expect(await cli("apps", "acc_1:vm:i-1", "--local", "--key", keyFile, "--install")).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "$ apt-get install -y xkb-data
      Reading package lists...
      Setting up xkb-data
      Ubuntu 24.04  x86_64

        Keyboard maps  ok
        Fonts          ok
        OpenGL         absent
                       Mesa is absent
      "
    `);
    expect(
      await cli("apps", "acc_1:vm:i-1", "--local", "--key", keyFile, "--install", "--json"),
    ).toBe(0);
    expect(JSON.parse(out.stdout.slice(out.stdout.indexOf("{")))).toEqual({
      preflight: preflight(true),
      plan: null,
    });
  });

  it("says what to run by hand when the plan cannot install", async () => {
    state.blocked = true;
    expect(await cli("apps", "acc_1:vm:i-1", "--local", "--key", keyFile, "--install")).toBe(1);
    expect(out.stdout).toMatchInlineSnapshot(`
      "Ubuntu 24.04  x86_64

        Keyboard maps  missing
                       xkb-data is needed
        Fonts          ok
        OpenGL         absent
                       Mesa is absent

      No writable, exec-capable directory to run the app server from: /tmp and /dev/shm are unwritable or mounted noexec.

      No graphical applications are installed on this host either.

      Not root and no sudo.
      Run these on the host:
        apt-get install -y xkb-data
      "
    `);
    state.blocked = false;
  });

  it("opens an application in the desktop app", async () => {
    expect(await cli("apps", "acc_1:vm:i-1", "--launch", "htop")).toBe(0);
    expect(out.stdout).toMatchInlineSnapshot(`
      "opening htop on acc_1:vm:i-1 in Infrawrench…
      "
    `);
    expect(vi.mocked(shell.openExternal)).toHaveBeenLastCalledWith(
      "infrawrench://apps?resource=acc_1%3Avm%3Ai-1&app=htop",
    );
  });

  it("refuses what it cannot do, in the legacy sentences", async () => {
    const said: string[] = [];
    for (const argv of [
      ["apps"],
      ["apps", "acc_1:vm:i-9", "--local"],
      ["apps", "acc_1:vm:i-2", "--local"],
      ["apps", "acc_1:vm:i-1", "--local"],
      ["apps", "acc_1:vm:i-1", "--local", "--key", "/nonexistent/key"],
    ]) {
      expect(await cli(...argv)).toBe(1);
      expect(out.stdout).toBe("");
      said.push(out.stderr);
    }
    expect(said).toMatchInlineSnapshot(`
      [
        "Usage: infrawrench apps <resource-id> [--json] [--launch <app-id>] [--check] [--install] [--key <path>] [--user <name>]
      ",
        "Resource acc_1:vm:i-9 not found in Lab.
      ",
        "web-1 has no reachable address yet (no ipv4). It may still be provisioning.
      ",
        "Applications need an SSH key: pass --key <path to a private key>, and --user if the host's login is not root.
      ",
        "Could not read the SSH key at /nonexistent/key
      ",
      ]
    `);
  });
});
