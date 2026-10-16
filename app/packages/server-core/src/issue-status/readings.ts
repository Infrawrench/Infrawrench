/**
 * Turning what each tracker says about an issue into one reading, and
 * checking that a webhook delivery really came from the tracker.
 *
 * Pure: no database, no network. The poll (`pass.ts`), the "Refresh statuses"
 * routes and the three webhook receivers all go through these, so a status
 * learned by webhook and the same status learned by poll are byte-identical.
 *
 * API shapes (verified against the vendors' references):
 *
 *   Jira    `POST /rest/api/3/issue/bulkfetch` and webhook `issue` objects share
 *           the issue bean: `id`, `key`, `fields.status.name`,
 *           `fields.status.statusCategory.key` (`new` | `indeterminate` |
 *           `done`), `fields.assignee.displayName`, `fields.updated`.
 *           Webhook events `jira:issue_updated`, `jira:issue_deleted`; signed
 *           with `X-Hub-Signature: sha256=<hex HMAC of the body>` when the
 *           webhook has a secret.
 *   Linear  `Issue` nodes: `id`, `identifier`, `url`, `updatedAt`,
 *           `state { name type }`, `assignee { name displayName }`. Webhooks
 *           send `{ action, type: "Issue", data, webhookTimestamp }`, signed
 *           with `Linear-Signature: <hex HMAC-SHA256 of the raw body>`, and the
 *           timestamp must be within a minute of receipt.
 *   GitHub  issue objects: `number`, `state`, `state_reason`, `assignees[]`,
 *           `updated_at`, `html_url`. App webhooks carry
 *           `X-Hub-Signature-256: sha256=<hex>` and `X-GitHub-Event: issues`.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import {
  githubStatusCategory,
  githubStatusName,
  jiraStatusCategory,
  linearStatusCategory,
  type IssueStatusSnapshot,
} from "@infrawrench/client-core";

// --- Signatures ---

function safeEqualHex(expected: string, received: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(received, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

function hmacHex(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body, "utf8").digest("hex");
}

/**
 * `sha256=<hex>` over the raw body: GitHub's `X-Hub-Signature-256` and Jira's
 * `X-Hub-Signature`. Constant-time, and false (never a throw) for a missing,
 * malformed or other-algorithm header.
 */
export function verifyHubSignature(
  secret: string,
  rawBody: string,
  header: string | null | undefined,
): boolean {
  if (!secret || !header) return false;
  const match = /^sha256=([0-9a-f]{64})$/i.exec(header.trim());
  if (!match?.[1]) return false;
  return safeEqualHex(hmacHex(secret, rawBody), match[1].toLowerCase());
}

/** Linear allows one minute between signing and receipt. */
export const LINEAR_WEBHOOK_MAX_AGE_MS = 60_000;

/**
 * Linear's `Linear-Signature` (bare hex HMAC-SHA256 of the raw body) plus the
 * replay guard on the body's `webhookTimestamp` (Unix milliseconds).
 */
export function verifyLinearSignature(
  secret: string,
  rawBody: string,
  header: string | null | undefined,
  webhookTimestamp: unknown,
  now: number = Date.now(),
): boolean {
  if (!secret || !header) return false;
  const received = header.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(received)) return false;
  if (!safeEqualHex(hmacHex(secret, rawBody), received)) return false;
  const ts = typeof webhookTimestamp === "number" ? webhookTimestamp : Number(webhookTimestamp);
  return Number.isFinite(ts) && Math.abs(now - ts) <= LINEAR_WEBHOOK_MAX_AGE_MS;
}

// --- Readings ---

/** A reading tied to the tracker's handle for the issue. */
export interface JiraIssueReading extends IssueStatusSnapshot {
  issueId: string | null;
  issueKey: string;
}

export interface LinearIssueReading extends IssueStatusSnapshot {
  issueId: string | null;
  identifier: string;
  url: string | null;
}

export interface GithubIssueReading extends IssueStatusSnapshot {
  number: number;
  url: string | null;
  /** The issue's raw state, which also drives the link's filing lifecycle. */
  state: "open" | "closed";
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function obj(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** ISO string from a tracker timestamp (Jira sends `2026-10-16T09:12:44.123+0000`). */
export function normalizeTimestamp(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value).toISOString();
  const s = str(value);
  if (!s) return null;
  // Jira's offset has no colon, which `Date.parse` accepts in V8 but not everywhere.
  const fixed = s.replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
  const ms = Date.parse(fixed);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

/** A Jira issue bean (bulkfetch item or webhook `issue`) → reading; null without a key. */
export function jiraReadingFromIssue(issue: unknown): JiraIssueReading | null {
  const o = obj(issue);
  if (!o) return null;
  const key = str(o["key"]);
  if (!key) return null;
  const fields = obj(o["fields"]) ?? {};
  const status = obj(fields["status"]);
  const category = obj(status?.["statusCategory"]);
  const assignee = obj(fields["assignee"]);
  return {
    issueId: str(o["id"]),
    issueKey: key,
    status: str(status?.["name"]),
    statusCategory: jiraStatusCategory(str(category?.["key"])),
    assignee: str(assignee?.["displayName"]) ?? str(assignee?.["emailAddress"]),
    issueUpdatedAt: normalizeTimestamp(fields["updated"]),
  };
}

/** A Linear `Issue` (GraphQL node or webhook `data`) → reading; null without an identifier. */
export function linearReadingFromIssue(issue: unknown): LinearIssueReading | null {
  const o = obj(issue);
  if (!o) return null;
  const identifier = str(o["identifier"]);
  if (!identifier) return null;
  const state = obj(o["state"]);
  const assignee = obj(o["assignee"]);
  return {
    issueId: str(o["id"]),
    identifier,
    url: str(o["url"]),
    status: str(state?.["name"]),
    statusCategory: linearStatusCategory(str(state?.["type"])),
    assignee: str(assignee?.["displayName"]) ?? str(assignee?.["name"]),
    issueUpdatedAt: normalizeTimestamp(o["updatedAt"]),
  };
}

/** A GitHub issue object → reading; null without a number. */
export function githubReadingFromIssue(issue: unknown): GithubIssueReading | null {
  const o = obj(issue);
  if (!o) return null;
  const number = typeof o["number"] === "number" ? o["number"] : null;
  if (!number) return null;
  const state = o["state"] === "closed" ? "closed" : "open";
  const reason = str(o["state_reason"]);
  const assignees = Array.isArray(o["assignees"]) ? o["assignees"] : [];
  const first = obj(assignees[0]) ?? obj(o["assignee"]);
  return {
    number,
    url: str(o["html_url"]),
    state,
    status: githubStatusName(state, reason),
    statusCategory: githubStatusCategory(state, reason),
    assignee: str(first?.["login"]),
    issueUpdatedAt: normalizeTimestamp(o["updated_at"]),
  };
}

/** A reading for an issue that no longer exists in the tracker. */
export function deletedReading(at: Date = new Date()): IssueStatusSnapshot {
  return {
    status: "Deleted",
    statusCategory: "canceled",
    assignee: null,
    issueUpdatedAt: at.toISOString(),
  };
}

// --- Webhook payloads ---

export type JiraWebhookChange =
  | { kind: "updated"; reading: JiraIssueReading }
  | { kind: "deleted"; issueId: string | null; issueKey: string }
  | { kind: "ignored" };

/** What a Jira webhook body means for status. Anything but issue updates/deletes is ignored. */
export function parseJiraWebhook(body: unknown): JiraWebhookChange {
  const o = obj(body);
  const event = str(o?.["webhookEvent"]);
  const issue = o?.["issue"];
  if (event === "jira:issue_deleted") {
    const i = obj(issue);
    const key = str(i?.["key"]);
    return key ? { kind: "deleted", issueId: str(i?.["id"]), issueKey: key } : { kind: "ignored" };
  }
  if (event === "jira:issue_updated" || event === "jira:issue_created") {
    const reading = jiraReadingFromIssue(issue);
    return reading ? { kind: "updated", reading } : { kind: "ignored" };
  }
  return { kind: "ignored" };
}

export type LinearWebhookChange =
  | { kind: "updated"; reading: LinearIssueReading; complete: boolean }
  | { kind: "deleted"; issueId: string | null; identifier: string }
  | { kind: "ignored" };

/**
 * What a Linear webhook body means for status. `complete` is false when the
 * payload carried no nested `state` (Linear documents `data` as the serialized
 * entity, and an older or trimmed payload may have only `stateId`): the caller
 * then reads the issue through the API instead of storing a half-reading.
 */
export function parseLinearWebhook(body: unknown): LinearWebhookChange {
  const o = obj(body);
  if (str(o?.["type"]) !== "Issue") return { kind: "ignored" };
  const action = str(o?.["action"]);
  const data = obj(o?.["data"]);
  const identifier = str(data?.["identifier"]);
  if (!data || !identifier) return { kind: "ignored" };
  if (action === "remove") return { kind: "deleted", issueId: str(data["id"]), identifier };
  if (action !== "update" && action !== "create") return { kind: "ignored" };
  const reading = linearReadingFromIssue(data);
  if (!reading) return { kind: "ignored" };
  return { kind: "updated", reading, complete: obj(data["state"]) !== null };
}

export type GithubWebhookChange =
  | {
      kind: "updated";
      installationId: number;
      repo: string;
      reading: GithubIssueReading;
    }
  | {
      kind: "transferred";
      installationId: number;
      repo: string;
      number: number;
      newRepo: string;
      newNumber: number;
      newUrl: string;
    }
  | { kind: "deleted"; installationId: number; repo: string; number: number }
  | { kind: "ignored" };

const GITHUB_STATUS_ACTIONS = new Set([
  "opened",
  "edited",
  "closed",
  "reopened",
  "assigned",
  "unassigned",
]);

/** What a GitHub App `issues` delivery means for status. Pull requests are never issues here. */
export function parseGithubWebhook(
  event: string | null | undefined,
  body: unknown,
): GithubWebhookChange {
  if (event !== "issues") return { kind: "ignored" };
  const o = obj(body);
  const action = str(o?.["action"]);
  const installationId = obj(o?.["installation"])?.["id"];
  const repo = str(obj(o?.["repository"])?.["full_name"]);
  const issue = obj(o?.["issue"]);
  if (typeof installationId !== "number" || !repo || !issue) return { kind: "ignored" };
  // The issues API also lists pull requests; a PR is never one of our links.
  if (issue["pull_request"]) return { kind: "ignored" };
  const number = typeof issue["number"] === "number" ? issue["number"] : 0;
  if (!number) return { kind: "ignored" };
  if (action === "deleted") return { kind: "deleted", installationId, repo, number };
  if (action === "transferred") {
    const changes = obj(o?.["changes"]);
    const newIssue = obj(changes?.["new_issue"]);
    const newRepo = str(obj(changes?.["new_repository"])?.["full_name"]);
    const newNumber = typeof newIssue?.["number"] === "number" ? newIssue["number"] : 0;
    const newUrl = str(newIssue?.["html_url"]);
    if (!newRepo || !newNumber || !newUrl) return { kind: "deleted", installationId, repo, number };
    return { kind: "transferred", installationId, repo, number, newRepo, newNumber, newUrl };
  }
  if (!action || !GITHUB_STATUS_ACTIONS.has(action)) return { kind: "ignored" };
  const reading = githubReadingFromIssue(issue);
  return reading ? { kind: "updated", installationId, repo, reading } : { kind: "ignored" };
}
