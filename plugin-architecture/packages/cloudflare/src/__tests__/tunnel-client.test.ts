import { describe, it, expect, vi } from "vitest";
import {
  listTunnels,
  createTunnel,
  deleteTunnel,
  getTunnelToken,
  setTunnelIngress,
  exportTunnelCredential,
} from "../clients/tunnel-client.js";
import { makeApi, asyncIter } from "./_helpers.js";

const TUNNEL = {
  id: "t1",
  name: "ssh-tunnel",
  status: "healthy",
  tun_type: "cfd_tunnel",
  remote_config: true,
  connections: [{ id: "c1" }],
  created_at: "2020-01-01T00:00:00Z",
};

function tunnelApi(over: Record<string, unknown> = {}) {
  const cloudflared = {
    list: vi.fn(() => asyncIter([TUNNEL])),
    create: vi.fn(async () => TUNNEL),
    delete: vi.fn(async () => undefined),
    token: { get: vi.fn(async () => "run-token") },
  };
  return makeApi({
    cf: { zeroTrust: { tunnels: { cloudflared } }, put: vi.fn(async () => ({})) },
    ...over,
  });
}

describe("tunnel-client", () => {
  it("listTunnels maps tunnels and excludes soft-deleted", async () => {
    const api = tunnelApi({
      cf: {
        zeroTrust: {
          tunnels: {
            cloudflared: {
              list: vi.fn(() => asyncIter([TUNNEL, { id: "t2", deleted_at: "2021-01-01" }])),
            },
          },
        },
      },
    });
    const out = await listTunnels(api, "acct");
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe("acct:tunnel:t1");
    expect(out[0].fields.status).toBe("healthy");
    expect(out[0].fields.connectionsCount).toBe(1);
    expect(out[0].resolvedOutputs?.tunnelId).toBe("t1");
  });

  it("listTunnels derives status from connections when absent", async () => {
    const api = tunnelApi({
      cf: {
        zeroTrust: {
          tunnels: {
            cloudflared: {
              list: vi.fn(() => asyncIter([{ id: "t3", name: "n", connections: [] }])),
            },
          },
        },
      },
    });
    const out = await listTunnels(api, "acct");
    expect(out[0].fields.status).toBe("inactive");
  });

  it("createTunnel sends a name and generated secret", async () => {
    const api = tunnelApi();
    await createTunnel(api, "acct", { name: "ssh-tunnel" });
    const call = (api.cf.zeroTrust.tunnels.cloudflared.create as ReturnType<typeof vi.fn>).mock
      .calls[0][0];
    expect(call.name).toBe("ssh-tunnel");
    expect(typeof call.tunnel_secret).toBe("string");
    expect(call.account_id).toBe("acct-cf");
  });

  it("deleteTunnel calls delete", async () => {
    const api = tunnelApi();
    await deleteTunnel(api, "t1");
    expect(api.cf.zeroTrust.tunnels.cloudflared.delete).toHaveBeenCalledWith("t1", {
      account_id: "acct-cf",
    });
  });

  it("getTunnelToken returns the run token", async () => {
    const api = tunnelApi();
    expect(await getTunnelToken(api, "t1")).toBe("run-token");
    expect(api.cf.zeroTrust.tunnels.cloudflared.token.get).toHaveBeenCalledWith("t1", {
      account_id: "acct-cf",
    });
  });

  it("setTunnelIngress PUTs an ingress config with catch-all", async () => {
    const api = tunnelApi();
    await setTunnelIngress(api, "t1", "ssh.a.com", "ssh://localhost:22");
    expect(api.cf.put).toHaveBeenCalledWith(
      "/accounts/acct-cf/cfd_tunnel/t1/configurations",
      expect.objectContaining({
        body: {
          config: {
            ingress: [
              { hostname: "ssh.a.com", service: "ssh://localhost:22" },
              { service: "http_status:404" },
            ],
          },
        },
      }),
    );
  });

  it("exportTunnelCredential builds a credential export", async () => {
    const api = tunnelApi();
    const out = await exportTunnelCredential(api, {
      externalId: "t1",
      fields: { name: "ssh-tunnel" },
    } as never);
    expect(out.content).toBe("run-token");
    expect(out.filename).toBe("ssh-tunnel.token");
    expect(out.fields.find((f) => f.label === "Run Token")?.sensitive).toBe(true);
  });
});
