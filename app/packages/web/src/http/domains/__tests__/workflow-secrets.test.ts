import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildTestApi } from "@/http/testing";

const listWorkflowSecrets = vi.fn();
const writeWorkflowSecretValue = vi.fn();
const logAudit = vi.fn();

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

const { workflowSecretsDomain } = await import("@/http/domains/workflow-secrets/index");

const app = (permissions?: readonly string[]) =>
  buildTestApi(workflowSecretsDomain, {
    basePath: "/api/org/org-1/workflow-secrets",
    ...(permissions ? { permissions } : {}),
  });

beforeEach(() => vi.clearAllMocks());

describe("workflow secret route permissions and redaction", () => {
  it("requires secrets:read to list metadata", async () => {
    listWorkflowSecrets.mockResolvedValue([]);
    expect((await app(["secrets:write"]).request("/")).status).toBe(403);
    const response = await app(["secrets:read"]).request("/");
    expect(response.status).toBe(200);
    expect(listWorkflowSecrets).toHaveBeenCalledTimes(1);
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
    const put = (permissions: readonly string[]) =>
      app(permissions).request("/secret-1/value", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: "super-secret" }),
      });
    expect((await put(["secrets:read"])).status).toBe(403);
    expect(writeWorkflowSecretValue).not.toHaveBeenCalled();
    const response = await put(["secrets:write"]);
    expect(response.status).toBe(200);
    expect(await response.text()).not.toContain("super-secret");
    expect(JSON.stringify(logAudit.mock.calls)).not.toContain("super-secret");
  });
});
