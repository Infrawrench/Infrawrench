import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { buildTestApp } from "./test-utils";

const run = vi.fn();
const list = vi.fn();
const freeze = vi.fn();
const audit = vi.fn();
vi.mock("@/services/ssh-install", () => ({
  runSshInstall: (...args: unknown[]) => run(...args),
  listSshInstallAccounts: (...args: unknown[]) => list(...args),
}));
vi.mock("@/services/change-freezes", () => ({
  checkChangeFreeze: (...args: unknown[]) => freeze(...args),
}));
vi.mock("@/services/audit", () => ({ logAudit: (...args: unknown[]) => audit(...args) }));
class TrustError extends Error {}
vi.mock("@/services/ssh-host-keys", () => ({ HostKeyTrustRequiredError: TrustError }));
vi.mock("../ssh-host-keys", () => ({
  hostKeyTrustResponse: () =>
    new Response(JSON.stringify({ error: "ssh_host_key_trust_required" }), { status: 409 }),
}));
const { registerSshInstallRoutes } = await import("../resource-detail/ssh-install");
const routes = new Hono();
registerSshInstallRoutes(routes);
const input = {
  installerAccountId: "tailscale-account",
  target: {
    accountId: "ssh-account",
    resourceTypeId: "ssh-target",
    resourceId: "ssh-account:ssh-target:host",
  },
};
function post(permissions = ["*"], body: unknown = input) {
  return buildTestApp(routes, permissions).request("/ssh-install", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  freeze.mockResolvedValue(null);
  run.mockResolvedValue({ message: "Installed", address: "100.64.0.1" });
  list.mockResolvedValue([]);
});
describe("SSH service install routes", () => {
  it.each(["resources:read", "resources:write", "resources:execute"])(
    "requires write and execute permissions (%s)",
    async (permissions) => {
      expect((await post([permissions])).status).toBe(403);
      expect(run).not.toHaveBeenCalled();
    },
  );
  it("scopes both operations to the authenticated organization and audits only identifiers", async () => {
    const response = await post(["resources:write", "resources:execute"]);
    expect(response.status).toBe(200);
    expect(run).toHaveBeenCalledWith("org-1", input);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "org-1",
        metadata: {
          installerAccountId: input.installerAccountId,
          targetAccountId: input.target.accountId,
          success: true,
        },
      }),
    );
  });
  it("does not execute during a change freeze", async () => {
    freeze.mockResolvedValue(new Response("Frozen", { status: 423 }));
    expect((await post()).status).toBe(423);
    expect(run).not.toHaveBeenCalled();
  });
  it.each([
    { ...input, command: "arbitrary command" },
    { ...input, organizationId: "other-org" },
    { ...input, port: 65536 },
    { ...input, target: { ...input.target, host: "127.0.0.1" } },
  ])("rejects extra transport controls and invalid input", async (body) => {
    expect((await post(["*"], body)).status).toBe(400);
    expect(run).not.toHaveBeenCalled();
  });
  it("keeps the structured SSH host-key trust response", async () => {
    run.mockRejectedValue(new TrustError("Unknown host"));
    const response = await post();
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "ssh_host_key_trust_required" });
  });
  it("lists only within the authenticated org", async () => {
    expect(
      (await buildTestApp(routes, ["resources:read"]).request("/ssh-install/accounts")).status,
    ).toBe(200);
    expect(list).toHaveBeenCalledWith("org-1");
  });
});
