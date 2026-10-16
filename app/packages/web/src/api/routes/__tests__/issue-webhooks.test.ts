import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

/**
 * Inbound tracker webhooks for live issue status. What matters here is the
 * door, not the room: an unknown token and a bad signature never reach the
 * apply step, the signature is checked over the raw bytes, Linear's replay
 * window holds, and GitHub's receiver is closed when the server has no
 * secret. The parsing and applying are pinned in server-core.
 */

// Fixed, obviously fake secrets so the HMACs are reproducible.
const JIRA_SECRET = "jira-test-secret-not-real";
const LINEAR_SECRET = "linear-test-secret-not-real";
const GITHUB_SECRET = "github-test-secret-not-real";
const TOKEN = "a".repeat(43);

const mockFindJira = vi.fn();
const mockTouchJira = vi.fn();
const mockFindLinear = vi.fn();
const mockTouchLinear = vi.fn();
const mockApplyJira = vi.fn();
const mockApplyLinear = vi.fn();
const mockApplyGithub = vi.fn();

vi.mock("@infrawrench/server-core/jira", () => ({
  findJiraWebhookByToken: (...a: unknown[]) => mockFindJira(...a),
  touchJiraWebhookDelivery: (...a: unknown[]) => mockTouchJira(...a),
}));
vi.mock("@infrawrench/server-core/linear", () => ({
  findLinearWebhookByToken: (...a: unknown[]) => mockFindLinear(...a),
  touchLinearWebhookDelivery: (...a: unknown[]) => mockTouchLinear(...a),
}));
vi.mock("@infrawrench/server-core/issue-status/sync", () => ({
  applyJiraWebhook: (...a: unknown[]) => mockApplyJira(...a),
  applyLinearWebhook: (...a: unknown[]) => mockApplyLinear(...a),
  applyGithubWebhook: (...a: unknown[]) => mockApplyGithub(...a),
}));

const { issueWebhookRoutes } = await import("@/api/routes/issue-webhooks");

const app = new Hono();
app.route("/api", issueWebhookRoutes);

function hub(body: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(body, "utf8").digest("hex")}`;
}

function post(path: string, body: string, headers: Record<string, string> = {}) {
  return app.request(path, {
    method: "POST",
    body,
    headers: { "content-type": "application/json", ...headers },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockFindJira.mockResolvedValue({ organizationId: "org-1", secret: JIRA_SECRET });
  mockFindLinear.mockResolvedValue({ organizationId: "org-1", secret: LINEAR_SECRET });
  mockApplyJira.mockResolvedValue(1);
  mockApplyLinear.mockResolvedValue(1);
  mockApplyGithub.mockResolvedValue(1);
  delete process.env["GITHUB_APP_WEBHOOK_SECRET"];
});

const jiraBody = JSON.stringify({
  webhookEvent: "jira:issue_updated",
  issue: {
    id: "10042",
    key: "OPS-412",
    fields: { status: { name: "Done", statusCategory: { key: "done" } } },
  },
});

describe("POST /api/issue-webhooks/jira/:token", () => {
  it("applies a correctly signed delivery for the token's org", async () => {
    const res = await post(`/api/issue-webhooks/jira/${TOKEN}`, jiraBody, {
      "x-hub-signature": hub(jiraBody, JIRA_SECRET),
    });
    expect(res.status).toBe(202);
    expect(mockTouchJira).toHaveBeenCalledWith("org-1");
    expect(mockApplyJira).toHaveBeenCalledWith(
      "org-1",
      expect.objectContaining({
        kind: "updated",
        reading: expect.objectContaining({ issueKey: "OPS-412" }),
      }),
    );
  });

  it("refuses a bad signature without applying anything", async () => {
    const res = await post(`/api/issue-webhooks/jira/${TOKEN}`, jiraBody, {
      "x-hub-signature": hub(jiraBody, "wrong"),
    });
    expect(res.status).toBe(401);
    expect(mockApplyJira).not.toHaveBeenCalled();
    expect(mockTouchJira).not.toHaveBeenCalled();
  });

  it("answers 404 for an unknown or malformed token", async () => {
    mockFindJira.mockResolvedValue(null);
    expect((await post(`/api/issue-webhooks/jira/${TOKEN}`, jiraBody)).status).toBe(404);
    expect((await post("/api/issue-webhooks/jira/short", jiraBody)).status).toBe(404);
    expect(mockApplyJira).not.toHaveBeenCalled();
  });

  it("answers 500 when applying fails, so Jira retries", async () => {
    mockApplyJira.mockRejectedValue(new Error("db down"));
    const res = await post(`/api/issue-webhooks/jira/${TOKEN}`, jiraBody, {
      "x-hub-signature": hub(jiraBody, JIRA_SECRET),
    });
    expect(res.status).toBe(500);
  });
});

describe("POST /api/issue-webhooks/linear/:token", () => {
  function linearBody(timestamp: number) {
    return JSON.stringify({
      type: "Issue",
      action: "update",
      webhookTimestamp: timestamp,
      data: { id: "u1", identifier: "ENG-7", state: { name: "Done", type: "completed" } },
    });
  }

  it("applies a fresh, correctly signed delivery", async () => {
    const body = linearBody(Date.now());
    const sig = createHmac("sha256", LINEAR_SECRET).update(body).digest("hex");
    const res = await post(`/api/issue-webhooks/linear/${TOKEN}`, body, {
      "linear-signature": sig,
    });
    expect(res.status).toBe(202);
    expect(mockApplyLinear).toHaveBeenCalledWith(
      "org-1",
      expect.objectContaining({ kind: "updated", complete: true }),
    );
  });

  it("refuses a replayed delivery even with a valid signature", async () => {
    const body = linearBody(Date.now() - 5 * 60_000);
    const sig = createHmac("sha256", LINEAR_SECRET).update(body).digest("hex");
    const res = await post(`/api/issue-webhooks/linear/${TOKEN}`, body, {
      "linear-signature": sig,
    });
    expect(res.status).toBe(401);
    expect(mockApplyLinear).not.toHaveBeenCalled();
  });
});

describe("POST /api/issue-webhooks/github", () => {
  const body = JSON.stringify({
    action: "closed",
    installation: { id: 7 },
    repository: { full_name: "acme/infra" },
    issue: { number: 12, state: "closed", state_reason: "completed", assignees: [] },
  });

  it("is closed when the server has no webhook secret", async () => {
    const res = await post("/api/issue-webhooks/github", body, {
      "x-github-event": "issues",
      "x-hub-signature-256": hub(body, GITHUB_SECRET),
    });
    expect(res.status).toBe(404);
    expect(mockApplyGithub).not.toHaveBeenCalled();
  });

  it("applies a signed issues event and answers ping", async () => {
    process.env["GITHUB_APP_WEBHOOK_SECRET"] = GITHUB_SECRET;
    const res = await post("/api/issue-webhooks/github", body, {
      "x-github-event": "issues",
      "x-hub-signature-256": hub(body, GITHUB_SECRET),
    });
    expect(res.status).toBe(202);
    expect(mockApplyGithub).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "updated", installationId: 7, repo: "acme/infra" }),
    );

    const ping = await post("/api/issue-webhooks/github", "{}", {
      "x-github-event": "ping",
      "x-hub-signature-256": hub("{}", GITHUB_SECRET),
    });
    expect(ping.status).toBe(200);
  });

  it("refuses an unsigned delivery", async () => {
    process.env["GITHUB_APP_WEBHOOK_SECRET"] = GITHUB_SECRET;
    const res = await post("/api/issue-webhooks/github", body, { "x-github-event": "issues" });
    expect(res.status).toBe(401);
  });
});
