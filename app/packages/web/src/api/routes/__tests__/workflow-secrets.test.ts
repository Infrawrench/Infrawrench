import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

const requirePermission = vi.fn();
const listWorkflowSecrets = vi.fn();
const writeWorkflowSecretValue = vi.fn();
const logAudit = vi.fn();

vi.mock("@/auth/permissions", () => ({
  requirePermission: (...args: unknown[]) => requirePermission(...args),
}));
vi.mock("@/services/audit", () => ({
  logAudit: (...args: unknown[]) => logAudit(...args),
}));
vi.mock("@/services/workflow-secrets", () => ({
  WorkflowSecretError: class WorkflowSecretError extends Error {
    status = 400;
  },
  createWorkflowSecret: vi.fn(),
  deleteWorkflowSecret: vi.fn(),
  listWorkflowSecrets: (...args: unknown[]) => listWorkflowSecrets(...args),
  updateWorkflowSecretMetadata: vi.fn(),
  writeWorkflowSecretValue: (...args: unknown[]) => writeWorkflowSecretValue(...args),
}));

const { workflowSecretRoutes } = await import("@/api/routes/workflow-secrets");

function app() {
  const root = new Hono();
  root.use("*", async (c, next) => {
    c.set("organizationId", "org-1");
    c.set("session", { userId: "user-1", email: "user@example.com" });
    await next();
  });
  root.route("/", workflowSecretRoutes);
  return root;
}

beforeEach(() => vi.clearAllMocks());

describe("workflow secret route permissions and redaction", () => {
  it("requires secrets:read to list metadata", async () => {
    listWorkflowSecrets.mockResolvedValue([]);
    const response = await app().request("/");
    expect(response.status).toBe(200);
    expect(requirePermission).toHaveBeenCalledWith(expect.anything(), "secrets:read");
  });

  it("requires secrets:write and never audits or returns the plaintext", async () => {
    writeWorkflowSecretValue.mockResolvedValue({
      id: "secret-1",
      name: "API_TOKEN",
      description: null,
      hasValue: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const response = await app().request("/secret-1/value", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: "super-secret" }),
    });
    expect(response.status).toBe(200);
    expect(requirePermission).toHaveBeenCalledWith(expect.anything(), "secrets:write");
    expect(await response.text()).not.toContain("super-secret");
    expect(JSON.stringify(logAudit.mock.calls)).not.toContain("super-secret");
  });
});
