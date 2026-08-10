/**
 * Linear as an issue tracker for findings.
 *
 * The second tracker next to Jira (`jira.ts`), covering the same six finding
 * kinds — cost anomalies, orphaned and oversized resources, posture findings,
 * expiring credentials, failed probes. An org may connect either tracker or
 * both; the two integrations are stored in parallel tables and are
 * independently removable, which is why nothing here is generalized over
 * `jira.ts` rather than mirrored from it.
 *
 * Auth: personal API key, per the Linear GraphQL API
 * ---------------------------------------------------
 * Linear speaks GraphQL at the single fixed endpoint
 * `https://api.linear.app/graphql`. An org supplies a personal API key created
 * under Linear → Settings → Security & access. Per
 * https://linear.app/developers/graphql the key is sent as
 * `Authorization: <API_KEY>` — **no `Bearer` prefix**; the Bearer form is for
 * OAuth access tokens only, which we do not use. The key is a bearer
 * credential for everything the Linear user can see, so it is encrypted at
 * rest with AAD `linear:<orgId>:apiKey` — the same mechanism the Jira API
 * token uses — and never leaves the server. The API returns
 * {@link LinearIntegrationRecord.keyHint} in its place.
 *
 * Issue descriptions are **markdown** (a plain string), in deliberate contrast
 * to Jira REST v3 where the description field is an Atlassian Document Format
 * JSON document — so there is no `toAdf` counterpart here; the plain text our
 * draft builder produces is already what `issueCreate` wants.
 *
 * Why there is no host allowlist here
 * -----------------------------------
 * `jira.ts` carries `ALLOWED_HOST_SUFFIXES` because the Jira site URL is
 * user-supplied and would otherwise be an org-member-triggerable SSRF out of
 * the cluster. Linear has no per-org host: every request goes to the fixed
 * `api.linear.app` origin baked in below, and no user input reaches the URL.
 * The asymmetry is deliberate, not an omission.
 *
 * Throwing vs. not throwing follows jira.ts exactly:
 *
 *   Ambient  — {@link isLinearConfigured}, {@link getLinearIntegration},
 *              {@link listLinearIssueLinks}. These run while rendering a list
 *              that is *about something else*; they log with `[linear]` and
 *              return an empty value rather than break the page.
 *
 *   User-initiated — {@link setLinearIntegration},
 *              {@link deleteLinearIntegration}, {@link verifyLinearCredentials},
 *              {@link listLinearTeams}, {@link createLinearIssue}. Somebody
 *              pressed a button and is waiting, so these throw
 *              {@link LinearApiError} with a message written for the user.
 */
import { and, desc, eq, inArray } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import { db } from "./db/client";
import { linearIntegrations, linearIssueLinks } from "./db/schema";
import { buildAad, decrypt, encrypt } from "./encryption";

/**
 * The one place Linear is reachable. GraphQL endpoint per
 * https://linear.app/developers/graphql — fixed for every workspace, which is
 * what makes a host allowlist unnecessary (see the module comment).
 */
export const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";

/** Abort Linear requests after 15s so a hung API can't stall a settings page. */
const LINEAR_REQUEST_TIMEOUT_MS = 15_000;

/**
 * Linear does not document a hard title ceiling the way Jira documents its
 * 255-character summary cap, so this is our own sanity cap, matched to Jira's
 * so the shared draft builder behaves identically for both trackers.
 */
const MAX_TITLE_CHARS = 255;

/**
 * Cap on the markdown description. Same reasoning as Jira's: findings
 * descriptions are composed from provider payloads, and nothing past 30k is
 * being read.
 */
const MAX_DESCRIPTION_CHARS = 30_000;

/** How many teams the picker loads in one page. */
const TEAMS_PAGE_SIZE = 100;

// --- Source kinds ---

/**
 * The detectors a filed issue can come from — the same six as Jira, mirrored
 * by a CHECK constraint on `linear_issue_links.source_kind` and by the zod
 * enum on the route. Duplicated rather than imported from `jira.ts` so either
 * integration can be removed without the other losing its constraint's source
 * of truth.
 */
export const LINEAR_SOURCE_KINDS = [
  "cost_anomaly",
  "orphan",
  "oversized",
  "posture_finding",
  "expiring",
  "probe",
] as const;

export type LinearSourceKind = (typeof LINEAR_SOURCE_KINDS)[number];

export function isLinearSourceKind(value: string): value is LinearSourceKind {
  return (LINEAR_SOURCE_KINDS as readonly string[]).includes(value);
}

// --- Errors ---

/**
 * A failure a user should see. `status` is the HTTP status where the call
 * reached Linear, or `null` for local failures (missing configuration,
 * network error) — the route maps that to 400 vs 502.
 */
export class LinearApiError extends Error {
  readonly status: number | null;

  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = "LinearApiError";
    this.status = status;
  }
}

interface LinearGraphqlErrorShape {
  message?: unknown;
  extensions?: { code?: unknown; userPresentableMessage?: unknown } | null;
}

/**
 * Turn Linear's GraphQL `errors` array into one line a user can act on.
 *
 * Linear answers errors in the standard GraphQL shape — an `errors` array on a
 * response that may still be HTTP 200 (partial success) or HTTP 400. Each
 * entry carries `message` and an `extensions.code`; the codes worth branching
 * on are `AUTHENTICATION_ERROR` (bad or revoked key) and `RATELIMITED`, which
 * Linear documents as arriving on an HTTP 400 when the 5,000 requests/hour
 * per-user budget for API-key auth is exhausted
 * (https://linear.app/developers/rate-limiting).
 */
export function describeLinearGraphqlErrors(errors: readonly LinearGraphqlErrorShape[]): string {
  const codes = new Set(
    errors
      .map((e) => (typeof e.extensions?.code === "string" ? e.extensions.code : null))
      .filter((c): c is string => c !== null),
  );

  if (codes.has("RATELIMITED")) {
    return "Linear is rate limiting this API key (5,000 requests/hour). Try again in a while.";
  }
  if (codes.has("AUTHENTICATION_ERROR")) {
    return "Linear rejected the API key. Create a fresh personal API key under Linear → Settings → Security & access, and re-enter it here.";
  }

  const messages = errors
    .map((e) => (typeof e.message === "string" ? e.message : ""))
    .filter((m) => m.length > 0);
  const detail = messages.join("; ").slice(0, 300);
  return detail ? `Linear returned an error — ${detail}` : "Linear returned an error";
}

/** Map an HTTP-level (non-GraphQL) failure onto one user-readable line. */
export function describeLinearHttpError(status: number, body: string): string {
  const trimmed = body.trim().slice(0, 200);
  const suffix = trimmed ? ` — ${trimmed}` : "";
  switch (status) {
    case 401:
    case 403:
      return "Linear rejected the API key. Create a fresh personal API key under Linear → Settings → Security & access, and re-enter it here.";
    case 429:
      return "Linear is rate limiting this API key. Try again in a while.";
    default:
      return status >= 500
        ? `Linear is unavailable (HTTP ${status})${suffix}`
        : `Linear returned HTTP ${status}${suffix}`;
  }
}

// --- Transport ---

/**
 * One authenticated GraphQL call. Throws {@link LinearApiError} on transport
 * failure, a non-2xx status, or a response carrying GraphQL errors — every
 * caller here is user-initiated, so a failure has somebody waiting on it.
 */
async function linearGraphql<T>(
  apiKey: string,
  query: string,
  variables: Record<string, unknown> = {},
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(LINEAR_GRAPHQL_URL, {
      method: "POST",
      signal: AbortSignal.timeout(LINEAR_REQUEST_TIMEOUT_MS),
      headers: {
        // Personal API keys are sent bare, NOT as `Bearer <key>` — that form
        // is for OAuth tokens only. Per https://linear.app/developers/graphql.
        Authorization: apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, variables }),
    });
  } catch (err) {
    // DNS/TLS failure or our own 15s timeout. Unlike Jira the host is ours and
    // fixed, so this is "Linear (or our egress) is down", not "check the URL".
    const reason = err instanceof Error ? err.message : String(err);
    throw new LinearApiError(`Could not reach Linear: ${reason}`);
  }

  const text = await res.text().catch(() => "");
  let parsed: { data?: T; errors?: LinearGraphqlErrorShape[] } | null = null;
  try {
    parsed = JSON.parse(text) as { data?: T; errors?: LinearGraphqlErrorShape[] };
  } catch {
    // An HTML error page from a proxy, most likely.
  }

  // GraphQL errors take precedence over the bare status: Linear reports rate
  // limiting and auth failures as an errors array (sometimes on HTTP 400,
  // sometimes 200 with partial data), and that array carries the actionable
  // wording.
  if (parsed?.errors && parsed.errors.length > 0) {
    throw new LinearApiError(describeLinearGraphqlErrors(parsed.errors), res.status);
  }
  if (!res.ok) {
    throw new LinearApiError(describeLinearHttpError(res.status, text), res.status);
  }
  if (!parsed || parsed.data === undefined || parsed.data === null) {
    throw new LinearApiError("Linear returned an empty response", res.status);
  }
  return parsed.data;
}

// --- Storage ---

/**
 * The integration as clients see it. Deliberately absent: the API key. It is
 * represented only by {@link keyHint}, so no code path can leak it by adding a
 * field to a response.
 */
export interface LinearIntegrationRecord {
  /** Redacted marker for the stored API key, e.g. `…a7f2`. Never the key. */
  keyHint: string;
  /** Team the "File in Linear" modal preselects. */
  defaultTeamId: string | null;
  updatedAt: string;
}

/** Last four characters, which is enough to tell two keys apart. */
function keyHintFor(apiKey: string): string {
  return `…${apiKey.slice(-4)}`;
}

function toIntegrationRecord(row: typeof linearIntegrations.$inferSelect): LinearIntegrationRecord {
  return {
    keyHint: row.keyHint,
    defaultTeamId: row.defaultTeamId,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * The org's integration, redacted, or `null` when there isn't one.
 * Ambient: never throws — see the module comment.
 */
export async function getLinearIntegration(
  organizationId: string,
): Promise<LinearIntegrationRecord | null> {
  try {
    const [row] = await db
      .select()
      .from(linearIntegrations)
      .where(eq(linearIntegrations.organizationId, organizationId))
      .limit(1);
    return row ? toIntegrationRecord(row) : null;
  } catch (err) {
    console.error("[linear] failed to load integration for org", organizationId, err);
    return null;
  }
}

/**
 * Whether the org can file issues into Linear. Ambient: never throws — this
 * gates a button on pages that are about something else entirely.
 */
export async function isLinearConfigured(organizationId: string): Promise<boolean> {
  return (await getLinearIntegration(organizationId)) !== null;
}

/**
 * Decrypt the stored API key. Internal: the plaintext key must not leave this
 * module. Returns `null` when the org has no integration; throws when the row
 * exists but cannot be opened, because that is a real fault the user needs
 * told about rather than a silent "not configured".
 */
async function loadLinearApiKey(organizationId: string): Promise<string | null> {
  const [row] = await db
    .select()
    .from(linearIntegrations)
    .where(eq(linearIntegrations.organizationId, organizationId))
    .limit(1);
  if (!row) return null;

  try {
    return await decrypt(
      row.encryptedApiKey,
      row.apiKeyIv,
      buildAad("linear", organizationId, "apiKey"),
    );
  } catch (err) {
    console.error("[linear] failed to decrypt API key for org", organizationId, err);
    throw new LinearApiError(
      "The stored Linear API key could not be read. Re-enter it in Settings → Linear.",
    );
  }
}

/** Same, but raising the "not configured" case as a user-readable error. */
async function requireLinearApiKey(organizationId: string): Promise<string> {
  const apiKey = await loadLinearApiKey(organizationId);
  if (!apiKey) {
    throw new LinearApiError("Linear is not connected for this organization.");
  }
  return apiKey;
}

export interface SetLinearIntegrationArgs {
  organizationId: string;
  userId?: string | null;
  /**
   * The personal API key. Optional on update: the settings form only ever
   * shows the redacted hint, so an omitted key means "keep the stored one"
   * rather than "clear it". Required when there is no existing row.
   */
  apiKey?: string | undefined;
  defaultTeamId?: string | null | undefined;
}

/**
 * Create or replace the org's integration. User-initiated: throws, so a
 * missing key on first connect is reported on the form rather than discovered
 * on the first attempt to file.
 */
export async function setLinearIntegration(
  args: SetLinearIntegrationArgs,
): Promise<LinearIntegrationRecord> {
  const { organizationId } = args;

  const apiKey = args.apiKey?.trim();
  const existing = await db
    .select()
    .from(linearIntegrations)
    .where(eq(linearIntegrations.organizationId, organizationId))
    .limit(1);
  const prior = existing[0];

  if (!apiKey && !prior) {
    throw new LinearApiError("An API key is required to connect Linear");
  }

  // Re-encrypt even when the key is unchanged: a fresh IV costs nothing and
  // keeps the stored ciphertext from being a stable fingerprint of the key.
  const aad = buildAad("linear", organizationId, "apiKey");
  const enc = apiKey ? await encrypt(apiKey, aad) : null;
  const now = new Date();

  const values = {
    ...(enc && apiKey
      ? { encryptedApiKey: enc.ciphertext, apiKeyIv: enc.iv, keyHint: keyHintFor(apiKey) }
      : {}),
    defaultTeamId: args.defaultTeamId?.trim() || null,
    updatedAt: now,
  };

  const [row] = await db
    .insert(linearIntegrations)
    .values({
      organizationId,
      createdByUserId: args.userId ?? null,
      // Non-null at this point: the guard above rejects a first save with no
      // key, so `enc`/`apiKey` are set whenever `prior` is absent.
      encryptedApiKey: enc?.ciphertext ?? prior?.encryptedApiKey ?? "",
      apiKeyIv: enc?.iv ?? prior?.apiKeyIv ?? "",
      keyHint: apiKey ? keyHintFor(apiKey) : (prior?.keyHint ?? ""),
      ...values,
    })
    .onConflictDoUpdate({ target: linearIntegrations.organizationId, set: values })
    .returning();

  if (!row) throw new LinearApiError("Failed to save the Linear connection");
  return toIntegrationRecord(row);
}

/** Remove the org's integration. Returns false when there was nothing to remove. */
export async function deleteLinearIntegration(organizationId: string): Promise<boolean> {
  const deleted = await db
    .delete(linearIntegrations)
    .where(eq(linearIntegrations.organizationId, organizationId))
    .returning({ organizationId: linearIntegrations.organizationId });
  return deleted.length > 0;
}

// --- Linear calls ---

export interface LinearVerifiedUser {
  id: string;
  name: string;
  email: string | null;
}

/**
 * The cheapest authenticated call Linear offers: the `viewer` query returns
 * the user behind the API key. Save runs this so a mistyped or revoked key is
 * reported on the form, rather than surfacing days later as a failed filing.
 *
 * User-initiated: throws.
 */
export async function verifyLinearCredentials(apiKey: string): Promise<LinearVerifiedUser> {
  const key = apiKey.trim();
  if (!key) throw new LinearApiError("An API key is required");

  const data = await linearGraphql<{
    viewer?: { id?: string; name?: string; email?: string | null };
  }>(key, "query Me { viewer { id name email } }");

  return {
    id: data.viewer?.id ?? "",
    name: data.viewer?.name ?? "",
    email: data.viewer?.email ?? null,
  };
}

/** Verify the key already stored for the org. User-initiated: throws. */
export async function verifyStoredLinearCredentials(
  organizationId: string,
): Promise<LinearVerifiedUser> {
  return verifyLinearCredentials(await requireLinearApiKey(organizationId));
}

export interface LinearTeam {
  id: string;
  /** Short prefix issue identifiers are built from, e.g. `ENG` in `ENG-123`. */
  key: string;
  name: string;
}

/**
 * Teams the stored key can see, for the team picker — every Linear issue
 * belongs to exactly one team, so `issueCreate` requires a `teamId`, and
 * nobody should be typing a team UUID by hand.
 *
 * User-initiated: throws. A picker that silently comes back empty is
 * indistinguishable from a workspace with no teams, which is the one thing
 * the user must not be left guessing about.
 */
export async function listLinearTeams(organizationId: string): Promise<LinearTeam[]> {
  const apiKey = await requireLinearApiKey(organizationId);
  const data = await linearGraphql<{
    teams?: { nodes?: Array<{ id?: string; key?: string; name?: string }> };
  }>(apiKey, `query Teams($first: Int!) { teams(first: $first) { nodes { id key name } } }`, {
    first: TEAMS_PAGE_SIZE,
  });

  return (data.teams?.nodes ?? [])
    .filter((t): t is { id: string; key: string; name: string } => Boolean(t.id && t.key && t.name))
    .map((t) => ({ id: t.id, key: t.key, name: t.name }));
}

export interface CreateLinearIssueArgs {
  organizationId: string;
  teamId: string;
  title: string;
  /**
   * Markdown. This is the contrast with Jira: REST v3 wants an Atlassian
   * Document Format JSON document and silently mangles a plain string, while
   * Linear's `issueCreate` takes markdown directly — so the plain text the
   * shared draft builder produces goes through untouched.
   */
  description?: string | undefined;
  /** Existing label ids (UUIDs). Optional; Linear cannot create labels here. */
  labelIds?: readonly string[] | undefined;
  /** Optional project to attach the issue to. */
  projectId?: string | undefined;
}

export interface CreatedLinearIssue {
  id: string;
  /** Human identifier, e.g. `ENG-123`. */
  identifier: string;
  url: string;
}

/**
 * File an issue via the `issueCreate` mutation
 * (https://linear.app/developers/graphql, "Creating and editing issues").
 * User-initiated: throws, and deliberately so — this is the one call in the
 * module where swallowing the error would tell somebody their work is tracked
 * when no issue exists.
 */
export async function createLinearIssue(args: CreateLinearIssueArgs): Promise<CreatedLinearIssue> {
  const title = args.title.trim().slice(0, MAX_TITLE_CHARS);
  if (!title) throw new LinearApiError("A title is required");
  if (!args.teamId.trim()) throw new LinearApiError("A team is required");

  const apiKey = await requireLinearApiKey(args.organizationId);
  const description = args.description?.slice(0, MAX_DESCRIPTION_CHARS);
  const labelIds = (args.labelIds ?? []).filter((id) => id.trim().length > 0);

  const input: Record<string, unknown> = {
    teamId: args.teamId.trim(),
    title,
    // Optional fields are omitted rather than sent as null, mirroring the Jira
    // payload builder: absent means absent.
    ...(description ? { description } : {}),
    ...(labelIds.length > 0 ? { labelIds } : {}),
    ...(args.projectId?.trim() ? { projectId: args.projectId.trim() } : {}),
  };

  const data = await linearGraphql<{
    issueCreate?: {
      success?: boolean;
      issue?: { id?: string; identifier?: string; url?: string };
    };
  }>(
    apiKey,
    `mutation IssueCreate($input: IssueCreateInput!) {
      issueCreate(input: $input) { success issue { id identifier url } }
    }`,
    { input },
  );

  const issue = data.issueCreate?.issue;
  if (!data.issueCreate?.success || !issue?.identifier || !issue.url) {
    throw new LinearApiError("Linear accepted the request but returned no issue");
  }
  return { id: issue.id ?? "", identifier: issue.identifier, url: issue.url };
}

// --- Links ---

export interface LinearIssueLink {
  id: string;
  sourceKind: LinearSourceKind;
  sourceId: string;
  /** e.g. `ENG-123`. */
  issueIdentifier: string;
  issueUrl: string;
  createdByUserId: string | null;
  createdAt: string;
}

function toLinkRecord(row: typeof linearIssueLinks.$inferSelect): LinearIssueLink {
  return {
    id: row.id,
    sourceKind: row.sourceKind as LinearSourceKind,
    sourceId: row.sourceId,
    issueIdentifier: row.issueIdentifier,
    issueUrl: row.issueUrl,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt.toISOString(),
  };
}

export interface RecordLinearIssueLinkArgs {
  organizationId: string;
  userId?: string | null;
  sourceKind: LinearSourceKind;
  sourceId: string;
  issueIdentifier: string;
  issueUrl: string;
}

/**
 * Remember that a finding was filed. Idempotent on
 * (org, kind, source, identifier) so a retried request cannot double-file —
 * the issue already exists in Linear at this point, and the row is what stops
 * the UI offering the button again.
 *
 * Called immediately after a successful create, so it throws: a link the
 * caller believes was written but wasn't means the next page load offers to
 * file a duplicate.
 */
export async function recordLinearIssueLink(
  args: RecordLinearIssueLinkArgs,
): Promise<LinearIssueLink> {
  const [row] = await db
    .insert(linearIssueLinks)
    .values({
      id: randomUUID(),
      organizationId: args.organizationId,
      sourceKind: args.sourceKind,
      sourceId: args.sourceId,
      issueIdentifier: args.issueIdentifier,
      issueUrl: args.issueUrl,
      createdByUserId: args.userId ?? null,
    })
    .onConflictDoUpdate({
      target: [
        linearIssueLinks.organizationId,
        linearIssueLinks.sourceKind,
        linearIssueLinks.sourceId,
        linearIssueLinks.issueIdentifier,
      ],
      set: { issueUrl: args.issueUrl },
    })
    .returning();

  if (!row) throw new LinearApiError("Failed to record the Linear issue link");
  return toLinkRecord(row);
}

export interface ListLinearIssueLinksFilter {
  sourceKind?: LinearSourceKind | undefined;
  /** Restrict to these finding ids. Empty/absent means every id of the kind. */
  sourceIds?: readonly string[] | undefined;
}

/**
 * Links for the org, optionally narrowed to one kind and a set of finding ids.
 *
 * This is the batch lookup a list view calls **once** before rendering, instead
 * of one request per row. Ambient: never throws — a cost page must render even
 * if this lookup fails, just without the "already filed" markers.
 */
export async function listLinearIssueLinks(
  organizationId: string,
  filter: ListLinearIssueLinksFilter = {},
): Promise<LinearIssueLink[]> {
  try {
    const conditions = [eq(linearIssueLinks.organizationId, organizationId)];
    if (filter.sourceKind) {
      conditions.push(eq(linearIssueLinks.sourceKind, filter.sourceKind));
    }
    if (filter.sourceIds && filter.sourceIds.length > 0) {
      conditions.push(inArray(linearIssueLinks.sourceId, [...filter.sourceIds]));
    }

    const rows = await db
      .select()
      .from(linearIssueLinks)
      .where(and(...conditions))
      .orderBy(desc(linearIssueLinks.createdAt));
    return rows.map(toLinkRecord);
  } catch (err) {
    console.error("[linear] failed to list issue links for org", organizationId, err);
    return [];
  }
}
