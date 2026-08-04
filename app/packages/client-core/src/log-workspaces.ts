/**
 * Log workspace — tail several log-capable resources in one pane, search
 * across the merged stream, save the set-up as a named query, and optionally
 * alert when a line matches.
 *
 * This module is the shared pure half every surface uses: the search
 * expression compiler (the SAME matcher the workspace filter box and the
 * server-side alert pass evaluate, so "matches" can never disagree between
 * the UI and the poller), the tail-window diff used to interleave newly
 * appended lines, and the wire contract + Bearer fetch helpers for
 * `/api/org/:orgId/log-workspaces`.
 */
// Type-only on purpose — client-core keeps zero runtime dependency on
// plugin-base (the mobile bundle never pulls the manifest machinery in).
import type { LogsFetchResult } from "@infrawrench/plugin-base";
import type { CloudFetch } from "./fetch";

// ---------------------------------------------------------------------------
// Wire contract
// ---------------------------------------------------------------------------

/** One resource a saved query tails — enough to call the per-resource logs endpoint. */
export interface LogStreamSelector {
  /**
   * Infrawrench resource id (`resources.id`), or — for a sidecar stream — the
   * peer plugin's own resource id (e.g. `{accountId}:k8s-pod:{ns}:{name}`),
   * which is not a stored row.
   */
  resourceId: string;
  accountId: string;
  pluginId: string;
  resourceTypeId: string;
  /**
   * Set when the stream lives behind a peer integration (a pod inside a
   * managed cluster): the stored parent resource (`resources.id`) whose
   * outputs mint the peer plugin's credentials. The logs endpoint routes
   * through the peer client when present.
   */
  parentResourceId?: string;
  /** Container to fetch when the resource has more than one; omit for the default. */
  container?: string;
}

/** Wire shape of a saved log workspace query as every read endpoint returns it. */
export interface LogWorkspaceQuery {
  id: string;
  name: string;
  resources: LogStreamSelector[];
  /** The search expression — see `compileLogSearch` for the syntax. */
  search: string;
  /** When true the poller periodically evaluates the query and alerts on match. */
  alertEnabled: boolean;
  /** Last time the alert pass evaluated this query; null until it has run. */
  lastEvalAt: string | null;
  /** Last time an evaluation found at least one matching line. */
  lastMatchAt: string | null;
  /** Last time a notification was dispatched (cooldown anchor). */
  lastAlertedAt: string | null;
  /** Failure detail from the last evaluation; never silent. */
  lastEvalError: string | null;
  /** A truncated sample of the most recent matching line. */
  lastMatchSample: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LogWorkspaceQueryListResponse {
  queries: LogWorkspaceQuery[];
}

/** Body of `POST /api/org/:orgId/log-workspaces`. */
export interface LogWorkspaceQueryCreate {
  name: string;
  resources: LogStreamSelector[];
  search: string;
  alertEnabled?: boolean;
}

/** Body of `PUT /api/org/:orgId/log-workspaces/:id`; omitted fields keep their value. */
export interface LogWorkspaceQueryPatch {
  name?: string;
  resources?: LogStreamSelector[];
  search?: string;
  alertEnabled?: boolean;
}

/**
 * Guard rails shared by the API validation, the editors and the alert pass.
 * The alert numbers keep a periodic pass bounded: a fixed tail window per
 * resource, a hard cap on matches counted per run, and a cooldown so a query
 * that keeps matching doesn't re-fire every pass.
 */
export const LOG_WORKSPACE_LIMITS = {
  /** Hard cap on saved queries per org — a governance rail, not a product tier. */
  maxPerOrg: 100,
  /** Max resources one query can tail. */
  maxResourcesPerQuery: 8,
  maxNameLength: 120,
  maxSearchLength: 500,
  /** Tail window the alert pass fetches per resource (bounded lookback). */
  alertTailLines: 400,
  /** Max matching lines counted per evaluation run. */
  alertMatchCap: 25,
  /** Minimum time between two dispatched alerts for the same query. */
  alertCooldownMs: 30 * 60 * 1000,
  /** How often the poller re-evaluates an alert-enabled query. */
  alertEvalIntervalMs: 5 * 60 * 1000,
} as const;

// ---------------------------------------------------------------------------
// Search expression compiler
// ---------------------------------------------------------------------------

/**
 * A compiled search expression. `test` decides line membership; `error` is
 * set (and `test` matches nothing) when the expression failed to compile —
 * surfaced inline by the filter box and stored on the row by the alert pass.
 */
export interface CompiledLogSearch {
  test: (line: string) => boolean;
  error: string | null;
  /** True for the empty expression, which matches every line. */
  matchAll: boolean;
}

interface SearchTerm {
  value: string;
  negated: boolean;
}

/** Split an expression into terms: whitespace-separated, `"quoted phrases"`, `-` negation. */
function tokenizeSearch(expr: string): SearchTerm[] {
  const terms: SearchTerm[] = [];
  const re = /(-)?"([^"]*)"|(-)?(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(expr)) !== null) {
    if (m[2] !== undefined) {
      if (m[2].length > 0) terms.push({ value: m[2], negated: m[1] === "-" });
    } else if (m[4] !== undefined) {
      const negated = m[3] === "-";
      if (m[4].length > 0) terms.push({ value: m[4], negated });
    }
  }
  return terms;
}

/**
 * Best-effort static rejection of regex shapes whose backtracking can blow up
 * on a hostile line: a `*`/`+`/`{n,m}` quantifier applied to a group that
 * itself contains a quantifier (`(a+)+`, `(\w*)*`, `(?:x{2,}){3,}` — "star
 * height" > 1), or applied to a group with top-level alternation (`(a|aa)+`),
 * whose overlapping branches backtrack the same way. This is a shape check,
 * not a full ReDoS analysis: patterns it cannot see through (e.g. adjacent
 * ambiguous quantifiers like `a*a*a*b`) are additionally bounded by the
 * per-line input cap the alert pass applies in `evaluateLogMatches`.
 */
export function hasCatastrophicRegexShape(pattern: string): boolean {
  /** Does an unbounded-ish quantifier (`*`, `+` or `{…}`) start at `i`? */
  const quantifierAt = (i: number): boolean => {
    const ch = pattern[i];
    return ch === "*" || ch === "+" || (ch === "{" && /^\{\d+(,\d*)?\}/.test(pattern.slice(i)));
  };
  interface GroupState {
    sawQuantifier: boolean;
    sawAlternation: boolean;
  }
  const stack: GroupState[] = [];
  let current: GroupState = { sawQuantifier: false, sawAlternation: false };
  let inClass = false;
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "\\") {
      i++;
      continue;
    }
    if (inClass) {
      if (ch === "]") inClass = false;
      continue;
    }
    if (ch === "[") {
      inClass = true;
      continue;
    }
    if (ch === "(") {
      stack.push(current);
      current = { sawQuantifier: false, sawAlternation: false };
      continue;
    }
    if (ch === ")") {
      const inner = current;
      const outer = stack.pop() ?? { sawQuantifier: false, sawAlternation: false };
      const quantified = quantifierAt(i + 1);
      if (quantified && (inner.sawQuantifier || inner.sawAlternation)) return true;
      current = {
        sawQuantifier: outer.sawQuantifier || inner.sawQuantifier || quantified,
        sawAlternation: outer.sawAlternation,
      };
      continue;
    }
    if (ch === "|") {
      current.sawAlternation = true;
      continue;
    }
    if (quantifierAt(i)) current.sawQuantifier = true;
  }
  return false;
}

/**
 * Compile a log search expression into a line predicate.
 *
 * Syntax (kept deliberately grep-simple):
 * - empty / whitespace → matches every line
 * - `/pattern/` or `/pattern/i` — the whole expression is a regular
 *   expression (case-insensitive with the `i` flag, case-sensitive without)
 * - otherwise: whitespace-separated terms, ALL of which must appear in the
 *   line (case-insensitive substring). `"quoted phrases"` keep their spaces;
 *   a leading `-` negates a term (`error -health` = has "error", not "health").
 *
 * Regex patterns are guarded: over-long patterns and shapes prone to
 * catastrophic backtracking (see `hasCatastrophicRegexShape`) compile to an
 * error rather than a predicate, so a user-supplied pattern can never
 * monopolize the alert poller (or the filter box) synchronously.
 */
export function compileLogSearch(expression: string): CompiledLogSearch {
  const expr = expression.trim();
  if (expr.length === 0) {
    return { test: () => true, error: null, matchAll: true };
  }

  const regexForm = /^\/(.+)\/(i?)$/.exec(expr);
  if (regexForm) {
    const pattern = regexForm[1]!;
    if (pattern.length > LOG_WORKSPACE_LIMITS.maxSearchLength) {
      return {
        test: () => false,
        error: `Invalid regex: pattern must be at most ${LOG_WORKSPACE_LIMITS.maxSearchLength} characters`,
        matchAll: false,
      };
    }
    if (hasCatastrophicRegexShape(pattern)) {
      return {
        test: () => false,
        error:
          "Invalid regex: a quantified group containing a quantifier or alternation " +
          "(e.g. `(a+)+`, `(a|aa)*`) can backtrack catastrophically and is not supported",
        matchAll: false,
      };
    }
    try {
      const regex = new RegExp(pattern, regexForm[2] === "i" ? "i" : "");
      return { test: (line) => regex.test(line), error: null, matchAll: false };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { test: () => false, error: `Invalid regex: ${message}`, matchAll: false };
    }
  }

  const terms = tokenizeSearch(expr);
  if (terms.length === 0) {
    return { test: () => true, error: null, matchAll: true };
  }
  const needles = terms.map((t) => ({ value: t.value.toLowerCase(), negated: t.negated }));
  return {
    test: (line) => {
      const lowered = line.toLowerCase();
      for (const needle of needles) {
        const present = lowered.includes(needle.value);
        if (needle.negated ? present : !present) return false;
      }
      return true;
    },
    error: null,
    matchAll: false,
  };
}

// ---------------------------------------------------------------------------
// Match evaluation (used by the server-side alert pass and its tests)
// ---------------------------------------------------------------------------

export interface LogMatchEvaluation {
  /** Matching lines counted, capped at `matchCap`. */
  matchCount: number;
  /** True when scanning stopped at the cap — the real count may be higher. */
  truncated: boolean;
  /** Up to `sampleCap` matching lines, most recent last, each length-capped. */
  samples: string[];
}

const SAMPLE_LINE_MAX_LENGTH = 300;

/**
 * Max characters of a line fed to `search.test` during a server-side
 * evaluation. Together with the pattern-shape guard in `compileLogSearch`
 * this bounds regex backtracking cost in the alert poller: the shape guard
 * rejects the exponential patterns it can see, and this cap keeps the cost of
 * anything it can't see (polynomially ambiguous patterns) small on hostile
 * log lines. The trade-off: a match that only begins past this offset in a
 * single very long line is not counted.
 */
const EVAL_LINE_MAX_LENGTH = 2000;

function clipLine(line: string): string {
  return line.length > SAMPLE_LINE_MAX_LENGTH ? `${line.slice(0, SAMPLE_LINE_MAX_LENGTH)}…` : line;
}

/** Split raw `getLogs` text into lines, dropping a single trailing empty line. */
export function splitLogLines(text: string): string[] {
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * Evaluate a compiled search over a chunk of raw log text. Scanning is
 * bounded: it walks the lines newest-first and stops counting at `matchCap`,
 * so a pathological chunk can never make an evaluation unbounded. Samples
 * come from the newest matches (the ones the alert should show).
 */
export function evaluateLogMatches(
  text: string,
  search: CompiledLogSearch,
  options?: { matchCap?: number; sampleCap?: number },
): LogMatchEvaluation {
  const matchCap = options?.matchCap ?? LOG_WORKSPACE_LIMITS.alertMatchCap;
  const sampleCap = options?.sampleCap ?? 3;
  const lines = splitLogLines(text);
  const samples: string[] = [];
  let matchCount = 0;
  let truncated = false;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (line.length === 0) continue;
    // Cap the input the (user-supplied) predicate sees — see EVAL_LINE_MAX_LENGTH.
    const probe = line.length > EVAL_LINE_MAX_LENGTH ? line.slice(0, EVAL_LINE_MAX_LENGTH) : line;
    if (!search.test(probe)) continue;
    matchCount += 1;
    if (samples.length < sampleCap) samples.push(clipLine(line));
    if (matchCount >= matchCap) {
      truncated = i > 0;
      break;
    }
  }
  return { matchCount, truncated, samples: samples.reverse() };
}

// ---------------------------------------------------------------------------
// Tail-window diff (used by the workspace view to interleave new lines)
// ---------------------------------------------------------------------------

/**
 * Given the previous and the next tail window of the same stream, return the
 * lines that are new in `next`. Tail windows slide: the shared region is a
 * suffix of `prev` and a prefix of `next`, so the appended lines are `next`
 * minus its largest prefix that matches a suffix of `prev`. No overlap at all
 * (log rotation, a burst larger than the window, a container switch) treats
 * the whole of `next` as new.
 */
export function computeAppendedLines(prev: string[], next: string[]): string[] {
  const max = Math.min(prev.length, next.length);
  for (let overlap = max; overlap > 0; overlap--) {
    let matches = true;
    for (let i = 0; i < overlap; i++) {
      if (prev[prev.length - overlap + i] !== next[i]) {
        matches = false;
        break;
      }
    }
    if (matches) return next.slice(overlap);
  }
  return next.slice();
}

/**
 * Stable key for a selector — used for React keys and per-stream state maps.
 * Includes the parent: two clusters in one account can both run a pod with
 * the same namespace/name, so the peer resource id alone is ambiguous.
 */
export function logStreamKey(selector: LogStreamSelector): string {
  return `${selector.accountId}:${selector.parentResourceId ?? ""}:${selector.resourceId}:${selector.container ?? ""}`;
}

/**
 * Validate a saved-query payload against the shared limits. Returns an error
 * string for the API to 400 with (and for editors to show inline), or null.
 */
export function validateLogWorkspaceQuery(input: {
  name: string;
  resources: LogStreamSelector[];
  search: string;
}): string | null {
  const name = input.name.trim();
  if (name.length === 0) return "Name is required";
  if (name.length > LOG_WORKSPACE_LIMITS.maxNameLength) {
    return `Name must be at most ${LOG_WORKSPACE_LIMITS.maxNameLength} characters`;
  }
  if (input.resources.length === 0) return "Add at least one resource to tail";
  if (input.resources.length > LOG_WORKSPACE_LIMITS.maxResourcesPerQuery) {
    return `A query can tail at most ${LOG_WORKSPACE_LIMITS.maxResourcesPerQuery} resources`;
  }
  const keys = new Set<string>();
  for (const selector of input.resources) {
    if (
      !selector.resourceId ||
      !selector.accountId ||
      !selector.pluginId ||
      !selector.resourceTypeId
    ) {
      return "Each resource needs resourceId, accountId, pluginId and resourceTypeId";
    }
    const key = logStreamKey(selector);
    if (keys.has(key)) return "The same resource/container is listed twice";
    keys.add(key);
  }
  if (input.search.length > LOG_WORKSPACE_LIMITS.maxSearchLength) {
    return `Search expression must be at most ${LOG_WORKSPACE_LIMITS.maxSearchLength} characters`;
  }
  const compiled = compileLogSearch(input.search);
  if (compiled.error) return compiled.error;
  return null;
}

// ---------------------------------------------------------------------------
// Bearer fetch helpers (mobile + any host that talks the cloud API directly)
// ---------------------------------------------------------------------------

/** Read `GET /api/org/:orgId/log-workspaces` (permission `resources:read`). */
export async function fetchLogWorkspaceQueries(
  api: CloudFetch,
  orgId: string,
): Promise<LogWorkspaceQueryListResponse> {
  const res = await api.org<LogWorkspaceQueryListResponse>(orgId, "/log-workspaces");
  return res ?? { queries: [] };
}

/** Create a saved query (`resources:write`). */
export async function createLogWorkspaceQuery(
  api: CloudFetch,
  orgId: string,
  body: LogWorkspaceQueryCreate,
): Promise<LogWorkspaceQuery | null> {
  return api.org<LogWorkspaceQuery>(orgId, "/log-workspaces", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/** Update a saved query — name, resources, search or the alert toggle (`resources:write`). */
export async function updateLogWorkspaceQuery(
  api: CloudFetch,
  orgId: string,
  queryId: string,
  patch: LogWorkspaceQueryPatch,
): Promise<LogWorkspaceQuery | null> {
  return api.org<LogWorkspaceQuery>(orgId, `/log-workspaces/${encodeURIComponent(queryId)}`, {
    method: "PUT",
    body: JSON.stringify(patch),
  });
}

/** What `fetchLogStreamTail` returns: the tail split into lines plus container metadata. */
export interface LogStreamTail {
  lines: string[];
  /** Container names available for this resource; empty when not containerized. */
  containers: string[];
}

/**
 * Fetch one stream's log tail over the cloud API — the platform-neutral half
 * of every Bearer-talking log viewer (mobile today). Builds the per-resource
 * logs endpoint path from the selector, POSTs the tail request, and splits the
 * raw text into lines with `splitLogLines`. Presentation (labels, colors,
 * error rendering) stays with the caller.
 */
export async function fetchLogStreamTail(
  api: CloudFetch,
  orgId: string,
  selector: LogStreamSelector,
  options?: { tailLines?: number },
): Promise<LogStreamTail> {
  const result = await api.org<LogsFetchResult>(
    orgId,
    `/resources/${encodeURIComponent(selector.pluginId)}/${encodeURIComponent(selector.resourceTypeId)}/logs`,
    {
      method: "POST",
      body: JSON.stringify({
        accountId: selector.accountId,
        resourceId: selector.resourceId,
        ...(selector.parentResourceId ? { parentResourceId: selector.parentResourceId } : {}),
        ...(options?.tailLines !== undefined ? { tailLines: options.tailLines } : {}),
        ...(selector.container ? { container: selector.container } : {}),
      }),
    },
  );
  return { lines: splitLogLines(result?.text ?? ""), containers: result?.containers ?? [] };
}

/** Delete a saved query (`resources:write`). */
export async function deleteLogWorkspaceQuery(
  api: CloudFetch,
  orgId: string,
  queryId: string,
): Promise<void> {
  await api.org(orgId, `/log-workspaces/${encodeURIComponent(queryId)}`, { method: "DELETE" });
}
