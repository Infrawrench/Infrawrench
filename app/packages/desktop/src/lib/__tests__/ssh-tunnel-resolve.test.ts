import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
const select = vi.fn();
const execute = vi.fn();

vi.mock("../invoke", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("../rpc/client", async () => (await import("./fake-rpc")).fakeRpcClientModule);
vi.mock("../../db/client", () => ({
  getDb: () => Promise.resolve({ select, execute }),
}));

import { Effect } from "effect";
import { resolveTunneledHost } from "../ssh-tunnel";
import { fakeRpc, resetFakeRpc } from "./fake-rpc";

/** Answer `tag` with `value`, recording each payload. */
function answer(tag: string, value: unknown) {
  const calls: unknown[] = [];
  fakeRpc[tag] = (payload: unknown) => {
    calls.push(payload);
    return Effect.succeed(value);
  };
  return calls;
}

const tunnelRow = {
  id: "tc1",
  ssh_host: "bastion",
  ssh_port: 22,
  ssh_user: "u",
  remote_host: "db.internal",
  remote_port: 5432,
  encrypted_private_key: "cipher",
  private_key_iv: "iv",
};

beforeEach(() => {
  resetFakeRpc();
  invoke.mockReset();
  select.mockReset();
  execute.mockReset();
});

describe("resolveTunneledHost", () => {
  it("returns the raw host unchanged when no tunnel config exists", async () => {
    select.mockResolvedValueOnce([]); // ssh_tunnel_configs lookup
    const res = await resolveTunneledHost("acc1", "rawhost:5432");
    expect(res).toBe("rawhost:5432");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("reuses an existing active tunnel matching host+remotePort", async () => {
    select.mockResolvedValueOnce([tunnelRow]);
    const active = answer("SshTunnelsActive", {
      t1: { localPort: 6001, sshHost: "bastion", remotePort: 5432 },
    });
    const opened = answer("SshTunnelOpen", { tunnelId: "unused", localPort: 1 });
    const res = await resolveTunneledHost("acc1", "rawhost");
    expect(res).toBe("tcp://127.0.0.1:6001");
    // only the active-tunnels lookup happened: no key decrypted, no tunnel opened
    expect(active).toHaveLength(1);
    expect(opened).toEqual([]);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("opens a new tunnel when none is active", async () => {
    select.mockResolvedValueOnce([tunnelRow]);
    answer("SshTunnelsActive", {});
    invoke.mockResolvedValueOnce("decrypted-key"); // ssh_tunnel_config_get_private_key
    const opened = answer("SshTunnelOpen", { tunnelId: "newt", localPort: 7002 });
    const res = await resolveTunneledHost("acc1", "rawhost");
    expect(res).toBe("tcp://127.0.0.1:7002");
    expect(invoke).toHaveBeenCalledWith("ssh_tunnel_config_get_private_key", {
      tunnelConfigId: "tc1",
      ciphertext: "cipher",
      iv: "iv",
    });
    expect(opened).toEqual([
      {
        sshHost: "bastion",
        sshPort: 22,
        sshUser: "u",
        privateKey: "decrypted-key",
        remoteHost: "db.internal",
        remotePort: 5432,
      },
    ]);
  });
});
