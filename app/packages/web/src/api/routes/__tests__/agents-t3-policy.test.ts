import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";

/**
 * The organization's T3 Code managed policy on the agents routes: saved with
 * the defaults (three-state, so an older client cannot wipe it) and refused at
 * session creation, before a VM exists, when it does not fit the server.
 */

process.env["ENCRYPTION_MASTER_KEY"] = Buffer.alloc(32, 1).toString("base64");
process.env["WORKOS_API_KEY"] = "test_workos_api_key";
process.env["WORKOS_CLIENT_ID"] = "test_workos_client_id";

vi.mock("@infrawrench/server-core/agent-links/links", () => ({
  grantablePermissions: vi.fn(async () => []),
  createApprovedLink: vi.fn(),
  revokeLink: vi.fn(async () => true),
}));
const getClientForAccount = vi.fn();
vi.mock("@/services/plugin-clients", () => ({
  getClientForAccount: (...a: unknown[]) => getClientForAccount(...a),
}));
vi.mock("@/services/agent-services", () => ({
  publicServiceInstalls: () => [],
  releaseAgentServices: vi.fn(),
  resolveAgentServiceAccounts: vi.fn(async () => ({ accountIds: [], pluginIds: [] })),
}));
const applyT3CodePolicyToSessions = vi.fn();
vi.mock("@/services/agent-setup", () => ({
  applyT3CodePolicyToSessions: (...a: unknown[]) => applyT3CodePolicyToSessions(...a),
  createAgentSetupPlanForRepo: vi.fn(),
  ensureAgentVmSetupForSession: vi.fn(),
  hasAgentSetupComplete: vi.fn(),
  maybeAutoResumeAgentSetup: vi.fn(),
  scheduleAgentVmSetup: vi.fn(),
  revokeT3CodeLinkOnVm: vi.fn(),
  setupAwareAgentStatus: vi.fn(),
  setupPlanLogLines: () => [],
}));
const logAudit = vi.fn();
vi.mock("@/services/audit", () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));

/** The `t3_policy` column of the org's agent_settings row (undefined: no row). */
let storedPolicy: unknown;
const upsertSet = vi.fn();
vi.mock("@/db/client", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => (storedPolicy === undefined ? [] : [{ t3Policy: storedPolicy }]),
        }),
      }),
    }),
    insert: () => ({
      values: () => ({
        onConflictDoUpdate: async ({ set }: { set: Record<string, unknown> }) => {
          upsertSet(set);
          if ("t3Policy" in set) storedPolicy = set["t3Policy"];
        },
      }),
    }),
  },
}));

const { default: agentRoutes } = await import("@/api/routes/agents");

function app() {
  const root = new Hono();
  root.onError((err, c) => {
    if (err instanceof HTTPException) return err.getResponse();
    return c.json({ error: String(err) }, 500);
  });
  root.use("*", async (c, next) => {
    c.set("session", { userId: "user-1", email: "u@example.com" });
    c.set("organizationId", "org-1");
    c.set("permissions", ["*"]);
    return next();
  });
  root.route("/", agentRoutes);
  return root;
}

const settings = {
  accountId: "acct-1",
  pluginId: "digitalocean",
  resourceTypeId: "droplet",
  tool: "codex",
  surface: "t3-code",
  fields: {},
};

const put = (body: Record<string, unknown>) =>
  app().request("/settings", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...settings, ...body }),
  });

const createT3 = () =>
  app().request("/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectName: "t3", settings }),
  });

const POLICY = { schemaVersion: 1, organization: "Acme", limits: { telemetry: false } };

beforeEach(() => {
  vi.clearAllMocks();
  storedPolicy = undefined;
});

describe("PUT /settings with a T3 Code policy", () => {
  it("stores a valid policy and records it in the audit log", async () => {
    const res = await put({ t3Policy: POLICY });
    expect(res.status).toBe(200);
    expect((await res.json()).t3Policy).toEqual(POLICY);
    expect(upsertSet).toHaveBeenCalledWith(expect.objectContaining({ t3Policy: POLICY }));
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "agent_t3_policy.update" }),
    );
  });

  it("refuses a policy T3 Code would refuse to start with", async () => {
    const res = await put({ t3Policy: { ...POLICY, limits: { clients: ["desktop"] } } });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/clients must include remote/);
    expect(upsertSet).not.toHaveBeenCalled();
  });

  it("keeps the stored policy when the body leaves it out", async () => {
    storedPolicy = POLICY;
    const res = await put({});
    expect(res.status).toBe(200);
    expect(upsertSet.mock.calls[0]![0]).not.toHaveProperty("t3Policy");
    expect((await res.json()).t3Policy).toEqual(POLICY);
    expect(logAudit).not.toHaveBeenCalled();
  });

  it("removes it on null", async () => {
    storedPolicy = POLICY;
    const res = await put({ t3Policy: null });
    expect(res.status).toBe(200);
    expect(upsertSet).toHaveBeenCalledWith(expect.objectContaining({ t3Policy: null }));
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "agent_t3_policy.remove" }),
    );
  });
});

describe("POST /sessions under a T3 Code policy", () => {
  it("refuses a server whose provider the policy does not allow, before creating a VM", async () => {
    storedPolicy = { ...POLICY, limits: { providers: { allowedDrivers: ["claudeAgent"] } } };
    const res = await createT3();
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/does not fit this server/);
    expect(getClientForAccount).not.toHaveBeenCalled();
  });

  it("refuses T3 Connect access when the policy turns T3 Connect off", async () => {
    storedPolicy = { ...POLICY, limits: { connect: false } };
    const res = await createT3();
    expect(res.status).toBe(400);
    expect(getClientForAccount).not.toHaveBeenCalled();
  });

  it("goes on to provision the VM when the policy fits", async () => {
    storedPolicy = POLICY;
    getClientForAccount.mockResolvedValueOnce(null);
    const res = await createT3();
    // The mocked account lookup fails provisioning; the point is it got there.
    expect(getClientForAccount).toHaveBeenCalled();
    expect(res.status).toBe(400);
  });
});

describe("POST /t3-policy/apply", () => {
  const apply = (body: unknown) =>
    app().request("/t3-policy/apply", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  it("needs an explicit choice about restarting", async () => {
    const res = await apply({});
    expect(res.status).toBe(400);
    expect(applyT3CodePolicyToSessions).not.toHaveBeenCalled();
  });

  it("rolls the organization's current policy out and audits what changed", async () => {
    storedPolicy = POLICY;
    const servers = [
      { sessionId: "s1", projectName: "one", outcome: "installed" },
      { sessionId: "s2", projectName: "two", outcome: "unchanged" },
    ];
    applyT3CodePolicyToSessions.mockResolvedValueOnce(servers);
    const res = await apply({ restart: false });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ servers });
    expect(applyT3CodePolicyToSessions).toHaveBeenCalledWith("org-1", POLICY, { restart: false });
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "agent_t3_policy.apply",
        metadata: expect.objectContaining({ restart: false, servers: ["s1"] }),
      }),
    );
  });

  it("rolls a removal out as null and skips the audit when nothing changed", async () => {
    applyT3CodePolicyToSessions.mockResolvedValueOnce([
      { sessionId: "s1", projectName: "one", outcome: "failed", message: "unreachable" },
    ]);
    const res = await apply({ restart: true });
    expect(res.status).toBe(200);
    expect(applyT3CodePolicyToSessions).toHaveBeenCalledWith("org-1", null, { restart: true });
    expect(logAudit).not.toHaveBeenCalled();
  });

  it("404s an unknown server", async () => {
    const res = await apply({ restart: true, sessionId: "nope" });
    expect(res.status).toBe(404);
    expect(applyT3CodePolicyToSessions).not.toHaveBeenCalled();
  });
});
