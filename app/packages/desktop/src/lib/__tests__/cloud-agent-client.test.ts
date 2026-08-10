import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("../invoke", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

let activeCloudOrgId: string | null = "org1";
vi.mock("@infrawrench/ui", () => ({
  useUIStore: { getState: () => ({ activeCloudOrgId }) },
}));

import { createCloudAgentClient } from "../cloud-agent-client";

beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue(undefined);
  activeCloudOrgId = "org1";
});

describe("createCloudAgentClient", () => {
  it("lists the org's agent-capable accounts, not this machine's", async () => {
    invoke.mockResolvedValue([
      { accountId: "a1", pluginId: "gcp", resourceTypeId: "gce-instance" },
    ]);
    const accounts = await createCloudAgentClient().listAccounts();
    expect(invoke).toHaveBeenCalledWith("cloud_agents_accounts", { orgId: "org1" });
    expect(accounts[0]?.pluginId).toBe("gcp");
  });

  it("routes settings, sessions and lifecycle calls through the org-scoped IPC", async () => {
    const client = createCloudAgentClient();

    await client.getSettings();
    expect(invoke).toHaveBeenCalledWith("cloud_agents_get_settings", { orgId: "org1" });

    const settings = {
      accountId: "a1",
      pluginId: "gcp",
      resourceTypeId: "gce-instance",
      tool: "claude-code" as const,
      surface: "t3-code" as const,
      fields: { zone: "us-central1-a" },
    };
    await client.saveSettings(settings);
    expect(invoke).toHaveBeenCalledWith("cloud_agents_save_settings", { orgId: "org1", settings });

    await client.listSessions();
    expect(invoke).toHaveBeenCalledWith("cloud_agents_list_sessions", { orgId: "org1" });

    const body = { repo: "https://github.com/o/r.git", settings };
    await client.createSession(body);
    expect(invoke).toHaveBeenCalledWith("cloud_agents_create_session", { orgId: "org1", body });

    await client.openSession("s1");
    expect(invoke).toHaveBeenCalledWith("cloud_agents_open_session", {
      orgId: "org1",
      sessionId: "s1",
    });

    await client.reconcileSession("s1");
    expect(invoke).toHaveBeenCalledWith("cloud_agents_reconcile_session", {
      orgId: "org1",
      sessionId: "s1",
    });

    await client.deleteSession("s1");
    expect(invoke).toHaveBeenCalledWith("cloud_agents_delete_session", {
      orgId: "org1",
      sessionId: "s1",
    });
  });

  // Constructing the client must not pin the org: the Agents tab stays mounted
  // across an org switch, and a pinned id would keep driving the old org.
  it("resolves the active org per call, not at construction", async () => {
    const client = createCloudAgentClient();
    await client.listSessions();
    expect(invoke).toHaveBeenLastCalledWith("cloud_agents_list_sessions", { orgId: "org1" });

    activeCloudOrgId = "org2";
    await client.listSessions();
    expect(invoke).toHaveBeenLastCalledWith("cloud_agents_list_sessions", { orgId: "org2" });
  });

  it("refuses to call the cloud with no org selected", async () => {
    activeCloudOrgId = null;
    await expect(createCloudAgentClient().listAccounts()).rejects.toThrow(/organization/i);
    expect(invoke).not.toHaveBeenCalled();
  });

  // Local sessions can be a folder on this machine; cloud sessions cannot —
  // the server-side pipeline has no access to it.
  it("offers no local-folder picker", () => {
    expect(createCloudAgentClient().pickLocalRepoPath).toBeUndefined();
  });
});
