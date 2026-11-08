import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildTestApi } from "@/http/testing";
import { createHmac } from "node:crypto";

const mockSelect = vi.fn();
vi.mock("@infrawrench/server-core/db/client", () => ({
  db: { select: (...a: unknown[]) => mockSelect(...a) },
}));

vi.mock("@infrawrench/server-core/db/schema", () => ({
  workflows: { webhookToken: "webhook_token", deletedAt: "deleted_at" },
}));

const mockRunOrgWorkflow = vi.fn();
vi.mock("@infrawrench/server-core/workflows/runner", () => ({
  runOrgWorkflow: (...a: unknown[]) => mockRunOrgWorkflow(...a),
}));

const { workflowGitWebhookDomain } = await import("@/http/domains/workflows-git/index");
const app = buildTestApi(workflowGitWebhookDomain, { basePath: "/api" });

const SECRET = "s3cret";
const BODY = JSON.stringify({ ref: "refs/heads/main" });

function workflowRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "wf1",
    organizationId: "org1",
    enabled: true,
    trigger: { kind: "git", events: ["push"] },
    webhookSecret: null,
    ...overrides,
  };
}

function selectReturns(rows: unknown[]) {
  const limit = vi.fn().mockResolvedValue(rows);
  const where = vi.fn().mockReturnValue({ limit });
  const from = vi.fn().mockReturnValue({ where });
  mockSelect.mockReturnValue({ from });
}

function post(headers: Record<string, string> = {}, body = BODY) {
  return app.request("/workflows/git/tok123", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body,
  });
}

function githubSignature(body: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(body, "utf8").digest("hex")}`;
}

describe("git webhook signature verification", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRunOrgWorkflow.mockResolvedValue({ runId: "run1" });
  });

  it("runs an unsigned delivery when no secret is configured", async () => {
    selectReturns([workflowRow()]);
    const res = await post();
    expect(res.status).toBe(200);
    expect(mockRunOrgWorkflow).toHaveBeenCalled();
  });

  it("accepts a correctly signed GitHub delivery", async () => {
    selectReturns([workflowRow({ webhookSecret: SECRET })]);
    const res = await post({
      "X-Hub-Signature-256": githubSignature(BODY, SECRET),
      "X-GitHub-Event": "push",
    });
    expect(res.status).toBe(200);
    expect(mockRunOrgWorkflow).toHaveBeenCalled();
  });

  it("verifies over the raw bytes of a form-encoded delivery", async () => {
    // GitHub can deliver `application/x-www-form-urlencoded`; the body is
    // not JSON, so no filter applies, but the signature still covers it.
    selectReturns([workflowRow({ webhookSecret: SECRET })]);
    const form = `payload=${encodeURIComponent(BODY)}`;
    const res = await post(
      {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Hub-Signature-256": githubSignature(form, SECRET),
      },
      form,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, runId: "run1" });
  });

  it("rejects a delivery signed with the wrong secret", async () => {
    selectReturns([workflowRow({ webhookSecret: SECRET })]);
    const res = await post({ "X-Hub-Signature-256": githubSignature(BODY, "wrong") });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Invalid signature" });
    expect(mockRunOrgWorkflow).not.toHaveBeenCalled();
  });

  it("rejects a signature computed over a different body", async () => {
    selectReturns([workflowRow({ webhookSecret: SECRET })]);
    const res = await post({ "X-Hub-Signature-256": githubSignature("{}", SECRET) });
    expect(res.status).toBe(401);
    expect(mockRunOrgWorkflow).not.toHaveBeenCalled();
  });

  it("rejects an unsigned delivery once a secret is configured", async () => {
    selectReturns([workflowRow({ webhookSecret: SECRET })]);
    const res = await post();
    expect(res.status).toBe(401);
    expect(mockRunOrgWorkflow).not.toHaveBeenCalled();
  });

  it("refuses a SHA-1 downgrade", async () => {
    selectReturns([workflowRow({ webhookSecret: SECRET })]);
    const sha1 = createHmac("sha1", SECRET).update(BODY, "utf8").digest("hex");
    const res = await post({ "X-Hub-Signature": `sha1=${sha1}` });
    expect(res.status).toBe(401);
    expect(mockRunOrgWorkflow).not.toHaveBeenCalled();
  });

  it("accepts a matching GitLab shared-secret token", async () => {
    selectReturns([workflowRow({ webhookSecret: SECRET })]);
    const res = await post({ "X-Gitlab-Token": SECRET });
    expect(res.status).toBe(200);
    expect(mockRunOrgWorkflow).toHaveBeenCalled();
  });

  it("rejects a mismatched GitLab token", async () => {
    selectReturns([workflowRow({ webhookSecret: SECRET })]);
    const res = await post({ "X-Gitlab-Token": "nope" });
    expect(res.status).toBe(401);
    expect(mockRunOrgWorkflow).not.toHaveBeenCalled();
  });

  it("still applies the branch filter after a valid signature", async () => {
    selectReturns([
      workflowRow({ webhookSecret: SECRET, trigger: { kind: "git", branch: "release" } }),
    ]);
    const res = await post({ "X-Hub-Signature-256": githubSignature(BODY, SECRET) });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ignored: true });
    expect(mockRunOrgWorkflow).not.toHaveBeenCalled();
  });

  it("404s an unknown token before looking at signatures", async () => {
    selectReturns([]);
    const res = await post({ "X-Hub-Signature-256": githubSignature(BODY, SECRET) });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Not found" });
  });
});
