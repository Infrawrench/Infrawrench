import { beforeEach, describe, expect, it, vi } from "vitest";

const rewriteCredentialsThroughTunnel = vi.fn(
  async (_acct: string, _creds: Record<string, string>) => undefined,
);
vi.mock("../tunnel-resolver", () => ({
  rewriteCredentialsThroughTunnel: (a: unknown, b: unknown) =>
    rewriteCredentialsThroughTunnel(a as string, b as Record<string, string>),
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

describe("what the SSH-tunnel rewriter changes", () => {
  it("is anything the URL parser takes or host:port, which includes a kubeconfig", async () => {
    const { tunnelRewrites, applyTunnelToConnectionString } =
      await import("../credential-rewriters/tunnel-form");
    expect(tunnelRewrites("postgres://u:p@db.internal:5432/app")).toBe(true);
    expect(tunnelRewrites("10.0.0.5:6379")).toBe(true);
    // The URL parser takes a kubeconfig's YAML as an opaque URL, so the
    // rewriter changes it (and breaks it): it is not lendable through a tunnel.
    const kubeconfig = "apiVersion: v1\nkind: Config\n";
    expect(applyTunnelToConnectionString(kubeconfig, 4000)).not.toBe(kubeconfig);
    expect(tunnelRewrites(kubeconfig)).toBe(true);
    // A bare token is left as it is.
    expect(tunnelRewrites("ya29.a0AfH6SMB")).toBe(false);
  });
});
