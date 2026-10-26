import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";

/**
 * Nibblets agent sessions on the agents routes: linking the server to the org
 * is the same decision as approving a link request, so it is held to the same
 * rules, and every refusal happens before a VM is created.
 */

process.env["ENCRYPTION_MASTER_KEY"] = Buffer.alloc(32, 1).toString("base64");
process.env["WORKOS_API_KEY"] = "test_workos_api_key";
process.env["WORKOS_CLIENT_ID"] = "test_workos_client_id";

const grantablePermissions = vi.fn(async () => ["team:invite", "resources:read", "costs:read"]);
vi.mock("@infrawrench/server-core/agent-links/links", () => ({
  grantablePermissions: (...a: unknown[]) =>
    (grantablePermissions as (...b: unknown[]) => unknown)(...a),
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
vi.mock("@/services/agent-setup", () => ({
  createAgentSetupPlanForRepo: vi.fn(),
  ensureAgentVmSetupForSession: vi.fn(),
  hasAgentSetupComplete: vi.fn(),
  maybeAutoResumeAgentSetup: vi.fn(),
  scheduleAgentVmSetup: vi.fn(),
  revokeT3CodeLinkOnVm: vi.fn(),
  setupAwareAgentStatus: vi.fn(),
  setupPlanLogLines: () => [],
}));
vi.mock("@/services/audit", () => ({ logAudit: vi.fn() }));
vi.mock("@/db/client", () => ({ db: {} }));

const { default: agentRoutes } = await import("@/api/routes/agents");

function app(options: { apiKey?: boolean; permissions?: string[] } = {}) {
  const root = new Hono();
  root.onError((err, c) => {
    if (err instanceof HTTPException) return err.getResponse();
    return c.json({ error: String(err) }, 500);
  });
  root.use("*", async (c, next) => {
    c.set("session", { userId: "user-1", email: "u@example.com" });
    c.set("organizationId", "org-1");
    c.set("permissions", options.permissions ?? ["*"]);
    if (options.apiKey) c.set("apiKey", { id: "key-1", scopes: ["*"] });
    return next();
  });
  root.route("/", agentRoutes);
  return root;
}

const create = (nibbletsLink: unknown) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    projectName: "home-server",
    settings: {
      accountId: "acct-1",
      pluginId: "digitalocean",
      resourceTypeId: "droplet",
      tool: "codex",
      surface: "nibblets",
      fields: {},
    },
    nibbletsLink,
  }),
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /link-scopes", () => {
  it("offers what the person could grant, within the agent scope list", async () => {
    const res = await app().request("/link-scopes");
    expect(await res.json()).toEqual({ scopes: ["resources:read", "costs:read"] });
  });

  it("answers null without team:invite, and for API keys", async () => {
    grantablePermissions.mockResolvedValueOnce(["resources:read"]);
    expect(await (await app().request("/link-scopes")).json()).toEqual({ scopes: null });
    expect(await (await app({ apiKey: true }).request("/link-scopes")).json()).toEqual({
      scopes: null,
    });
  });
});

describe("POST /sessions with a Nibblets link", () => {
  it("refuses an API key before creating anything", async () => {
    const res = await app({ apiKey: true }).request(
      "/sessions",
      create({ scopes: ["costs:read"] }),
    );
    expect(res.status).toBe(403);
    expect(getClientForAccount).not.toHaveBeenCalled();
  });

  it("refuses a person without team:invite", async () => {
    grantablePermissions.mockResolvedValueOnce(["resources:read"]);
    const res = await app().request("/sessions", create({ scopes: ["resources:read"] }));
    expect(res.status).toBe(403);
    expect(getClientForAccount).not.toHaveBeenCalled();
  });

  it("refuses a ceiling beyond what the person holds, or one no agent may hold", async () => {
    let res = await app().request("/sessions", create({ scopes: ["resources:delete"] }));
    expect(res.status).toBe(400);
    expect((await res.json()).scopes).toEqual(["resources:delete"]);
    grantablePermissions.mockResolvedValueOnce(["team:invite", "billing:read"]);
    res = await app().request("/sessions", create({ scopes: ["billing:read"] }));
    expect(res.status).toBe(400);
    expect(getClientForAccount).not.toHaveBeenCalled();
  });

  it("refuses an empty ceiling", async () => {
    const res = await app().request("/sessions", create({ scopes: [] }));
    expect(res.status).toBe(400);
  });

  it("goes on to provision the VM once the link is allowed", async () => {
    getClientForAccount.mockResolvedValueOnce(null);
    const res = await app().request("/sessions", create({ scopes: ["costs:read"] }));
    // The mocked account lookup fails provisioning; the point is it got there.
    expect(getClientForAccount).toHaveBeenCalled();
    expect(res.status).toBe(400);
  });
});
