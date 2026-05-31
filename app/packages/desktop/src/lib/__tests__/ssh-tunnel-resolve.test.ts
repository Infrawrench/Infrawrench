import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
const select = vi.fn();
const execute = vi.fn();

vi.mock("../invoke", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("../../db/client", () => ({
  getDb: () => Promise.resolve({ select, execute }),
}));

import { resolveTunneledHost } from "../ssh-tunnel";

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
    invoke.mockResolvedValueOnce({
      t1: { localPort: 6001, sshHost: "bastion", remotePort: 5432 },
    });
    const res = await resolveTunneledHost("acc1", "rawhost");
    expect(res).toBe("tcp://127.0.0.1:6001");
    // only the active-tunnels lookup invoke happened; no open-tunnel invoke
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("ssh_get_active_tunnels");
  });

  it("opens a new tunnel when none is active", async () => {
    select.mockResolvedValueOnce([tunnelRow]);
    invoke
      .mockResolvedValueOnce({}) // ssh_get_active_tunnels -> none
      .mockResolvedValueOnce("decrypted-key") // ssh_tunnel_config_get_private_key
      .mockResolvedValueOnce({ tunnelId: "newt", localPort: 7002 }); // ssh_open_tunnel
    const res = await resolveTunneledHost("acc1", "rawhost");
    expect(res).toBe("tcp://127.0.0.1:7002");
    expect(invoke).toHaveBeenCalledWith("ssh_tunnel_config_get_private_key", {
      tunnelConfigId: "tc1",
      ciphertext: "cipher",
      iv: "iv",
    });
    expect(invoke).toHaveBeenCalledWith("ssh_open_tunnel", {
      sshHost: "bastion",
      sshPort: 22,
      sshUser: "u",
      privateKey: "decrypted-key",
      remoteHost: "db.internal",
      remotePort: 5432,
    });
  });
});
