import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildTestApi } from "@/http/testing";

/**
 * `POST /api/orgs`: what the handler refuses and what it asks for. The rows
 * an organization is made of (roles, the owner, the Home dashboard, the
 * scorecard) are server-core's `createOrganization`, held against a real
 * Postgres by the forge's `workspace-checkout.test.ts`, which creates one the
 * same way.
 */
const createOrganization = vi.fn();
vi.mock("@infrawrench/server-core/organizations/create", () => ({
  createOrganization: (...a: unknown[]) => createOrganization(...a),
}));

const { orgsDomain } = await import("@/http/domains/orgs/index");
const buildApp = () => buildTestApi(orgsDomain, { basePath: "/api/orgs" });

describe("Org management routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createOrganization.mockImplementation(async (input: { displayName: string }) => ({
      ok: true,
      id: "org-uuid-1",
      displayName: input.displayName,
      created: true,
    }));
  });

  it("creates an org owned by the caller, under the trimmed name", async () => {
    const app = buildApp();
    const res = await app.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ displayName: "  Acme  " }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: "org-uuid-1", displayName: "Acme" });
    expect(createOrganization).toHaveBeenCalledTimes(1);
    expect(createOrganization).toHaveBeenCalledWith({
      displayName: "Acme",
      ownerUserId: expect.any(String),
    });
  });

  it("rejects a blank name with 400", async () => {
    const res = await buildApp().request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ displayName: "   " }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/required/i);
    expect(createOrganization).not.toHaveBeenCalled();
  });

  it("rejects a missing name with 400", async () => {
    const res = await buildApp().request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    expect(createOrganization).not.toHaveBeenCalled();
  });
});
