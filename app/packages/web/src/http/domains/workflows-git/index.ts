/**
 * The public git webhook for workflows, `POST /api/workflows/git/:token`, the
 * handler.
 *
 * The workflow is identified by its opaque `webhookToken`; the provider is
 * treated loosely (no particular payload shape is required) and the body is
 * best-effort filtered by branch and event before a run is started. When the
 * workflow has a signing secret, the signature over the raw body is
 * authoritative: the token alone travels in the path and lands in access
 * logs, proxy logs and referrers.
 *
 * Answers exactly as the Hono route did: 404 `Not found` for an unknown,
 * disabled or non-git workflow (before any signature is looked at), 401
 * `Invalid signature`, and 200 for everything delivered, ignored or not, so
 * the provider never counts a filtered event as a failed delivery.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { Effect, Predicate, Schema } from "effect";
import type { Headers } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import { db } from "@infrawrench/server-core/db/client";
import { workflows } from "@infrawrench/server-core/db/schema";
import { runOrgWorkflow } from "@infrawrench/server-core/workflows/runner";
import { notFound, Unauthorized, WorkflowGitWebhookApi } from "@infrawrench/api-contract";
import { makeDomain } from "../../domain";
import { legacy } from "../../legacy";
import { respond } from "../../response";

type Body = { readonly [key: string]: unknown };

/**
 * Best-effort extraction of the pushed branch from a loosely-typed git payload.
 * Handles GitHub/GitLab push (`ref: refs/heads/<branch>`) and a few common
 * fallbacks (`branch`, `ref` without the refs/heads prefix).
 */
function extractBranch(body: Body): string | null {
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
function extractEvent(headers: Headers.Headers, body: Body): string | null {
  const header = headers["x-github-event"] ?? headers["x-gitlab-event"] ?? headers["x-event-key"];
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
 *   - GitLab    `X-Gitlab-Token: <secret>`: a plain shared secret, not an HMAC
 *   - generic   `X-Hub-Signature-256`, same as GitHub
 *
 * GitHub's legacy `X-Hub-Signature` (SHA-1) is deliberately NOT accepted:
 * honouring it would let a sender downgrade to the weaker digest.
 */
function verifyGitSignature(headers: Headers.Headers, rawBody: string, secret: string): boolean {
  const gitlabToken = headers["x-gitlab-token"];
  if (gitlabToken) return digestsEqual(gitlabToken, secret);

  const header = headers["x-hub-signature-256"];
  if (!header) return false;
  const [algorithm, provided] = header.split("=", 2);
  if (algorithm !== "sha256" || !provided) return false;

  const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
  return digestsEqual(provided, expected);
}

/** The body parsed loosely: a missing or non-JSON body still allows a trigger. */
function parseBody(rawBody: string): Body {
  try {
    const parsed: unknown = JSON.parse(rawBody);
    return Predicate.isObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

const WorkflowGitWebhookHandlers = HttpApiBuilder.group(
  WorkflowGitWebhookApi,
  "workflowGitWebhook",
  (handlers) =>
    handlers.handleRaw("receive", ({ request, params }) =>
      Effect.gen(function* () {
        const [wf] = yield* legacy(() =>
          db
            .select()
            .from(workflows)
            .where(and(eq(workflows.webhookToken, params.token), isNull(workflows.deletedAt)))
            .limit(1),
        );
        if (!wf || !wf.enabled) return yield* notFound();

        // A `WorkflowTrigger` (`@infrawrench/workflow-runtime`), stored as JSON.
        const trigger = wf.trigger;
        if (!Predicate.isObject(trigger) || trigger["kind"] !== "git") return yield* notFound();

        // Read the body as raw text first: HMAC has to be computed over the
        // exact bytes the provider signed, not over a re-serialized parse.
        const rawBody = yield* request.text.pipe(Effect.orElseSucceed(() => ""));

        if (wf.webhookSecret) {
          if (!verifyGitSignature(request.headers, rawBody, wf.webhookSecret)) {
            return yield* new Unauthorized({ error: "Invalid signature" });
          }
        }

        const body = parseBody(rawBody);

        // Best-effort branch filter: if the workflow pins a branch and the
        // payload's branch is known and differs, ignore the event (still 200
        // so the provider doesn't treat it as a delivery failure).
        const pinnedBranch = trigger["branch"];
        if (pinnedBranch) {
          const branch = extractBranch(body);
          if (branch !== null && branch !== pinnedBranch) {
            return yield* respond(Schema.Unknown)({ ok: true, ignored: true });
          }
        }

        // Best-effort event filter: same treatment as branch.
        const events = trigger["events"];
        if (Array.isArray(events) && events.length > 0) {
          const event = extractEvent(request.headers, body);
          if (event !== null && !events.includes(event)) {
            return yield* respond(Schema.Unknown)({ ok: true, ignored: true });
          }
        }

        const { runId } = yield* legacy(() =>
          runOrgWorkflow({
            organizationId: wf.organizationId,
            workflowId: wf.id,
            triggerSource: "git",
          }),
        );
        return yield* respond(Schema.Unknown)({ ok: true, runId });
      }),
    ),
);

export const workflowGitWebhookDomain = makeDomain(
  "workflowGitWebhook",
  WorkflowGitWebhookApi,
  WorkflowGitWebhookHandlers,
);
