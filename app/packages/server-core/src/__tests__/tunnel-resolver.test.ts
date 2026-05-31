import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";

process.env["ENCRYPTION_MASTER_KEY"] = randomBytes(32).toString("base64");

// --- mock the DB client (importing the real one throws without DATABASE_URL) ---
const selectResult: { rows: unknown[] } = { rows: [] };
const dbSelect = vi.fn(() => ({
  from: () => ({
    where: () => ({
      limit: () => Promise.resolve(selectResult.rows),
    }),
  }),
}));
vi.mock("../db/client", () => ({ db: { select: dbSelect } }));
vi.mock("../db/schema", () => ({ sshTunnelConfigs: { accountId: "accountId" } }));

// --- mock ssh-tunnel-core (real module pulls in ssh2 which breaks ESM import) ---
const findTunnel = vi.fn();
const openTunnel = vi.fn();
vi.mock("@infrawrench/ssh-tunnel-core", () => ({
  findTunnel: (...a: unknown[]) => findTunnel(...a),
  openTunnel: (...a: unknown[]) => openTunnel(...a),
}));

let rewriteCredentialsThroughTunnel: typeof import("../tunnel-resolver").rewriteCredentialsThroughTunnel;
let rewriteConnectionForTunnel: typeof import("../tunnel-resolver").rewriteConnectionForTunnel;

beforeEach(async () => {
  vi.clearAllMocks();
  selectResult.rows = [];
  const mod = await import("../tunnel-resolver");
  rewriteCredentialsThroughTunnel = mod.rewriteCredentialsThroughTunnel;
  rewriteConnectionForTunnel = mod.rewriteConnectionForTunnel;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("rewriteConnectionForTunnel", () => {
  it("returns the original string when no tunnel exists (existing + no config)", async () => {
    findTunnel.mockReturnValue(null);
    selectResult.rows = []; // no ssh_tunnel_configs row
    const out = await rewriteConnectionForTunnel("acct1", "postgres://u:p@db.example.com:5432/app");
    expect(out).toBe("postgres://u:p@db.example.com:5432/app");
  });

  it("rewrites a URL connection string to 127.0.0.1:<localPort> when an existing tunnel is found", async () => {
    findTunnel.mockReturnValue({ localPort: 15432, extras: { accountId: "acct1" } });
    const out = await rewriteConnectionForTunnel("acct1", "postgres://u:p@db.example.com:5432/app");
    expect(out).toBe("postgres://u:p@127.0.0.1:15432/app");
  });

  it("rewrites a tcp:// URL to 127.0.0.1:<localPort>", async () => {
    findTunnel.mockReturnValue({ localPort: 16000, extras: { accountId: "acct1" } });
    const out = await rewriteConnectionForTunnel("acct1", "tcp://db.internal:5432");
    expect(out).toBe("tcp://127.0.0.1:16000");
  });

  it("rewrites a bare ip:port string via the regex fallback", async () => {
    findTunnel.mockReturnValue({ localPort: 16000, extras: { accountId: "acct1" } });
    // "1.2.3.4:5432" is not a valid WHATWG URL (a scheme can't start with a
    // digit, so the URL ctor throws) and falls through to the host:port regex.
    const out = await rewriteConnectionForTunnel("acct1", "1.2.3.4:5432");
    expect(out).toBe("127.0.0.1:16000");
  });

  it("leaves a non-URL, non-host:port string untouched", async () => {
    findTunnel.mockReturnValue({ localPort: 16000, extras: { accountId: "acct1" } });
    const out = await rewriteConnectionForTunnel("acct1", "just-a-plain-value");
    expect(out).toBe("just-a-plain-value");
  });

  it("swallows resolution errors and returns the original string", async () => {
    findTunnel.mockImplementation(() => {
      throw new Error("registry exploded");
    });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const out = await rewriteConnectionForTunnel("acct1", "tcp://x:1");
    expect(out).toBe("tcp://x:1");
    expect(spy).toHaveBeenCalled();
  });
});

describe("rewriteCredentialsThroughTunnel", () => {
  it("is a no-op when no tunnel is configured", async () => {
    findTunnel.mockReturnValue(null);
    selectResult.rows = [];
    const creds = { url: "redis://host:6379", other: "x:1" };
    await rewriteCredentialsThroughTunnel("acct1", creds);
    expect(creds).toEqual({ url: "redis://host:6379", other: "x:1" });
  });

  it("rewrites every credential value through the tunnel port", async () => {
    findTunnel.mockReturnValue({ localPort: 25432, extras: { accountId: "acct1" } });
    const creds = { url: "redis://host:6379", host: "1.2.3.4:6380" };
    await rewriteCredentialsThroughTunnel("acct1", creds);
    expect(creds.url).toBe("redis://127.0.0.1:25432");
    expect(creds.host).toBe("127.0.0.1:25432");
  });
});
