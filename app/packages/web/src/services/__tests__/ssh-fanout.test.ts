import { describe, it, expect, vi, beforeEach } from "vitest";

const mockSelect = vi.fn();
vi.mock("../../db/client", () => ({ db: { select: (...a: unknown[]) => mockSelect(...a) } }));
const mockGetClientForAccount = vi.fn();
vi.mock("../plugin-clients", () => ({
  getClientForAccount: (...a: unknown[]) => mockGetClientForAccount(...a),
}));
const mockLoadPlugins = vi.fn();
vi.mock("../../plugins/loader", () => ({
  loadPlugins: (...a: unknown[]) => mockLoadPlugins(...a),
  getPlugin: vi.fn(),
}));
vi.mock("../encryption", () => ({ decrypt: vi.fn(), buildAad: vi.fn() }));

const mockResolveSshConfig = vi.fn();
const mockSshExecCapture = vi.fn();
vi.mock("../ssh", () => ({
  resolveSshConfig: (...a: unknown[]) => mockResolveSshConfig(...a),
  sshExecCapture: (...a: unknown[]) => mockSshExecCapture(...a),
}));

const mockResolveSafeHost = vi.fn();
vi.mock("../host-validation", () => ({
  resolveSafeHost: (...a: unknown[]) => mockResolveSafeHost(...a),
}));

const { deriveResourceTarget, listFanoutTargets, runFanout } = await import("../ssh-fanout");

const row = {
  id: "res-1",
  accountId: "acc-1",
  pluginId: "aws",
  resourceTypeId: "ec2-instance",
  displayName: "web-01",
  fieldsJson: { state: "running", sshUser: "ubuntu", tags: { env: "prod" } },
  outputsJson: { publicIp: "203.0.113.7" },
};

describe("deriveResourceTarget", () => {
  it("returns null without an sshEndpoint declaration", () => {
    expect(deriveResourceTarget(row, undefined)).toBeNull();
    expect(deriveResourceTarget(row, {})).toBeNull();
  });

  it("resolves the host from outputs, falling back to fields", () => {
    const t = deriveResourceTarget(row, { sshEndpoint: { hostOutputKey: "publicIp" } });
    expect(t?.host).toBe("203.0.113.7");
    const fromFields = deriveResourceTarget(
      { ...row, outputsJson: {}, fieldsJson: { ...row.fieldsJson, publicIp: "198.51.100.2" } },
      { sshEndpoint: { hostOutputKey: "publicIp" } },
    );
    expect(fromFields?.host).toBe("198.51.100.2");
  });

  it("returns null when no host resolves", () => {
    expect(
      deriveResourceTarget(
        { ...row, outputsJson: {} },
        { sshEndpoint: { hostOutputKey: "publicIp" } },
      ),
    ).toBeNull();
  });

  it("applies runningWhen case-insensitively", () => {
    const endpoint = {
      sshEndpoint: {
        hostOutputKey: "publicIp",
        runningWhen: { fieldKey: "state", value: "RUNNING" },
      },
    };
    expect(deriveResourceTarget(row, endpoint)?.running).toBe(true);
    expect(
      deriveResourceTarget({ ...row, fieldsJson: { state: "stopped" } }, endpoint)?.running,
    ).toBe(false);
  });

  it("prefers the usernameFieldKey field over defaultUsername", () => {
    const t = deriveResourceTarget(row, {
      sshEndpoint: {
        hostOutputKey: "publicIp",
        defaultUsername: "admin",
        usernameFieldKey: "sshUser",
      },
    });
    expect(t?.defaultUsername).toBe("ubuntu");
    const noField = deriveResourceTarget(
      { ...row, fieldsJson: { state: "running" } },
      { sshEndpoint: { hostOutputKey: "publicIp", defaultUsername: "admin" } },
    );
    expect(noField?.defaultUsername).toBe("admin");
  });

  it("carries resource tags as key:value strings and flags needsKey", () => {
    const t = deriveResourceTarget(row, { sshEndpoint: { hostOutputKey: "publicIp" } });
    expect(t?.tags).toEqual(["env:prod"]);
    expect(t?.needsKey).toBe(true);
    expect(t?.kind).toBe("resource");
    expect(t?.label).toBe("web-01");
  });
});

describe("listFanoutTargets", () => {
  it("lists accounts under the plugin that declares them as hosts", async () => {
    mockLoadPlugins.mockResolvedValue([
      { plugin: { manifest: { id: "hosts", jumpHost: true }, resourceTypes: [] } },
      { plugin: { manifest: { id: "other" }, resourceTypes: [] } },
    ]);
    const where = vi
      .fn()
      .mockResolvedValue([{ id: "acct-1", displayName: "box", pluginId: "hosts" }]);
    const from = vi.fn().mockReturnValue({ where });
    mockSelect.mockReturnValue({ from });

    const targets = await listFanoutTargets("org-1");

    expect(targets[0]).toMatchObject({ kind: "account", id: "acct-1", pluginId: "hosts" });
  });
});

describe("runFanout host pinning", () => {
  const CONFIG = { host: "box.example", port: 22, username: "root", privateKey: "KEY" };

  beforeEach(() => {
    vi.clearAllMocks();
    // accountLabel's lookup: the only query an account target makes.
    const limit = vi.fn().mockResolvedValue([{ displayName: "bastion" }]);
    const where = vi.fn().mockReturnValue({ limit });
    const from = vi.fn().mockReturnValue({ where });
    mockSelect.mockReturnValue({ from });
    mockGetClientForAccount.mockResolvedValue({
      plugin: { manifest: { id: "ssh", jumpHost: true } },
      client: {},
    });
    mockResolveSshConfig.mockResolvedValue(CONFIG);
    mockSshExecCapture.mockResolvedValue({ stdout: "ok", stderr: "", exitCode: 0 });
  });

  const run = () =>
    runFanout("org-1", "user-1", {
      command: "uptime",
      targets: [{ kind: "account" as const, id: "acct-1" }],
    });

  it("dials the address the guard cleared, keeping the name for host-key trust", async () => {
    mockResolveSafeHost.mockResolvedValue("198.51.100.4");
    const [result] = await run();

    expect(result!.status).toBe("done");
    expect(mockResolveSafeHost).toHaveBeenCalledWith("box.example");
    // `config.host` is untouched: it is what the verifier keys trust by, and
    // what an operator sees in the results. Only the socket moves.
    expect(mockSshExecCapture).toHaveBeenCalledWith(
      "org-1",
      expect.objectContaining({ host: "box.example" }),
      "uptime",
      { dialAddress: "198.51.100.4" },
    );
  });

  it("refuses an account whose plugin is not a jump host", async () => {
    mockGetClientForAccount.mockResolvedValue({
      plugin: { manifest: { id: "other" } },
      client: {},
    });
    const [result] = await run();

    expect(result!.error).toBe("Account is not an SSH host");
    expect(mockSshExecCapture).not.toHaveBeenCalled();
  });

  it("blocks the host and never dials when the guard refuses", async () => {
    mockResolveSafeHost.mockRejectedValue(
      new Error("SSH host internal.local resolves to a blocked address (10.0.0.5)"),
    );
    const [result] = await run();

    expect(result).toMatchObject({ status: "blocked", label: "bastion" });
    expect(result!.error).toMatch(/blocked address/);
    expect(mockSshExecCapture).not.toHaveBeenCalled();
  });
});
