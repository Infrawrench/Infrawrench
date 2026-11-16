import { beforeEach, describe, expect, it, vi } from "vitest";
import { Effect } from "effect";
import type { CredentialField, RewriterContext } from "@infrawrench/plugin-base";

vi.mock("../rpc/client", async () => (await import("./fake-rpc")).fakeRpcClientModule);

import { applyCredentialRewriters } from "../credential-rewriters";
import { fakeRpc, resetFakeRpc } from "./fake-rpc";

const tunnel = vi.fn();

beforeEach(() => {
  resetFakeRpc();
  tunnel.mockReset();
  // The main process's answer: the marked values pointed at a tunnel on port 41000.
  tunnel.mockImplementation(({ credentials }: { credentials: Record<string, string> }) =>
    Object.fromEntries(
      Object.entries(credentials).map(([k, v]) => [
        k,
        v.replace("localhost:5432", "127.0.0.1:41000"),
      ]),
    ),
  );
  fakeRpc["SshTunnelAccountCredentials"] = (payload: unknown) => Effect.sync(() => tunnel(payload));
});

const field = (key: string, tunnelForm?: CredentialField["tunnel"]): CredentialField => ({
  key,
  label: key,
  sensitive: false,
  ...(tunnelForm ? { tunnel: tunnelForm } : {}),
});

describe("applyCredentialRewriters", () => {
  it("points the fields a plugin marked at the account's SSH tunnel", async () => {
    const ctx: RewriterContext = {
      accountId: "acc-1",
      credentialFields: [field("connectionString", "address"), field("caCert")],
    };
    const creds = {
      connectionString: "postgresql://localhost:5432/postgres",
      caCert: "localhost:5432",
    };
    await expect(applyCredentialRewriters(ctx, creds)).resolves.toBe(true);
    expect(creds).toEqual({
      connectionString: "postgresql://127.0.0.1:41000/postgres",
      caCert: "localhost:5432",
    });
    // Only the marked value crosses to the main process.
    expect(tunnel).toHaveBeenCalledWith({
      accountId: "acc-1",
      fields: [{ key: "connectionString", tunnel: "address" }],
      credentials: { connectionString: "postgresql://localhost:5432/postgres" },
    });
  });

  it("says so for a peer plugin's credentials", async () => {
    const ctx: RewriterContext = {
      accountId: "acc-1",
      credentialFields: [field("connectionString", "address")],
      peerPluginId: "postgres",
    };
    await applyCredentialRewriters(ctx, { connectionString: "postgresql://db:5432/app" });
    expect(tunnel).toHaveBeenCalledWith(expect.objectContaining({ peer: true }));
  });

  it("asks nothing when the plugin marks no field, or the marked field is unset", async () => {
    const creds = { token: "abc" };
    await expect(
      applyCredentialRewriters({ accountId: "acc-1", credentialFields: [field("token")] }, creds),
    ).resolves.toBe(false);
    await applyCredentialRewriters(
      { accountId: "acc-1", credentialFields: [field("dockerHost", "address")] },
      creds,
    );
    expect(tunnel).not.toHaveBeenCalled();
    expect(creds).toEqual({ token: "abc" });
  });

  it("reports no change for an account without a tunnel", async () => {
    tunnel.mockImplementation(({ credentials }: { credentials: object }) => credentials);
    const creds = { connectionString: "postgresql://db.internal:5432/app" };
    await expect(
      applyCredentialRewriters(
        { accountId: "acc-1", credentialFields: [field("connectionString", "address")] },
        creds,
      ),
    ).resolves.toBe(false);
    expect(creds).toEqual({ connectionString: "postgresql://db.internal:5432/app" });
  });
});
