import { beforeEach, describe, expect, it, vi } from "vitest";

const rewriteCredentialsThroughTunnel = vi.fn(async () => undefined);
vi.mock("../tunnel-resolver", () => ({
  rewriteCredentialsThroughTunnel: (...a: unknown[]) => rewriteCredentialsThroughTunnel(...a),
}));

let mod: typeof import("../credential-rewriters/index");
let sshTunnel: typeof import("../credential-rewriters/ssh-tunnel");

beforeEach(async () => {
  vi.clearAllMocks();
  vi.resetModules();
  mod = await import("../credential-rewriters/index");
  sshTunnel = await import("../credential-rewriters/ssh-tunnel");
});

describe("sshTunnelRewriter", () => {
  it("delegates to rewriteCredentialsThroughTunnel with the account id and creds", async () => {
    const creds = { url: "x" };
    await sshTunnel.sshTunnelRewriter.rewrite({ accountId: "a1" } as never, creds);
    expect(rewriteCredentialsThroughTunnel).toHaveBeenCalledWith("a1", creds);
  });
});

describe("applyCredentialRewriters", () => {
  it("runs the default (ssh-tunnel) rewriter", async () => {
    const creds = { url: "y" };
    await mod.applyCredentialRewriters({ accountId: "a2" } as never, creds);
    expect(rewriteCredentialsThroughTunnel).toHaveBeenCalledWith("a2", creds);
  });

  it("runs registered rewriters in order, after the built-ins", async () => {
    const calls: string[] = [];
    rewriteCredentialsThroughTunnel.mockImplementation(async () => {
      calls.push("ssh-tunnel");
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
    rewriteCredentialsThroughTunnel.mockImplementation(
      async (_acct: string, creds: Record<string, string>) => {
        creds["step"] = "1";
      },
    );
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
