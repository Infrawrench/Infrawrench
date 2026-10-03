import { describe, it, expect, vi } from "vitest";
import { plugin } from "../plugin.js";
import { pluginManifestSchema } from "@infrawrench/plugin-base";
import { runPluginContractTests } from "@infrawrench/plugin-base/test-harness";

runPluginContractTests(plugin);

const device = {
  id: "123",
  nodeId: "node-1",
  name: "web.tail.example",
  hostname: "web",
  addresses: ["fd7a::1", "100.64.0.1"],
  authorized: true,
  connectedToControl: true,
  os: "linux",
  clientVersion: "1.90.0",
};
function client() {
  const request = vi
    .fn()
    .mockResolvedValue({ status: 200, body: JSON.stringify({ devices: [device] }) });
  return {
    request,
    client: plugin.createClient({ apiKey: "tskey-api-secret" }, { http: { request } }),
  };
}
describe("Tailscale plugin", () => {
  it("has a valid manifest and declares cross-provider SSH enrollment", () => {
    expect(pluginManifestSchema.safeParse(plugin.manifest).success).toBe(true);
    expect(plugin.manifest.sshInstall).toBeDefined();
  });
  it("lists the token's tailnet using the host transport and stable node IDs", async () => {
    const { request, client: c } = client();
    const rows = await c.listResources("device", "acct");
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://api.tailscale.com/api/v2/tailnet/-/devices?fields=all",
        headers: expect.objectContaining({ Authorization: "Bearer tskey-api-secret" }),
      }),
    );
    expect(rows[0]).toMatchObject({
      id: "acct:device:node-1",
      resolvedOutputs: { ip: "100.64.0.1", dnsName: "web.tail.example" },
    });
    expect(JSON.stringify(rows)).not.toContain("tskey");
  });
  it("renames a device and re-reads its provider state", async () => {
    const { request, client: c } = client();
    await c.updateResource!("device", "acct:device:node-1", "acct", { name: "new-name" });
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://api.tailscale.com/api/v2/device/node-1/name",
        method: "POST",
        body: JSON.stringify({ name: "new-name" }),
      }),
    );
  });
  it("does not mutate an ID outside the selected account's device list", async () => {
    const { request, client: c } = client();
    await expect(c.deleteResource!("device", "other:device:node-1", "acct")).rejects.toThrow(
      "not found",
    );
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("uses documented approval and expiry endpoints", async () => {
    const { request, client: c } = client();
    await c.invokeAction!("device", "acct:device:node-1", "approve", "acct");
    await c.invokeAction!("device", "acct:device:node-1", "expire", "acct");
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://api.tailscale.com/api/v2/device/node-1/authorized",
        body: '{"authorized":true}',
      }),
    );
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://api.tailscale.com/api/v2/device/node-1/expire",
        method: "POST",
      }),
    );
  });
  it("mints only a short-lived, single-use, pre-approved key", async () => {
    const { request, client: c } = client();
    request
      .mockResolvedValueOnce({
        status: 200,
        body: JSON.stringify({ id: "key-1", key: "tskey-auth-one-use" }),
      })
      .mockResolvedValueOnce({ status: 204, body: "" });
    const status = (BackendState: string) =>
      `__INFRAWRENCH_TAILSCALE_STATUS__\n${JSON.stringify({ BackendState })}`;
    const exec = vi
      .fn()
      .mockResolvedValueOnce(status("NeedsLogin"))
      .mockResolvedValueOnce(status("NeedsMachineAuth"));
    await c.installOnSsh!({ exec });
    const create = request.mock.calls[0]![0];
    expect(JSON.parse(create.body)).toEqual({
      capabilities: {
        devices: { create: { reusable: false, ephemeral: false, preauthorized: true } },
      },
      expirySeconds: 300,
      description: "Infrawrench server enrollment",
    });
    expect(exec.mock.calls.flat().join()).not.toContain("tskey-api-secret");
    expect(request.mock.calls[1]![0]).toMatchObject({
      method: "DELETE",
      url: "https://api.tailscale.com/api/v2/tailnet/-/keys/key-1",
    });
  });
  it("approves a device still awaiting approval through the device API", async () => {
    const { request, client: c } = client();
    request
      .mockResolvedValueOnce({
        status: 200,
        body: JSON.stringify({ id: "key-1", key: "tskey-auth-one-use" }),
      })
      .mockResolvedValueOnce({
        status: 200,
        body: JSON.stringify({
          devices: [{ id: "123", nodeId: "nNode1", name: "a", hostname: "a", addresses: [] }],
        }),
      })
      .mockResolvedValueOnce({ status: 200, body: "" })
      .mockResolvedValueOnce({ status: 204, body: "" });
    const exec = vi
      .fn()
      .mockResolvedValueOnce(`__INFRAWRENCH_TAILSCALE_STATUS__\n{"BackendState":"NeedsLogin"}`)
      .mockResolvedValueOnce(
        `__INFRAWRENCH_TAILSCALE_STATUS__\n{"BackendState":"NeedsMachineAuth","Self":{"ID":"nNode1"}}`,
      );
    const result = await c.installOnSsh!({ exec });
    expect(request.mock.calls[2]![0]).toMatchObject({
      method: "POST",
      url: "https://api.tailscale.com/api/v2/device/nNode1/authorized",
    });
    expect(JSON.parse(request.mock.calls[2]![0].body)).toEqual({ authorized: true });
    expect(result.message).toContain("approved");
  });
  it("releases an enrolled server by removing its device, tolerating one already gone", async () => {
    const { request, client: c } = client();
    const list = {
      status: 200,
      body: JSON.stringify({
        devices: [{ id: "123", nodeId: "nNode1", name: "a", hostname: "a", addresses: [] }],
      }),
    };
    request.mockResolvedValueOnce(list).mockResolvedValueOnce({ status: 200, body: "" });
    await c.releaseSshInstall!("nNode1");
    expect(request.mock.calls[1]![0]).toMatchObject({
      method: "DELETE",
      url: "https://api.tailscale.com/api/v2/device/nNode1",
    });
    request.mockReset().mockResolvedValueOnce(list);
    await c.releaseSshInstall!("nGone");
    expect(request).toHaveBeenCalledTimes(1);
  });
});
