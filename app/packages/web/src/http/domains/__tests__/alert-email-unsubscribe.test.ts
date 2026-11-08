import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildTestApi } from "@/http/testing";

// The token check, the org lookup and the suppression write are mocked; the
// pages, their statuses and which call happened are what is under test.
const mockVerify = vi.fn();
const mockSuppress = vi.fn();
vi.mock("@infrawrench/server-core/alerts/email", () => ({
  verifyUnsubscribeToken: (...a: unknown[]) => mockVerify(...a),
  suppressAlertEmail: (...a: unknown[]) => mockSuppress(...a),
}));
let orgRows: Array<{ name: string }> = [];
vi.mock("@/db/client", () => ({
  db: {
    select: () => ({ from: () => ({ where: () => ({ limit: async () => orgRows }) }) }),
  },
}));
vi.mock("@/db/schema", () => ({ organizations: { id: "id", displayName: "displayName" } }));
const mockLogAudit = vi.fn();
vi.mock("@/services/audit", () => ({ logAudit: (...a: unknown[]) => mockLogAudit(...a) }));

const { alertEmailUnsubscribeDomain } =
  await import("@/http/domains/alert-email-unsubscribe/index");
const request = (query: string, method = "GET") =>
  buildTestApi(alertEmailUnsubscribeDomain, { permissions: [] }).request(
    `/api/alert-email/unsubscribe${query}`,
    { method },
  );

beforeEach(() => {
  vi.clearAllMocks();
  orgRows = [{ name: "Acme <Ops>" }];
  mockVerify.mockReturnValue({ organizationId: "org-1", email: "finance@example.com" });
});

describe("alert email unsubscribe", () => {
  it("renders the confirmation page without changing anything", async () => {
    const res = await request("?t=tok%2Bx");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=UTF-8");
    expect(mockVerify).toHaveBeenCalledWith("tok+x");
    const body = await res.text();
    expect(body).toContain("<strong>finance@example.com</strong>");
    expect(body).toContain("<strong>Acme &lt;Ops&gt;</strong>");
    expect(body).toContain('action="/api/alert-email/unsubscribe?t=tok%2Bx"');
    expect(mockSuppress).not.toHaveBeenCalled();
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  it("answers a missing or bad token with the invalid-link page", async () => {
    mockVerify.mockReturnValue(null);
    const missing = await request("");
    expect(missing.status).toBe(400);
    expect(mockVerify).toHaveBeenCalledWith("");
    expect(await missing.text()).toContain("This unsubscribe link is not valid");

    const post = await request("?t=bad", "POST");
    expect(post.status).toBe(400);
    expect(post.headers.get("content-type")).toBe("text/html; charset=UTF-8");
    expect(mockSuppress).not.toHaveBeenCalled();
  });

  it("reads the first token when the link repeats it", async () => {
    const res = await request("?t=first&t=second");
    expect(res.status).toBe(200);
    expect(mockVerify).toHaveBeenCalledWith("first");
  });

  it("answers a token for an organization that is gone with a 404 page", async () => {
    orgRows = [];
    const res = await request("?t=tok", "POST");
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("This unsubscribe link is not valid");
    expect(mockSuppress).not.toHaveBeenCalled();
  });

  it("suppresses the address and records it on POST", async () => {
    const res = await request("?t=tok", "POST");
    expect(res.status).toBe(200);
    expect(mockVerify).toHaveBeenCalledWith("tok");
    expect(mockSuppress).toHaveBeenCalledWith("org-1", "finance@example.com");
    expect(mockLogAudit).toHaveBeenCalledWith({
      organizationId: "org-1",
      action: "alert_email.unsubscribe",
      entityType: "alert_email_suppression",
      entityId: "finance@example.com",
      metadata: { email: "finance@example.com" },
    });
    expect(await res.text()).toContain("You're unsubscribed");
  });
});
