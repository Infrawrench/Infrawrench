import { beforeEach, describe, expect, it, vi } from "vitest";
const select = vi.fn();
const getClient = vi.fn();
const loadPlugins = vi.fn();
const resolveConfig = vi.fn();
const connect = vi.fn();
vi.mock("../../db/client", () => ({ db: { select: (...args: unknown[]) => select(...args) } }));
vi.mock("../plugin-clients", () => ({
  getClientForAccount: (...args: unknown[]) => getClient(...args),
}));
vi.mock("../../plugins/loader", () => ({
  loadPlugins: (...args: unknown[]) => loadPlugins(...args),
}));
vi.mock("../ssh", () => ({ resolveSshConfig: (...args: unknown[]) => resolveConfig(...args) }));
vi.mock("../ssh-install-transport", () => ({
  connectSshInstaller: (...args: unknown[]) => connect(...args),
}));
const sync = vi.fn();
vi.mock("../sync-resources", () => ({
  syncAccountResources: (...args: unknown[]) => sync(...args),
}));
const { runSshInstall } = await import("../ssh-install");
const input = {
  installerAccountId: "installer",
  target: { accountId: "host-account", resourceTypeId: "server", resourceId: "host-resource" },
  sshKeyId: "key",
  port: 2222,
};
const install = vi.fn();
const close = vi.fn();
let rows: unknown[][];
let native: boolean;
let targetManifest: Record<string, unknown>;
beforeEach(() => {
  vi.clearAllMocks();
  native = false;
  targetManifest = { id: "provider", displayName: "Provider" };
  rows = [
    [{ id: "installer", displayName: "Tailnet", pluginId: "service" }],
    [{ id: "host-resource" }],
  ];
  select.mockImplementation(() => {
    const query: Record<string, unknown> = {};
    query.from = () => query;
    query.innerJoin = () => query;
    query.where = () => {
      const result = rows.shift()!;
      return Object.assign(Promise.resolve(result), { limit: () => Promise.resolve(result) });
    };
    return query;
  });
  const manifest = {
    id: "service",
    displayName: "Service",
    sshInstall: { description: "Install" },
  };
  loadPlugins.mockResolvedValue([{ plugin: { manifest } }]);
  getClient.mockImplementation(async (id: string) =>
    id === "installer"
      ? { plugin: { manifest }, client: { installOnSsh: install } }
      : {
          plugin: {
            manifest: targetManifest,
            resourceTypes: [
              {
                id: "server",
                ...(native
                  ? { supportsTerminal: true }
                  : { sshEndpoint: { hostOutputKey: "ip", defaultUsername: "ubuntu" } }),
              },
            ],
          },
          credentials: { connectThroughAccountId: "jump-account" },
          client: {
            ...(native
              ? {
                  getSshConfig: () => ({
                    host: "ssh.example.com",
                    port: 2200,
                    username: "admin",
                    privateKey: "pem",
                  }),
                }
              : {}),
            getResource: vi
              .fn()
              .mockResolvedValue({ fields: {}, resolvedOutputs: { ip: "host.example.com" } }),
          },
        },
  );
  resolveConfig.mockImplementation(
    async (client: { getSshConfig?: () => unknown }) =>
      client.getSshConfig?.() ?? {
        host: "host.example.com",
        port: 22,
        username: "ubuntu",
        privateKey: "pem",
      },
  );
  connect.mockResolvedValue({ exec: vi.fn(), close });
  install.mockResolvedValue({ message: "Installed" });
});
describe("cross-provider service installation", () => {
  it("resolves a provider SSH endpoint and carries its port and jump chain", async () => {
    await runSshInstall("org", input);
    expect(resolveConfig).toHaveBeenCalledWith(expect.anything(), "org", {
      sshHost: "host.example.com",
      sshKeyId: "key",
      sshUsername: "ubuntu",
    });
    expect(connect).toHaveBeenCalledWith(
      "org",
      expect.objectContaining({ port: 2222 }),
      "jump-account",
    );
    expect(close).toHaveBeenCalled();
    // The installer account is re-synced so the new device is already listed.
    expect(sync).toHaveBeenCalledWith("installer", "org");
  });
  it("preserves a native SSH account's saved port and credentials", async () => {
    native = true;
    await runSshInstall("org", input);
    expect(connect).toHaveBeenCalledWith(
      "org",
      expect.objectContaining({ port: 2200, username: "admin" }),
      "jump-account",
    );
  });
  it("rejects an inaccessible installer before resolving or connecting to the target", async () => {
    rows[0] = [];
    await expect(runSshInstall("org", input)).rejects.toThrow("Installer account not found");
    expect(getClient).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
  });
  it("rejects targets absent from the org/account/type-scoped resource query", async () => {
    rows[1] = [];
    await expect(runSshInstall("org", input)).rejects.toThrow("SSH target not found");
    expect(install).not.toHaveBeenCalled();
  });
  it("refuses a resource whose own plugin is an SSH installer", async () => {
    targetManifest = { id: "service", sshInstall: { description: "Install" } };
    await expect(runSshInstall("org", input)).rejects.toThrow("cannot be a target");
    expect(connect).not.toHaveBeenCalled();
  });
  it("closes the SSH transport after installation fails", async () => {
    install.mockRejectedValue(new Error("Install failed"));
    await expect(runSshInstall("org", input)).rejects.toThrow("Install failed");
    expect(close).toHaveBeenCalled();
    expect(sync).not.toHaveBeenCalled();
  });
});
