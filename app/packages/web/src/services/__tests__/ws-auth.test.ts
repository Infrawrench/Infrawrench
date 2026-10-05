/**
 * The WebSocket gateway must hold a principal to the same permissions HTTP
 * would: a key's scopes intersected with its owner's role, an agent's ceiling
 * taken as final. These drive the real `effectivePermissions` (only the role
 * lookup is stubbed) through the upgrade and the channels that check again.
 */
import { EventEmitter } from "node:events";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { WebSocket } from "ws";

const mockResolveEffectivePermissions = vi.fn();
// SSO enforcement is covered in services/sso; here it never denies.
vi.mock("@/services/sso/enforcement", () => ({
  ssoDenialForPerson: vi.fn().mockResolvedValue(null),
}));
vi.mock("@infrawrench/server-core/permissions", () => ({
  resolveEffectivePermissions: (...a: unknown[]) => mockResolveEffectivePermissions(...a),
}));

const mockValidateWsToken = vi.fn();
vi.mock("@/services/ws-tokens", () => ({
  validateWsToken: (...a: unknown[]) => mockValidateWsToken(...a),
}));

const mockAuthenticateApiRequest = vi.fn();
vi.mock("@/auth/api-auth", () => ({
  authenticateApiRequest: (...a: unknown[]) => mockAuthenticateApiRequest(...a),
}));

const mockRunWorkflowById = vi.fn();
vi.mock("@/services/workflow-runner", () => ({
  runWorkflowById: (...a: unknown[]) => mockRunWorkflowById(...a),
}));

const mockRunDeployment = vi.fn();
vi.mock("@/services/deployments", () => ({
  runDeployment: (...a: unknown[]) => mockRunDeployment(...a),
}));

const mockGetSharedConsole = vi.fn();
vi.mock("@infrawrench/server-core/shared-console/store", () => ({
  getSharedConsole: (...a: unknown[]) => mockGetSharedConsole(...a),
  getParticipant: vi.fn(),
  listParticipants: vi.fn(),
  touchParticipant: vi.fn(),
}));
vi.mock("@infrawrench/server-core/shared-console/arbitration", () => ({
  evaluateAttached: vi.fn(),
}));
vi.mock("@/services/shared-console/hub", () => ({ sharedConsoleHub: { attach: vi.fn() } }));

const { authenticateWsUpgrade } = await import("../ws-auth");
const { handleWorkflowSession } = await import("../workflow-ws");
const { handleDeploymentSession } = await import("../deployment-ws");
const { handleConsoleAttach } = await import("../shared-console/attach");

/** The owner's role: everything a workflow run or deploy needs. */
const OWNER_ROLE = [
  "resources:execute",
  "workflows:write",
  "deployments:plan",
  "deployments:write",
];

function fakeSocket() {
  const emitter = new EventEmitter();
  const sent: Array<Record<string, unknown>> = [];
  const ws = Object.assign(emitter, {
    OPEN: 1,
    readyState: 1,
    send: (data: string) => sent.push(JSON.parse(data) as Record<string, unknown>),
  });
  return { ws: ws as unknown as WebSocket, sent };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
}

beforeEach(() => {
  vi.clearAllMocks();
  mockResolveEffectivePermissions.mockResolvedValue({
    permissions: OWNER_ROLE,
    role: null,
    elevations: [],
  });
  mockValidateWsToken.mockResolvedValue(null);
  mockAuthenticateApiRequest.mockResolvedValue(null);
  mockRunWorkflowById.mockResolvedValue({ runId: "run-1", result: { status: "ok" } });
  mockRunDeployment.mockResolvedValue({ runId: "dep-1", result: { status: "ok" } });
});

describe("authenticateWsUpgrade", () => {
  it("401s a token that is neither a ws-token nor a credential", async () => {
    await expect(authenticateWsUpgrade("junk")).resolves.toEqual({ ok: false, status: 401 });
  });

  it("carries an API key's scopes onto the socket principal", async () => {
    mockAuthenticateApiRequest.mockResolvedValue({
      userId: "owner",
      organizationId: "org-1",
      apiKeyId: "key-1",
      scopes: ["resources:execute"],
    });
    await expect(authenticateWsUpgrade("iwk_x")).resolves.toEqual({
      ok: true,
      principal: { organizationId: "org-1", userId: "owner", scopes: ["resources:execute"] },
    });
  });

  it("403s a key holding resources:execute when its owner's role no longer does", async () => {
    mockResolveEffectivePermissions.mockResolvedValue({
      permissions: ["resources:read"],
      role: null,
      elevations: [],
    });
    mockAuthenticateApiRequest.mockResolvedValue({
      userId: "owner",
      organizationId: "org-1",
      apiKeyId: "key-1",
      scopes: ["resources:execute"],
    });
    await expect(authenticateWsUpgrade("iwk_x")).resolves.toEqual({ ok: false, status: 403 });
  });

  it("403s a read-only key", async () => {
    mockAuthenticateApiRequest.mockResolvedValue({
      userId: "owner",
      organizationId: "org-1",
      apiKeyId: "key-1",
      scopes: ["resources:read"],
    });
    await expect(authenticateWsUpgrade("iwk_x")).resolves.toEqual({ ok: false, status: 403 });
  });

  it("keeps a ws-token's ceiling when a key minted it", async () => {
    mockValidateWsToken.mockResolvedValue({
      organizationId: "org-1",
      userId: "owner",
      scopes: ["resources:execute"],
    });
    const outcome = await authenticateWsUpgrade("minted");
    expect(outcome).toEqual({
      ok: true,
      principal: { organizationId: "org-1", userId: "owner", scopes: ["resources:execute"] },
    });
  });

  it("takes an agent's scopes as final instead of re-resolving its member row", async () => {
    mockAuthenticateApiRequest.mockResolvedValue({
      userId: "agent-user",
      organizationId: "org-1",
      agentRegistrationId: "reg-1",
      scopes: ["resources:execute"],
    });
    const outcome = await authenticateWsUpgrade("iwa_x");
    expect(outcome).toEqual({
      ok: true,
      principal: {
        organizationId: "org-1",
        userId: "agent-user",
        scopes: ["resources:execute"],
        agentRegistrationId: "reg-1",
      },
    });
    expect(mockResolveEffectivePermissions).not.toHaveBeenCalled();
  });
});

describe("workflow:run over the socket", () => {
  it("refuses a key scoped to resources:execute, whatever its owner's role", async () => {
    const { ws, sent } = fakeSocket();
    handleWorkflowSession(
      ws,
      { organizationId: "org-1", userId: "owner", scopes: ["resources:execute"] },
      "wf-1",
    );
    await settle();
    expect(mockRunWorkflowById).not.toHaveBeenCalled();
    expect(sent).toEqual([
      {
        type: "workflow:error",
        message: "You do not have permission to run workflows in this organization.",
      },
    ]);
  });

  it("runs for a key that holds workflows:write, as its owner", async () => {
    const { ws, sent } = fakeSocket();
    handleWorkflowSession(
      ws,
      {
        organizationId: "org-1",
        userId: "owner",
        scopes: ["resources:execute", "workflows:write"],
      },
      "wf-1",
    );
    await settle();
    expect(mockRunWorkflowById).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "org-1",
        workflowId: "wf-1",
        runAsUserId: "owner",
      }),
    );
    expect(sent.at(-1)).toMatchObject({ type: "workflow:result", runId: "run-1" });
  });

  it("refuses an agent whose ceiling lacks workflows:write", async () => {
    const { ws, sent } = fakeSocket();
    handleWorkflowSession(
      ws,
      {
        organizationId: "org-1",
        userId: "agent-user",
        scopes: ["resources:execute"],
        agentRegistrationId: "reg-1",
      },
      "wf-1",
    );
    await settle();
    expect(mockRunWorkflowById).not.toHaveBeenCalled();
    expect(sent[0]).toMatchObject({ type: "workflow:error" });
  });

  it("still runs for a person whose role allows it", async () => {
    const { ws } = fakeSocket();
    handleWorkflowSession(ws, { organizationId: "org-1", userId: "person" }, "wf-1");
    await settle();
    expect(mockRunWorkflowById).toHaveBeenCalledTimes(1);
  });
});

describe("deploy:run over the socket", () => {
  const start = { repo: "acme/app", branch: "main" };

  it("refuses a key scoped to resources:execute, whatever its owner's role", async () => {
    const { ws, sent } = fakeSocket();
    handleDeploymentSession(
      ws,
      { organizationId: "org-1", userId: "owner", scopes: ["resources:execute"] },
      start,
    );
    await settle();
    expect(mockRunDeployment).not.toHaveBeenCalled();
    expect(sent).toEqual([
      {
        type: "deploy:error",
        message: "You do not have permission to deploy in this organization.",
      },
    ]);
  });

  it("lets a plan-only key preview but not deploy", async () => {
    const principal = {
      organizationId: "org-1",
      userId: "owner",
      scopes: ["resources:execute", "deployments:plan"],
    };
    const preview = fakeSocket();
    handleDeploymentSession(preview.ws, principal, { ...start, planOnly: true });
    await settle();
    expect(mockRunDeployment).toHaveBeenCalledTimes(1);

    const deploy = fakeSocket();
    handleDeploymentSession(deploy.ws, principal, start);
    await settle();
    expect(mockRunDeployment).toHaveBeenCalledTimes(1);
    expect(deploy.sent[0]).toMatchObject({ type: "deploy:error" });
  });

  it("deploys for a person whose role allows it, as that person", async () => {
    const { ws } = fakeSocket();
    handleDeploymentSession(ws, { organizationId: "org-1", userId: "person" }, start);
    await settle();
    expect(mockRunDeployment).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: "org-1", userId: "person" }),
    );
  });
});

describe("console:attach over the socket", () => {
  it("refuses an API key, as POST /shared-consoles/... is refused on HTTP", async () => {
    const { ws, sent } = fakeSocket();
    await handleConsoleAttach(
      ws,
      { organizationId: "org-1", userId: "owner", scopes: ["*"] },
      "share-1",
    );
    expect(sent).toEqual([expect.objectContaining({ type: "console:error", code: "forbidden" })]);
    expect(mockGetSharedConsole).not.toHaveBeenCalled();
  });

  it("refuses an agent", async () => {
    const { ws, sent } = fakeSocket();
    await handleConsoleAttach(
      ws,
      { organizationId: "org-1", userId: "agent-user", scopes: [], agentRegistrationId: "reg-1" },
      "share-1",
    );
    expect(sent[0]).toMatchObject({ type: "console:error", code: "forbidden" });
  });
});
