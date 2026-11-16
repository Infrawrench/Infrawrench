import { beforeEach, describe, expect, it, vi } from "vitest";

const rewriteCredentialsThroughTunnel = vi.fn(
  async (
    _acct: string,
    _fields: unknown,
    _creds: Record<string, string>,
    _options: { peer?: boolean },
  ): Promise<string[]> => [],
);
vi.mock("../tunnel-resolver", () => ({
  rewriteCredentialsThroughTunnel: (a: unknown, f: unknown, b: unknown, o: unknown) =>
    rewriteCredentialsThroughTunnel(
      a as string,
      f,
      b as Record<string, string>,
      o as { peer?: boolean },
    ),
}));

const fields = [{ key: "url", label: "URL", sensitive: false, tunnel: "address" as const }];

let mod: typeof import("../credential-rewriters/index");
let sshTunnel: typeof import("../credential-rewriters/ssh-tunnel");

beforeEach(async () => {
  vi.clearAllMocks();
  vi.resetModules();
  mod = await import("../credential-rewriters/index");
  sshTunnel = await import("../credential-rewriters/ssh-tunnel");
});

describe("sshTunnelRewriter", () => {
  it("delegates with the account id, the plugin's fields and the creds", async () => {
    const creds = { url: "x" };
    await sshTunnel.sshTunnelRewriter.rewrite({ accountId: "a1", credentialFields: fields }, creds);
    expect(rewriteCredentialsThroughTunnel).toHaveBeenCalledWith("a1", fields, creds, {
      peer: false,
    });
  });

  it("tells it when the credentials are a peer plugin's", async () => {
    const creds = { url: "x" };
    await sshTunnel.sshTunnelRewriter.rewrite(
      { accountId: "a1", credentialFields: fields, peerPluginId: "postgres" },
      creds,
    );
    expect(rewriteCredentialsThroughTunnel).toHaveBeenCalledWith("a1", fields, creds, {
      peer: true,
    });
  });
});

describe("applyCredentialRewriters", () => {
  it("runs the default (ssh-tunnel) rewriter", async () => {
    const creds = { url: "y" };
    await mod.applyCredentialRewriters({ accountId: "a2", credentialFields: fields }, creds);
    expect(rewriteCredentialsThroughTunnel).toHaveBeenCalledWith("a2", fields, creds, {
      peer: false,
    });
  });

  it("says whether the chain changed anything", async () => {
    const ctx = { accountId: "a5", credentialFields: fields };
    expect(await mod.applyCredentialRewriters(ctx, { url: "redis://cache:6379" })).toBe(false);
    rewriteCredentialsThroughTunnel.mockImplementation(async (_a, _f, creds) => {
      creds["url"] = "redis://127.0.0.1:4000";
      return ["url"];
    });
    expect(await mod.applyCredentialRewriters(ctx, { url: "redis://cache:6379" })).toBe(true);
  });

  it("runs registered rewriters in order, after the built-ins", async () => {
    const calls: string[] = [];
    rewriteCredentialsThroughTunnel.mockImplementation(async () => {
      calls.push("ssh-tunnel");
      return [];
    });
    mod.registerCredentialRewriter({
      rewrite: async () => {
        calls.push("custom-1");
      },
    });
    mod.registerCredentialRewriter({
      rewrite: async () => {
        calls.push("custom-2");
      },
    });
    await mod.applyCredentialRewriters({ accountId: "a3" } as never, {});
    expect(calls).toEqual(["ssh-tunnel", "custom-1", "custom-2"]);
  });

  it("awaits each rewriter (sees mutations from earlier ones)", async () => {
    rewriteCredentialsThroughTunnel.mockImplementation(async (_acct, _fields, creds) => {
      creds["step"] = "1";
      return ["step"];
    });
    let observed: string | undefined;
    mod.registerCredentialRewriter({
      rewrite: async (_ctx, creds) => {
        observed = creds["step"];
      },
    });
    await mod.applyCredentialRewriters({ accountId: "a4" } as never, {});
    expect(observed).toBe("1");
  });
});
