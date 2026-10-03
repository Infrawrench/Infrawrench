import { beforeEach, describe, expect, it, vi } from "vitest";

const updates: unknown[] = [];
const getClient = vi.fn();
const listAccounts = vi.fn();
const execScript = vi.fn();
const end = vi.fn();

vi.mock("../../db/client", () => ({
  db: {
    update: () => ({
      set: (values: unknown) => ({
        where: async () => {
          updates.push(values);
        },
      }),
    }),
  },
}));
vi.mock("../plugin-clients", () => ({
  getClientForAccount: (...args: unknown[]) => getClient(...args),
}));
vi.mock("../ssh-install", () => ({
  listSshInstallAccounts: (...args: unknown[]) => listAccounts(...args),
}));
vi.mock("@infrawrench/ssh-tunnel-core", () => ({
  execSshScript: (...args: unknown[]) => execScript(...args),
}));
vi.mock("ssh2", () => {
  class Client {
    private handlers: Record<string, () => void> = {};
    once(event: string, handler: () => void) {
      this.handlers[event] = handler;
      return this;
    }
    connect() {
      queueMicrotask(() => this.handlers.ready?.());
    }
    end() {
      end();
    }
  }
  return { default: { Client } };
});

const { installAgentServices, releaseAgentServices, resolveAgentServiceAccounts } =
  await import("../agent-services");

const target = { host: "203.0.113.7", port: 22, username: "root" };
const row = {
  id: "session-1",
  serviceAccountIds: ["ts-account"],
  serviceInstallsJson: [],
} as never;

beforeEach(() => {
  vi.clearAllMocks();
  updates.length = 0;
  listAccounts.mockResolvedValue([
    { accountId: "ts-account", pluginId: "tailscale", displayName: "tailnet" },
  ]);
});

describe("agent service accounts", () => {
  it("keeps only installable accounts, deduplicated, with their plugin ids", async () => {
    expect(
      await resolveAgentServiceAccounts("org", ["ts-account", "missing", "ts-account"]),
    ).toEqual({ accountIds: ["ts-account"], pluginIds: ["tailscale"] });
  });

  it("installs over a stdin transport, logs the result and stores the plugin's ref", async () => {
    execScript.mockResolvedValue("ok");
    const installOnSsh = vi.fn(async (ctx: { exec(s: string): Promise<string> }) => {
      await ctx.exec("secret-bearing script");
      return { message: "Connected.", address: "100.64.0.9", ref: "nNode1" };
    });
    getClient.mockResolvedValue({
      plugin: { manifest: { id: "tailscale", displayName: "Tailscale", sshInstall: {} } },
      client: { installOnSsh },
    });
    const log = vi.fn(async () => {});
    await installAgentServices(row, "org", target, "pem", log);
    // The script goes to execSshScript (stdin), never into an exec argument.
    expect(execScript).toHaveBeenCalledWith(expect.anything(), "secret-bearing script");
    expect(end).toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith("Tailscale: Connected.");
    expect(updates.at(-1)).toMatchObject({
      serviceInstallsJson: [
        { accountId: "ts-account", pluginId: "tailscale", address: "100.64.0.9", ref: "nNode1" },
      ],
    });
  });

  it("fails setup with the plugin's error and still closes the connection", async () => {
    getClient.mockResolvedValue({
      plugin: { manifest: { id: "tailscale", displayName: "Tailscale", sshInstall: {} } },
      client: { installOnSsh: vi.fn().mockRejectedValue(new Error("no sudo")) },
    });
    await expect(installAgentServices(row, "org", target, "pem", vi.fn())).rejects.toThrow(
      "Tailscale installation failed: no sudo",
    );
    expect(end).toHaveBeenCalled();
  });

  it("releases each install by ref and never blocks on errors", async () => {
    const release = vi.fn().mockRejectedValueOnce(new Error("API down"));
    getClient.mockResolvedValue({ client: { releaseSshInstall: release } });
    await releaseAgentServices(
      {
        serviceInstallsJson: [
          { accountId: "a", pluginId: "tailscale", message: "", ref: "n1" },
          { accountId: "b", pluginId: "tailscale", message: "" },
          { accountId: "c", pluginId: "tailscale", message: "", ref: "n3" },
        ],
      },
      "org",
    );
    expect(release.mock.calls).toEqual([["n1"], ["n3"]]);
  });
});
