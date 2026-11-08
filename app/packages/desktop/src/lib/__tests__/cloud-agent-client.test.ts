import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudHttpRequest } from "../../../shared/rpc/groups/cloud-http";

vi.mock("../rpc/client", async () => (await import("./fake-rpc")).fakeRpcClientModule);
vi.mock("../rpc/desktop-client", async () => (await import("./fake-rpc")).fakeRpcClientModule);

const invoke = vi.fn();
vi.mock("../invoke", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

let activeCloudOrgId: string | null = "org1";
vi.mock("@infrawrench/ui", () => ({
  useUIStore: { getState: () => ({ activeCloudOrgId }) },
}));

const { answerCloudHttp, resetFakeRpc } = await import("./fake-rpc");
const { createCloudAgentClient } = await import("../cloud-agent-client");

const SESSION = {
  id: "s1",
  repo: "https://github.com/o/r.git",
  t3Policy: { schemaVersion: 1, organization: "Acme", settings: { "a.b": { locked: true } } },
};

/** What each route answers, enough for the client to hand on. */
function answer(request: CloudHttpRequest): { status: number; json?: unknown } {
  const path = request.url.replace(/^\/api\/org\/[^/]+\/agents/, "");
  if (path === "/accounts") return { status: 200, json: [{ accountId: "a1", pluginId: "gcp" }] };
  if (path === "/settings")
    return { status: 200, json: request.body ? JSON.parse(request.body) : null };
  if (path === "/sessions")
    return { status: 200, json: request.method === "GET" ? [SESSION] : SESSION };
  if (path.endsWith("/open")) return { status: 200, json: { command: "claude", cwd: "/w" } };
  if (path.endsWith("/reconcile")) return { status: 200, json: { branchName: "b", message: "m" } };
  if (path === "/t3-policy/apply") return { status: 200, json: { results: [] } };
  if (path === "/link-scopes") return { status: 200, json: { scopes: ["resources:read"] } };
  return { status: 200, json: { ok: true } };
}

const sent = (http: ReturnType<typeof answerCloudHttp>) =>
  http.mock.calls.map(([request]) => ({
    method: request.method,
    url: request.url,
    ...(request.body !== undefined ? { body: JSON.parse(request.body) } : {}),
  }));

beforeEach(() => {
  resetFakeRpc();
  invoke.mockReset();
  activeCloudOrgId = "org1";
});

describe("createCloudAgentClient", () => {
  it("lists the org's agent-capable accounts, not this machine's", async () => {
    const http = answerCloudHttp(answer);
    const accounts = await createCloudAgentClient().listAccounts();
    expect(http).toHaveBeenCalledWith({ method: "GET", url: "/api/org/org1/agents/accounts" });
    expect(accounts[0]?.pluginId).toBe("gcp");
  });

  it("reads the scopes an agent link could carry", async () => {
    answerCloudHttp(answer);
    await expect(createCloudAgentClient().listLinkableScopes?.()).resolves.toEqual([
      "resources:read",
    ]);
  });

  it("routes settings, sessions and lifecycle calls through the org-scoped routes", async () => {
    const http = answerCloudHttp(answer);
    const client = createCloudAgentClient();

    await client.getSettings();

    const settings = {
      accountId: "a1",
      pluginId: "gcp",
      resourceTypeId: "gce-instance",
      tool: "claude-code" as const,
      surface: "t3-code" as const,
      fields: { zone: "us-central1-a" },
    };
    await client.saveSettings(settings);
    await client.listSessions();
    const body = { repo: "https://github.com/o/r.git", settings };
    await client.createSession(body);
    await client.openSession("s1");
    await client.reconcileSession("s1");
    await client.applyT3Policy?.({ restart: false, sessionId: "s1" });
    await client.deleteSession("s1");

    expect(sent(http)).toEqual([
      { method: "GET", url: "/api/org/org1/agents/settings" },
      { method: "PUT", url: "/api/org/org1/agents/settings", body: settings },
      { method: "GET", url: "/api/org/org1/agents/sessions" },
      { method: "POST", url: "/api/org/org1/agents/sessions", body },
      { method: "POST", url: "/api/org/org1/agents/sessions/s1/open" },
      { method: "POST", url: "/api/org/org1/agents/sessions/s1/reconcile" },
      {
        method: "POST",
        url: "/api/org/org1/agents/t3-policy/apply",
        body: { restart: false, sessionId: "s1" },
      },
      { method: "DELETE", url: "/api/org/org1/agents/sessions/s1" },
    ]);
  });

  // The server omits `value` for a setting written without one; the panel's
  // type has the key, holding `undefined`.
  it("hands a session's T3 Code policy on with every setting's value key present", async () => {
    answerCloudHttp(answer);
    const [session] = await createCloudAgentClient().listSessions();
    const setting = session?.t3Policy?.settings?.["a.b"];
    expect(setting).toEqual({ value: undefined, locked: true });
    expect(setting && "value" in setting).toBe(true);
  });

  // Constructing the client must not pin the org: the Agents tab stays mounted
  // across an org switch, and a pinned id would keep driving the old org.
  it("resolves the active org per call, not at construction", async () => {
    const http = answerCloudHttp(answer);
    const client = createCloudAgentClient();
    await client.listSessions();
    expect(http).toHaveBeenLastCalledWith({ method: "GET", url: "/api/org/org1/agents/sessions" });

    activeCloudOrgId = "org2";
    await client.listSessions();
    expect(http).toHaveBeenLastCalledWith({ method: "GET", url: "/api/org/org2/agents/sessions" });
  });

  it("refuses to call the cloud with no org selected", async () => {
    const http = answerCloudHttp(answer);
    activeCloudOrgId = null;
    await expect(createCloudAgentClient().listAccounts()).rejects.toThrow(/organization/i);
    expect(http).not.toHaveBeenCalled();
  });

  // Local sessions can be a folder on this machine; cloud sessions cannot:
  // the server-side pipeline has no access to it.
  it("offers no local-folder picker", () => {
    expect(createCloudAgentClient().pickLocalRepoPath).toBeUndefined();
  });
});
