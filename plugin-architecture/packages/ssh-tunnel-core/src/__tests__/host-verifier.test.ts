import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import type { ConnectConfig } from "ssh2";

const connectMock = vi.fn();
const endMock = vi.fn();

class FakeSshClient extends EventEmitter {
  connect = connectMock;
  end = endMock;
}

vi.mock("ssh2", () => ({
  Client: vi.fn(function () {
    return new FakeSshClient();
  }),
  // The shared `in-process-agent.ts` (re-exported from index) imports
  // `BaseAgent` and `utils.parseKey`. They're not exercised by this suite,
  // but the module's top-level `import { utils }` evaluates eagerly.
  BaseAgent: class {},
  utils: { parseKey: vi.fn() },
}));

import { openTunnel } from "../index.js";

const baseConfig = {
  sshHost: "ssh.example.com",
  sshPort: 22,
  sshUser: "ubuntu",
  privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nfake\n-----END OPENSSH PRIVATE KEY-----\n",
  remoteHost: "10.0.0.5",
  remotePort: 5432,
};

describe("openTunnel host-key verifier", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("installs a fail-closed hostVerifier when no configureConnect is provided", () => {
    void openTunnel(baseConfig, undefined).catch(() => {
      /* ignored — we never resolve in the mock */
    });

    expect(connectMock).toHaveBeenCalledTimes(1);
    const opts = connectMock.mock.calls[0]![0] as ConnectConfig;
    expect(typeof opts.hostVerifier).toBe("function");
    // Casting because the union of host-verifier shapes makes the call type wide.
    const verifier = opts.hostVerifier as (key: Buffer) => boolean;
    expect(() => verifier(Buffer.from("fake-key"))).toThrow(/no SSH host-key verifier configured/);
  });

  it("calls configureConnect so callers can install their own verifier", () => {
    const customVerifier = vi.fn(() => true);
    const configureConnect = vi.fn(
      (opts: ConnectConfig): ConnectConfig => ({
        ...opts,
        hostVerifier: customVerifier,
      }),
    );

    void openTunnel(baseConfig, undefined, { configureConnect }).catch(() => {
      /* ignored */
    });

    expect(configureConnect).toHaveBeenCalledTimes(1);
    expect(connectMock).toHaveBeenCalledTimes(1);
    const opts = connectMock.mock.calls[0]![0] as ConnectConfig;
    expect(opts.hostVerifier).toBe(customVerifier);
  });

  it("rejects when the SSH client errors (e.g. host-key verification failure)", async () => {
    const { Client } = await import("ssh2");
    let createdClient: FakeSshClient | undefined;
    vi.mocked(Client).mockImplementationOnce(function () {
      const c = new FakeSshClient();
      createdClient = c;
      return c as unknown as InstanceType<typeof Client>;
    });

    const promise = openTunnel(baseConfig, undefined);
    // Simulate ssh2 emitting an error after connect() — what happens when our
    // fail-closed verifier rejects the key.
    queueMicrotask(() => {
      createdClient?.emit("error", new Error("Host key verification failed"));
    });

    await expect(promise).rejects.toThrow(/Host key verification failed/);
  });
});
