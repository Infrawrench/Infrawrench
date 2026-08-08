/**
 * Jira Cloud as an issue tracker for findings.
 *
 * Infrawrench detects things a human has to act on — cost anomalies, orphaned
 * and oversized resources, posture findings, expiring credentials, failed
 * probes. This module turns any of them into a Jira issue and remembers the
 * link, so a findings list can render "already filed as OPS-412" instead of
 * offering the button a second time.
 *
 * Auth: basic, per the Jira Cloud REST API
 * -----------------------------------------
 * An org supplies its site URL (`https://acme.atlassian.net`), an Atlassian
 * account email, and an API token created at id.atlassian.com. Every request
 * carries `Authorization: Basic base64(email:apiToken)`. Atlassian deprecated
 * passwords for this; the API token is the supported credential and it is a
 * bearer credential for that whole Atlassian account, so it is encrypted at
 * rest with AAD `jira:<orgId>:apiToken` — the same mechanism the Twilio auth
 * token and the Teams webhook URL use — and never leaves the server. The API
 * returns {@link JiraIntegrationRecord.tokenHint} in its place.
 *
 * We speak REST API **v3**, whose distinguishing feature over v2 is that rich
 * text fields (`description`, `environment`, and multi-line custom fields) are
 * Atlassian Document Format — a JSON document, not a string. Passing a plain
 * string to v3 does not error; it writes the raw characters into the field, so
 * {@link toAdf} is not optional politeness, it is what makes the description
 * render at all. See {@link buildCreateIssuePayload}.
 *
 * Config (env): none. Every credential is per-org and lives in the database —
 * there is no app to register, so Jira filing works on every deployment,
 * self-hosted included, the moment an org saves its site details.
 *
 * Throwing vs. not throwing
 * ------------------------
 * The house rule is that a transport never throws into a caller that cannot do
 * anything about it. That splits this module in two, and the split is load-
 * bearing rather than stylistic:
 *
 *   Ambient  — {@link isJiraConfigured}, {@link getJiraIntegration},
 *              {@link listJiraIssueLinks}. These run while rendering a list
 *              that is *about something else*; a Jira or database hiccup must
 *              degrade to "no badge, no button", never to a broken cost page.
 *              They log with `[jira]` and return an empty value.
 *
 *   User-initiated — {@link setJiraIntegration}, {@link deleteJiraIntegration},
 *              {@link verifyJiraCredentials}, {@link listJiraProjects},
 *              {@link listJiraIssueTypes}, {@link createJiraIssue}. Somebody
 *              pressed a button and is waiting. Swallowing here would report
 *              success for an issue that was never created, so these throw
 *              {@link JiraApiError} with a message written for the user, and
 *              the route turns it into a 4xx/502 they can read.
 *
 * Why there is no bastion registry entry
 * --------------------------------------
 * `bastion/registry.ts` maps *plugin ids* to egress hostnames for a customer's
 * bastion agent, keyed off `accounts.pluginId`. Jira is an org integration, not
 * a plugin: it has no account row, and these requests originate in the web
 * process rather than through a bastion dispatcher, so there is nothing for the
 * registry to key on. The equivalent control lives here instead, as
 * {@link ALLOWED_HOST_SUFFIXES} — without it, "paste a URL" would be an
 * org-member-triggerable SSRF out of the cluster, exactly as it would be for
 * Teams webhooks.
 */
import { and, desc, eq, inArray } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import { db } from "./db/client";
import { jiraIntegrations, jiraIssueLinks } from "./db/schema";
import { buildAad, decrypt, encrypt } from "./encryption";

/** Abort Jira requests after 15s so a hung site can't stall a settings page. */
const JIRA_REQUEST_TIMEOUT_MS = 15_000;

/**
 * Hosts a Jira site URL is allowed to point at. Jira Cloud sites are issued as
 * `<site>.atlassian.net`; `<site>.jira.com` is the legacy form some long-lived
 * sites still answer on. Atlassian's custom-domain feature covers the Jira
 * Service Management *help centre* only — the REST API stays on the Atlassian
 * host — so this list does not cost anyone a working configuration.
 *
 * This is a security control, not a convenience: it is the only thing between
 * a member pasting a URL and an outbound request to an arbitrary address from
 * inside the cluster.
 */
const ALLOWED_HOST_SUFFIXES = [".atlassian.net", ".jira.com"] as const;

/** Jira caps summaries at 255 characters and rejects anything longer. */
const MAX_SUMMARY_CHARS = 255;

/**
 * Jira text fields cap at 32,767 characters. Findings descriptions are built
 * from provider payloads, so they are truncated well short of the ceiling —
 * a rejected issue helps nobody, and nothing past 30k is being read.
 */
const MAX_DESCRIPTION_CHARS = 30_000;

/** Jira rejects labels containing whitespace and caps each at 255 characters. */
const MAX_LABEL_CHARS = 255;

/** Sanity cap on labels per issue. Findings contribute a handful; this is slack. */
const MAX_LABELS = 20;

/** How many projects/issue types a picker loads. Jira caps `maxResults` at 100. */
const PICKER_PAGE_SIZE = 100;

// --- Source kinds ---

/**
 * The detectors a filed issue can come from. Mirrored by a CHECK constraint on
 * `jira_issue_links.source_kind` and by the zod enum on the route — these rows
 * outlive any one code path, and an unrecognised kind would strand the link
 * where no UI looks for it.
 */
export const JIRA_SOURCE_KINDS = [
  "cost_anomaly",
  "orphan",
  "oversized",
  "posture_finding",
  "expiring",
  "probe",
] as const;

export type JiraSourceKind = (typeof JIRA_SOURCE_KINDS)[number];

export function isJiraSourceKind(value: string): value is JiraSourceKind {
  return (JIRA_SOURCE_KINDS as readonly string[]).includes(value);
}

// --- Errors ---

/**
 * A failure a user should see. `status` is the Jira HTTP status where the call
 * reached Jira, or `null` for local failures (bad URL, missing configuration,
 * network error) — the route maps that to 400 vs 502.
 */
export class JiraApiError extends Error {
  readonly status: number | null;

  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = "JiraApiError";
    this.status = status;
  }
}

/**
 * Turn a Jira error response into one line a user can act on.
 *
 * Jira answers errors with `{ errorMessages: string[], errors: {field: msg} }`.
 * Both halves matter: `errorMessages` carries "Issue type is required", while
 * `errors` carries the per-field detail ("customfield_10010: Sprint is
 * required") that explains why an otherwise valid create was refused. Status
 * alone is close to useless for 400 and 422, which is where this lands most.
 */
export function describeJiraError(status: number, body: string): string {
  const detail = extractJiraErrorDetail(body);
  const suffix = detail ? ` — ${detail}` : "";

  switch (status) {
    case 400:
      return `Jira rejected the request (400)${suffix || " — the issue fields were not accepted."}`;
    case 401:
      return "Jira rejected the credentials (401). Check the account email, and create a fresh API token if the old one was revoked.";
    case 403:
      return `Jira accepted the credentials but refused the action (403). The account needs Browse Projects and Create Issues on this project${suffix}`;
    case 404:
      return `Jira returned 404${suffix || " — check the site URL, and that the project still exists and is visible to this account."}`;
    case 429:
      return "Jira is rate limiting this site (429). Try again in a moment.";
    case 422:
      return `Jira could not create the issue with this configuration (422)${suffix || " — the project likely has a required field with no default."}`;
    default:
      return status >= 500
        ? `Jira is unavailable (HTTP ${status})${suffix}`
        : `Jira returned HTTP ${status}${suffix}`;
  }
}

/** Pull the readable part out of a Jira error body, tolerating non-JSON. */
function extractJiraErrorDetail(body: string): string {
  const trimmed = body.trim();
  if (!trimmed) return "";

  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object") {
      const record = parsed as { errorMessages?: unknown; errors?: unknown };
      const parts: string[] = [];
      if (Array.isArray(record.errorMessages)) {
        parts.push(...record.errorMessages.filter((m): m is string => typeof m === "string"));
      }
      if (record.errors && typeof record.errors === "object") {
        for (const [field, message] of Object.entries(record.errors as Record<string, unknown>)) {
          if (typeof message === "string") parts.push(`${field}: ${message}`);
        }
      }
      if (parts.length > 0) return parts.join("; ").slice(0, 300);
    }
  } catch {
    // Not JSON — an HTML error page from a proxy, most likely.
  }
  return trimmed.slice(0, 200);
}

// --- Site URL ---

export interface ParsedJiraSite {
  /** Normalized origin with no trailing slash, e.g. `https://acme.atlassian.net`. */
  siteUrl: string;
  /** Hostname, lowercased. */
  host: string;
}

/**
 * Validate a pasted Jira site URL and normalize it to a bare origin. Throws
 * with wording meant for the user — this runs on the settings form, so the
 * message is what they will read.
 *
 * Users paste all sorts of things they are looking at: a board URL, an issue
 * URL, a URL with a trailing slash. All of those carry the right origin, so
 * the path is discarded rather than rejected.
 */
export function parseJiraSiteUrl(raw: string): ParsedJiraSite {
  const trimmed = raw.trim();
  if (!trimmed) throw new JiraApiError("Jira site URL is required");

  // Accept `acme.atlassian.net` as readily as the full URL — the scheme is not
  // information the user has any decision to make about.
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    throw new JiraApiError(
      "That doesn't look like a URL. Expected https://your-site.atlassian.net",
    );
  }

  if (parsed.protocol !== "https:") {
    throw new JiraApiError("Jira site URL must use https");
  }

  const host = parsed.hostname.toLowerCase();
  if (!ALLOWED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    throw new JiraApiError(
      `${host} is not a Jira Cloud site. Use the address you sign in at — it ends in .atlassian.net (older sites may use .jira.com).`,
    );
  }

  return { siteUrl: `https://${host}`, host };
}

/** The browse URL for an issue key, which is what a human wants to click. */
export function issueBrowseUrl(siteUrl: string, issueKey: string): string {
  return `${siteUrl.replace(/\/+$/, "")}/browse/${encodeURIComponent(issueKey)}`;
}

// --- ADF ---

/** An Atlassian Document Format node. Loose by design — we only emit three kinds. */
export interface AdfNode {
  type: string;
  text?: string;
  content?: AdfNode[];
}

export interface AdfDocument {
  type: "doc";
  version: 1;
  content: AdfNode[];
}

/**
 * Convert plain text into an Atlassian Document Format document.
 *
 * REST API v3 types `description` as an ADF document, so a plain string is
 * written verbatim into the field rather than rendered — the user sees their
 * text but loses every line break, and a JSON-shaped string would be displayed
 * as JSON. We compose descriptions ourselves from finding data, so plain text
 * in, structured document out, is the whole contract: blank lines separate
 * paragraphs, single newlines become hard breaks.
 *
 * Returns `null` for text with no content — a `doc` with an empty `content`
 * array is not valid ADF, so callers omit the field entirely instead.
 */
export function toAdf(text: string): AdfDocument | null {
  const truncated = text.slice(0, MAX_DESCRIPTION_CHARS);
  const blocks = truncated.split(/\n{2,}/);

  const content: AdfNode[] = [];
  for (const block of blocks) {
    // A block that is only whitespace would otherwise become a paragraph whose
    // sole text node is spaces — visually empty, but enough to make the
    // "no content" check below think there is content.
    if (block.trim().length === 0) continue;

    const lines = block.split("\n");
    const inline: AdfNode[] = [];
    for (const [index, line] of lines.entries()) {
      if (index > 0) inline.push({ type: "hardBreak" });
      if (line.length > 0) inline.push({ type: "text", text: line });
    }
    content.push({ type: "paragraph", content: inline });
  }

  if (content.length === 0) return null;
  return { type: "doc", version: 1, content };
}

/**
 * Normalize labels to what Jira accepts: no whitespace (Jira rejects the whole
 * request for a label containing a space), no duplicates, nothing empty, and a
 * sane count. Comparison is case-sensitive because Jira's labels are.
 */
export function sanitizeJiraLabels(labels: readonly string[] | undefined): string[] {
  if (!labels || labels.length === 0) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of labels) {
    const label = raw.trim().replace(/\s+/g, "-").slice(0, MAX_LABEL_CHARS);
    if (!label || seen.has(label)) continue;
    seen.add(label);
    out.push(label);
    if (out.length >= MAX_LABELS) break;
  }
  return out;
}

export interface CreateIssueFields {
  projectKey: string;
  issueTypeId: string;
  summary: string;
  description?: string | undefined;
  labels?: readonly string[] | undefined;
}

/**
 * Build the body for `POST /rest/api/3/issue`.
 *
 * Shape per the v3 spec: everything lives under `fields`; the project is
 * `{key}` (or `{id}`), the type is `{id}` — names are not accepted and would
 * break the moment an org renamed a type — and `description` is ADF. Optional
 * fields are omitted rather than sent as null, because Jira validates a
 * present-but-empty field against the project's field configuration and can
 * refuse the create over it.
 */
export function buildCreateIssuePayload(fields: CreateIssueFields): {
  fields: Record<string, unknown>;
} {
  const summary = fields.summary.trim().slice(0, MAX_SUMMARY_CHARS);
  const description = fields.description ? toAdf(fields.description) : null;
  const labels = sanitizeJiraLabels(fields.labels);

  return {
    fields: {
      project: { key: fields.projectKey },
      issuetype: { id: fields.issueTypeId },
      summary,
      ...(description ? { description } : {}),
      ...(labels.length > 0 ? { labels } : {}),
    },
  };
}

// --- Transport ---

export interface JiraCredentials {
  siteUrl: string;
  accountEmail: string;
  apiToken: string;
}

/** `Authorization: Basic base64(email:apiToken)`, per Jira Cloud basic auth. */
export function basicAuthHeader(accountEmail: string, apiToken: string): string {
  return `Basic ${Buffer.from(`${accountEmail}:${apiToken}`, "utf8").toString("base64")}`;
}

/**
 * One authenticated Jira call. Throws {@link JiraApiError} on anything that is
 * not a 2xx — every caller of this is user-initiated, so a failure has somebody
 * waiting on it.
 */
async function jiraFetch<T>(
  creds: JiraCredentials,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const url = `${creds.siteUrl}${path}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: init.method ?? "GET",
      signal: AbortSignal.timeout(JIRA_REQUEST_TIMEOUT_MS),
      headers: {
        Authorization: basicAuthHeader(creds.accountEmail, creds.apiToken),
        Accept: "application/json",
        ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
  } catch (err) {
    // DNS failure, TLS failure, or our own 15s timeout. The site host is
    // user-supplied, so "we never reached Jira" is a likely and distinct
    // outcome from "Jira said no", and the user needs to be told which.
    const reason = err instanceof Error ? err.message : String(err);
    throw new JiraApiError(`Could not reach ${creds.siteUrl}: ${reason}`);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new JiraApiError(describeJiraError(res.status, body), res.status);
  }

  // 204s (none of ours today, but DELETEs answer this way) have no body.
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

// --- Storage ---

/**
 * The integration as clients see it. Deliberately absent: the API token. It is
 * represented only by {@link tokenHint}, so no code path can leak it by adding
 * a field to a response.
 */
export interface JiraIntegrationRecord {
  siteUrl: string;
  accountEmail: string;
  /** Redacted marker for the stored token, e.g. `…a7f2`. Never the token. */
  tokenHint: string;
  defaultProjectKey: string | null;
  defaultIssueTypeId: string | null;
  updatedAt: string;
}

/** Last four characters, which is enough to tell two tokens apart. */
function tokenHintFor(apiToken: string): string {
  return `…${apiToken.slice(-4)}`;
}

function toIntegrationRecord(row: typeof jiraIntegrations.$inferSelect): JiraIntegrationRecord {
  return {
    siteUrl: row.siteUrl,
    accountEmail: row.accountEmail,
    tokenHint: row.tokenHint,
    defaultProjectKey: row.defaultProjectKey,
    defaultIssueTypeId: row.defaultIssueTypeId,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * The org's integration, redacted, or `null` when there isn't one.
 *
 * Ambient: never throws. Every caller treats `null` as "show the connect
 * form" / "don't offer the file button", which is the right behaviour for both
 * "not configured" and "the database was briefly unreachable" — the alternative
 * is a settings page that 500s instead of degrading.
 */
export async function getJiraIntegration(
  organizationId: string,
): Promise<JiraIntegrationRecord | null> {
  try {
    const [row] = await db
      .select()
      .from(jiraIntegrations)
      .where(eq(jiraIntegrations.organizationId, organizationId))
      .limit(1);
    return row ? toIntegrationRecord(row) : null;
  } catch (err) {
    console.error("[jira] failed to load integration for org", organizationId, err);
    return null;
  }
}

/**
 * Whether the org can file issues. Ambient: never throws — this gates a button
 * on pages that are about something else entirely.
 */
export async function isJiraConfigured(organizationId: string): Promise<boolean> {
  return (await getJiraIntegration(organizationId)) !== null;
}

/**
 * Decrypt the stored credentials. Internal: the plaintext token must not leave
 * this module. Returns `null` when the org has no integration; throws when the
 * row exists but cannot be opened, because that is a real fault the user needs
 * told about rather than a silent "not configured".
 */
async function loadJiraCredentials(organizationId: string): Promise<JiraCredentials | null> {
  const [row] = await db
    .select()
    .from(jiraIntegrations)
    .where(eq(jiraIntegrations.organizationId, organizationId))
    .limit(1);
  if (!row) return null;

  try {
    const apiToken = await decrypt(
      row.encryptedApiToken,
      row.apiTokenIv,
      buildAad("jira", organizationId, "apiToken"),
    );
    return { siteUrl: row.siteUrl, accountEmail: row.accountEmail, apiToken };
  } catch (err) {
    console.error("[jira] failed to decrypt API token for org", organizationId, err);
    throw new JiraApiError(
      "The stored Jira API token could not be read. Re-enter it in Settings → Jira.",
    );
  }
}

/** Same, but raising the "not configured" case as a user-readable error. */
async function requireJiraCredentials(organizationId: string): Promise<JiraCredentials> {
  const creds = await loadJiraCredentials(organizationId);
  if (!creds) {
    throw new JiraApiError("Jira is not connected for this organization.");
  }
  return creds;
}

export interface SetJiraIntegrationArgs {
  organizationId: string;
  userId?: string | null;
  siteUrl: string;
  accountEmail: string;
  /**
   * The API token. Optional on update: the settings form only ever shows the
   * redacted hint, so an omitted token means "keep the stored one" rather than
   * "clear it". Required when there is no existing row.
   */
  apiToken?: string | undefined;
  defaultProjectKey?: string | null | undefined;
  defaultIssueTypeId?: string | null | undefined;
}

/**
 * Create or replace the org's integration. User-initiated: throws, so a bad
 * site URL or a missing token is reported on the form rather than discovered
 * on the first attempt to file.
 */
export async function setJiraIntegration(
  args: SetJiraIntegrationArgs,
): Promise<JiraIntegrationRecord> {
  const { organizationId } = args;
  const { siteUrl } = parseJiraSiteUrl(args.siteUrl);

  const accountEmail = args.accountEmail.trim();
  if (!accountEmail) throw new JiraApiError("Atlassian account email is required");

  const apiToken = args.apiToken?.trim();
  const existing = await db
    .select()
    .from(jiraIntegrations)
    .where(eq(jiraIntegrations.organizationId, organizationId))
    .limit(1);
  const prior = existing[0];

  if (!apiToken && !prior) {
    throw new JiraApiError("An API token is required to connect Jira");
  }

  // Re-encrypt even when the token is unchanged: a fresh IV costs nothing and
  // keeps the stored ciphertext from being a stable fingerprint of the token.
  const aad = buildAad("jira", organizationId, "apiToken");
  const enc = apiToken ? await encrypt(apiToken, aad) : null;
  const now = new Date();

  const values = {
    siteUrl,
    accountEmail,
    ...(enc && apiToken
      ? { encryptedApiToken: enc.ciphertext, apiTokenIv: enc.iv, tokenHint: tokenHintFor(apiToken) }
      : {}),
    defaultProjectKey: args.defaultProjectKey?.trim() || null,
    defaultIssueTypeId: args.defaultIssueTypeId?.trim() || null,
    updatedAt: now,
  };

  const [row] = await db
    .insert(jiraIntegrations)
    .values({
      organizationId,
      createdByUserId: args.userId ?? null,
      // Non-null at this point: the guard above rejects a first save with no
      // token, so `enc`/`apiToken` are set whenever `prior` is absent.
      encryptedApiToken: enc?.ciphertext ?? prior?.encryptedApiToken ?? "",
      apiTokenIv: enc?.iv ?? prior?.apiTokenIv ?? "",
      tokenHint: apiToken ? tokenHintFor(apiToken) : (prior?.tokenHint ?? ""),
      ...values,
    })
    .onConflictDoUpdate({ target: jiraIntegrations.organizationId, set: values })
    .returning();

  if (!row) throw new JiraApiError("Failed to save the Jira connection");
  return toIntegrationRecord(row);
}

/** Remove the org's integration. Returns false when there was nothing to remove. */
export async function deleteJiraIntegration(organizationId: string): Promise<boolean> {
  const deleted = await db
    .delete(jiraIntegrations)
    .where(eq(jiraIntegrations.organizationId, organizationId))
    .returning({ organizationId: jiraIntegrations.organizationId });
  return deleted.length > 0;
}

// --- Jira calls ---

export interface JiraVerifiedAccount {
  accountId: string;
  displayName: string;
  emailAddress: string | null;
}

/**
 * The cheapest authenticated call Jira offers: `GET /rest/api/3/myself` returns
 * the account behind the credentials and needs no permission beyond access to
 * Jira. Save runs this so a typo'd email or a revoked token is reported on the
 * form, rather than surfacing days later as a failed filing.
 *
 * User-initiated: throws.
 */
export async function verifyJiraCredentials(creds: JiraCredentials): Promise<JiraVerifiedAccount> {
  const { siteUrl } = parseJiraSiteUrl(creds.siteUrl);
  const me = await jiraFetch<{
    accountId?: string;
    displayName?: string;
    emailAddress?: string | null;
  }>({ ...creds, siteUrl }, "/rest/api/3/myself");

  return {
    accountId: me.accountId ?? "",
    displayName: me.displayName ?? "",
    emailAddress: me.emailAddress ?? null,
  };
}

/** Verify the credentials already stored for the org. User-initiated: throws. */
export async function verifyStoredJiraCredentials(
  organizationId: string,
): Promise<JiraVerifiedAccount> {
  return verifyJiraCredentials(await requireJiraCredentials(organizationId));
}

export interface JiraProject {
  id: string;
  key: string;
  name: string;
}

/**
 * Projects the stored account can see, for the project picker.
 *
 * `GET /rest/api/3/project/search` rather than `GET /rest/api/3/project`: the
 * latter is deprecated in favour of it and returns every project unpaginated,
 * which on a large site is a very slow way to fill a dropdown.
 *
 * User-initiated: throws. A picker that silently comes back empty is
 * indistinguishable from an org with no projects, which is the one thing the
 * user must not be left guessing about.
 */
export async function listJiraProjects(organizationId: string): Promise<JiraProject[]> {
  const creds = await requireJiraCredentials(organizationId);
  const res = await jiraFetch<{ values?: Array<{ id?: string; key?: string; name?: string }> }>(
    creds,
    `/rest/api/3/project/search?maxResults=${PICKER_PAGE_SIZE}&orderBy=key`,
  );
  return (res.values ?? [])
    .filter((p): p is { id: string; key: string; name: string } => Boolean(p.id && p.key && p.name))
    .map((p) => ({ id: p.id, key: p.key, name: p.name }));
}

export interface JiraIssueType {
  id: string;
  name: string;
  /** Subtasks need a parent issue, so the picker hides them. */
  subtask: boolean;
  description: string | null;
}

/**
 * Issue types available *in a given project*, for the type picker.
 *
 * `GET /rest/api/3/issue/createmeta/{projectIdOrKey}/issuetypes` rather than the
 * global `GET /rest/api/3/issuetype`: only this one reflects the project's own
 * issue type scheme, and offering a type the project does not have would fail
 * the create with a 400 that reads like our bug.
 *
 * Subtasks are filtered out — they require a parent issue, and a finding has no
 * parent to hang off.
 *
 * User-initiated: throws.
 */
export async function listJiraIssueTypes(
  organizationId: string,
  projectKey: string,
): Promise<JiraIssueType[]> {
  const key = projectKey.trim();
  if (!key) throw new JiraApiError("A project is required to list issue types");

  const creds = await requireJiraCredentials(organizationId);
  const res = await jiraFetch<{
    issueTypes?: Array<{
      id?: string;
      name?: string;
      subtask?: boolean;
      description?: string | null;
    }>;
  }>(
    creds,
    `/rest/api/3/issue/createmeta/${encodeURIComponent(key)}/issuetypes?maxResults=${PICKER_PAGE_SIZE}`,
  );

  return (res.issueTypes ?? [])
    .filter((t) => Boolean(t.id && t.name) && t.subtask !== true)
    .map((t) => ({
      id: t.id as string,
      name: t.name as string,
      subtask: false,
      description: t.description ?? null,
    }));
}

export interface CreateJiraIssueArgs {
  organizationId: string;
  projectKey: string;
  issueTypeId: string;
  summary: string;
  description?: string | undefined;
  labels?: readonly string[] | undefined;
}

export interface CreatedJiraIssue {
  id: string;
  key: string;
  url: string;
}

/**
 * File an issue. User-initiated: throws, and deliberately so — this is the one
 * call in the module where swallowing the error would tell somebody their work
 * is tracked when no issue exists.
 */
export async function createJiraIssue(args: CreateJiraIssueArgs): Promise<CreatedJiraIssue> {
  const summary = args.summary.trim();
  if (!summary) throw new JiraApiError("A summary is required");
  if (!args.projectKey.trim()) throw new JiraApiError("A project is required");
  if (!args.issueTypeId.trim()) throw new JiraApiError("An issue type is required");

  const creds = await requireJiraCredentials(args.organizationId);
  const payload = buildCreateIssuePayload({
    projectKey: args.projectKey.trim(),
    issueTypeId: args.issueTypeId.trim(),
    summary,
    description: args.description,
    labels: args.labels,
  });

  const created = await jiraFetch<{ id?: string; key?: string }>(creds, "/rest/api/3/issue", {
    method: "POST",
    body: payload,
  });

  if (!created.key) {
    throw new JiraApiError("Jira accepted the issue but returned no issue key");
  }
  return {
    id: created.id ?? "",
    key: created.key,
    url: issueBrowseUrl(creds.siteUrl, created.key),
  };
}

// --- Links ---

export interface JiraIssueLink {
  id: string;
  sourceKind: JiraSourceKind;
  sourceId: string;
  issueKey: string;
  issueUrl: string;
  createdByUserId: string | null;
  createdAt: string;
}

function toLinkRecord(row: typeof jiraIssueLinks.$inferSelect): JiraIssueLink {
  return {
    id: row.id,
    sourceKind: row.sourceKind as JiraSourceKind,
    sourceId: row.sourceId,
    issueKey: row.issueKey,
    issueUrl: row.issueUrl,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt.toISOString(),
  };
}

export interface RecordJiraIssueLinkArgs {
  organizationId: string;
  userId?: string | null;
  sourceKind: JiraSourceKind;
  sourceId: string;
  issueKey: string;
  issueUrl: string;
}

/**
 * Remember that a finding was filed. Idempotent on
 * (org, kind, source, issue key) so a retried request cannot double-file — the
 * issue already exists in Jira at this point, and the row is what stops the UI
 * offering the button again.
 *
 * Called immediately after a successful create, so it throws: a link the caller
 * believes was written but wasn't means the next page load offers to file a
 * duplicate.
 */
export async function recordJiraIssueLink(args: RecordJiraIssueLinkArgs): Promise<JiraIssueLink> {
  const [row] = await db
    .insert(jiraIssueLinks)
    .values({
      id: randomUUID(),
      organizationId: args.organizationId,
      sourceKind: args.sourceKind,
      sourceId: args.sourceId,
      issueKey: args.issueKey,
      issueUrl: args.issueUrl,
      createdByUserId: args.userId ?? null,
    })
    .onConflictDoUpdate({
      target: [
        jiraIssueLinks.organizationId,
        jiraIssueLinks.sourceKind,
        jiraIssueLinks.sourceId,
        jiraIssueLinks.issueKey,
      ],
      set: { issueUrl: args.issueUrl },
    })
    .returning();

  if (!row) throw new JiraApiError("Failed to record the Jira issue link");
  return toLinkRecord(row);
}

export interface ListJiraIssueLinksFilter {
  sourceKind?: JiraSourceKind | undefined;
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
export async function listJiraIssueLinks(
  organizationId: string,
  filter: ListJiraIssueLinksFilter = {},
): Promise<JiraIssueLink[]> {
  try {
    const conditions = [eq(jiraIssueLinks.organizationId, organizationId)];
    if (filter.sourceKind) {
      conditions.push(eq(jiraIssueLinks.sourceKind, filter.sourceKind));
    }
    if (filter.sourceIds && filter.sourceIds.length > 0) {
      conditions.push(inArray(jiraIssueLinks.sourceId, [...filter.sourceIds]));
    }

    const rows = await db
      .select()
      .from(jiraIssueLinks)
      .where(and(...conditions))
      .orderBy(desc(jiraIssueLinks.createdAt));
    return rows.map(toLinkRecord);
  } catch (err) {
    console.error("[jira] failed to list issue links for org", organizationId, err);
    return [];
  }
}
