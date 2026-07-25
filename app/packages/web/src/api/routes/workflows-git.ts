/**
 * Public (no-session) git webhook endpoint for workflows.
 *
 * Mounted OUTSIDE the org-scoped/session middleware so external git providers
 * (GitHub, GitLab, Bitbucket, …) can POST without an infrawrench session. The
 * single workflow is identified by its opaque `webhookToken` in the path; the
 * provider is treated loosely (we never require a specific shape) and the body
 * is best-effort filtered by branch/event before triggering a run.
 */
import { Hono, type Context } from "hono";
import { createHmac, timingSafeEqual } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";

import type { WorkflowTrigger } from "@infrawrench/workflow-runtime";

import { db } from "@infrawrench/server-core/db/client";
import { workflows } from "@infrawrench/server-core/db/schema";
import { runOrgWorkflow } from "@infrawrench/server-core/workflows/runner";

export const workflowGitWebhook = new Hono();

/** The git-trigger shape (narrowed from the WorkflowTrigger union). */
type GitTrigger = Extract<WorkflowTrigger, { kind: "git" }>;

/**
 * Best-effort extraction of the pushed branch from a loosely-typed git payload.
 * Handles GitHub/GitLab push (`ref: refs/heads/<branch>`) and a few common
 * fallbacks (`branch`, `ref` without the refs/heads prefix).
 */
function extractBranch(body: Record<string, unknown>): string | null {
  const ref = typeof body["ref"] === "string" ? body["ref"] : null;
  if (ref) {
    const m = ref.match(/^refs\/heads\/(.+)$/);
    if (m) return m[1] ?? null;
    return ref;
  }
  if (typeof body["branch"] === "string") return body["branch"];
  return null;
}

/**
 * Best-effort extraction of the event name. GitHub sends it as the
 * `X-GitHub-Event` header; GitLab as `X-Gitlab-Event`; Bitbucket as
 * `X-Event-Key`; some senders put an `event` field in the body. Returns `null`
 * when unknown.
 */
function extractEvent(c: Context, body: Record<string, unknown>): string | null {
  const header =
    c.req.header("x-github-event") ?? c.req.header("x-gitlab-event") ?? c.req.header("x-event-key");
  if (header) return header;
  if (typeof body["event"] === "string") return body["event"];
  return null;
}

/** Constant-time compare of two hex digests; false if lengths differ. */
function digestsEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, "utf8");
  const bBuf = Buffer.from(b, "utf8");
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

/**
 * Verify the delivery signature against `secret`. Covers the three shapes we
 * see in practice:
 *
 *   - GitHub    `X-Hub-Signature-256: sha256=<hex>` over the raw body
 *   - GitLab    `X-Gitlab-Token: <secret>` — a plain shared secret, not an HMAC
 *   - generic   `X-Hub-Signature-256`, same as GitHub
 *
 * GitHub's legacy `X-Hub-Signature` (SHA-1) is deliberately NOT accepted:
 * honouring it would let a sender downgrade to the weaker digest.
 */
function verifyGitSignature(c: Context, rawBody: string, secret: string): boolean {
  const gitlabToken = c.req.header("x-gitlab-token");
  if (gitlabToken) return digestsEqual(gitlabToken, secret);

  const header = c.req.header("x-hub-signature-256");
  if (!header) return false;
  const [algorithm, provided] = header.split("=", 2);
  if (algorithm !== "sha256" || !provided) return false;

  const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
  return digestsEqual(provided, expected);
}

workflowGitWebhook.post("/workflows/git/:token", async (c) => {
  const token = c.req.param("token");
  const [wf] = await db
    .select()
    .from(workflows)
    .where(and(eq(workflows.webhookToken, token), isNull(workflows.deletedAt)))
    .limit(1);

  if (!wf || !wf.enabled) return c.json({ error: "Not found" }, 404);

  const trigger = wf.trigger as WorkflowTrigger;
  if (trigger.kind !== "git") return c.json({ error: "Not found" }, 404);
  const gitTrigger: GitTrigger = trigger;

  // Read the body as raw text first: HMAC has to be computed over the exact
  // bytes the provider signed, not over a re-serialized parse of them.
  const rawBody = await c.req.text().catch(() => "");

  // When a signing secret is configured the signature is authoritative — the
  // URL token alone is not enough, since it travels in the path and lands in
  // access logs, proxy logs, and referrers.
  if (wf.webhookSecret) {
    if (!verifyGitSignature(c, rawBody, wf.webhookSecret)) {
      return c.json({ error: "Invalid signature" }, 401);
    }
  }

  // Parse the body loosely; a missing/invalid JSON body still allows a trigger.
  let body: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(rawBody) as unknown;
    if (parsed && typeof parsed === "object") body = parsed as Record<string, unknown>;
  } catch {
    body = {};
  }

  // Best-effort branch filter: if the workflow pins a branch and the payload's
  // branch is known and differs, ignore the event (still 200 so the provider
  // doesn't treat it as a delivery failure).
  if (gitTrigger.branch) {
    const branch = extractBranch(body);
    if (branch !== null && branch !== gitTrigger.branch) {
      return c.json({ ok: true, ignored: true });
    }
  }

  // Best-effort event filter: same treatment as branch.
  if (gitTrigger.events && gitTrigger.events.length > 0) {
    const event = extractEvent(c, body);
    if (event !== null && !gitTrigger.events.includes(event)) {
      return c.json({ ok: true, ignored: true });
    }
  }

  const { runId } = await runOrgWorkflow({
    organizationId: wf.organizationId,
    workflowId: wf.id,
    triggerSource: "git",
  });
  return c.json({ ok: true, runId });
});
