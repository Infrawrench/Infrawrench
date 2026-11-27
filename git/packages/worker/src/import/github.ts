/**
 * As much of GitHub's REST API as an issue import reads, over a `fetch` the
 * caller passes (the job passes the Worker's, tests a fake).
 *
 * - **One host.** Every request goes to {@link GITHUB_API}, a constant: no
 *   part of an address comes from a person but the owner and the name, which
 *   are path segments, percent-encoded. A redirect is never followed
 *   (`redirect: "manual"`) and is an error, so a token is never sent on to
 *   wherever a response points.
 * - **A rate limit is an answer, not an error.** GitHub says it with 403 or
 *   429 and `x-ratelimit-remaining: 0` (wait until `x-ratelimit-reset`, UTC
 *   epoch seconds) or `retry-after` (seconds), and for a secondary limit
 *   with neither, where the wait is at least a minute. Each call answers
 *   `{ kind: "wait", until }` for those and the job sleeps on it.
 * - **Lenient decoding.** Fields this does not read are ignored, and the
 *   ones it can do without may be missing or null (a deleted account's
 *   `user` is null).
 * - **Errors say little.** A {@link GitHubError} carries the status and one
 *   of a few fixed sentences. Never the token, never the response's body.
 */
import { Option, Schema } from "effect";

export const GITHUB_API = "https://api.github.com";
export const GITHUB_API_VERSION = "2022-11-28";
export const GITHUB_PAGE_SIZE = 100;
const USER_AGENT = "infrawrench-git-import";
const REQUEST_TIMEOUT_MS = 15_000;
/** The wait for a secondary rate limit that names none. */
const SECONDARY_WAIT_MS = 60_000;

/** The `fetch` a client calls: the platform's, or a test's. */
export type GitHubFetch = (url: string, init: RequestInit) => Promise<Response>;

export type GitHubErrorKind =
  /** 401: the token is wrong, expired or revoked. */
  | "unauthorized"
  /** 403 that is not a rate limit: the token may not read this. */
  | "forbidden"
  /** 404. */
  | "not_found"
  /** 410: issues are switched off in the repository. */
  | "gone"
  /** A 3xx: a renamed or moved repository. Never followed. */
  | "redirect"
  /** A 5xx, a timeout or no connection: worth another try later. */
  | "unavailable"
  /** A 2xx whose body was not what the documentation says. */
  | "invalid"
  /** Any other status. */
  | "unexpected";

const MESSAGES: Record<GitHubErrorKind, string> = {
  unauthorized: "GitHub refused the token",
  forbidden: "GitHub does not let the token read this",
  not_found: "GitHub has nothing at that address for this token",
  gone: "GitHub says issues are switched off there",
  redirect: "GitHub answered with a redirect, which is not followed",
  unavailable: "GitHub could not be reached",
  invalid: "GitHub answered in a form that was not understood",
  unexpected: "GitHub answered with an unexpected status",
};

/** A request that failed. The message is one of a few fixed sentences. */
export class GitHubError extends Error {
  override readonly name = "GitHubError";
  constructor(
    readonly kind: GitHubErrorKind,
    readonly status: number,
  ) {
    super(status > 0 ? `${MESSAGES[kind]} (HTTP ${status})` : MESSAGES[kind]);
  }
}

/** What GitHub said of the token's budget on the last answer. Null where a header was absent. */
export interface GitHubRate {
  readonly remaining: number | null;
  /** When the window resets, in milliseconds since the epoch. */
  readonly resetAt: number | null;
}

export type GitHubAnswer<T> =
  | {
      readonly kind: "ok";
      readonly value: T;
      /** Whether a page follows this one. */
      readonly more: boolean;
      readonly rate: GitHubRate;
    }
  | {
      readonly kind: "wait";
      /** Not before this instant, in milliseconds since the epoch. */
      readonly until: number;
      readonly limit: "primary" | "secondary";
    };

const lenient = <S extends Schema.Top>(schema: S) => Schema.optional(Schema.NullOr(schema));

const User = Schema.Struct({
  login: Schema.String,
  type: lenient(Schema.String),
});
export type GitHubUser = typeof User.Type;

const Label = Schema.Struct({
  name: Schema.String,
  color: lenient(Schema.String),
  description: lenient(Schema.String),
});
export type GitHubLabel = typeof Label.Type;

const Milestone = Schema.Struct({
  title: Schema.String,
  state: lenient(Schema.String),
  description: lenient(Schema.String),
  due_on: lenient(Schema.String),
  created_at: lenient(Schema.String),
  closed_at: lenient(Schema.String),
});
export type GitHubMilestone = typeof Milestone.Type;

const Issue = Schema.Struct({
  id: Schema.Finite,
  number: Schema.Finite,
  title: Schema.String,
  body: lenient(Schema.String),
  state: Schema.String,
  state_reason: lenient(Schema.String),
  user: lenient(User),
  /** A label is an object, or in old answers its name. */
  labels: lenient(
    Schema.Array(Schema.Union([Schema.String, Schema.Struct({ name: Schema.String })])),
  ),
  assignees: lenient(Schema.Array(User)),
  milestone: lenient(Schema.Struct({ title: Schema.String })),
  locked: lenient(Schema.Boolean),
  active_lock_reason: lenient(Schema.String),
  html_url: lenient(Schema.String),
  created_at: Schema.String,
  updated_at: lenient(Schema.String),
  closed_at: lenient(Schema.String),
  /** Present on a pull request, which the issue list also returns. */
  pull_request: Schema.optional(Schema.Unknown),
});
export type GitHubIssue = typeof Issue.Type;

const Comment = Schema.Struct({
  id: Schema.Finite,
  body: lenient(Schema.String),
  user: lenient(User),
  html_url: lenient(Schema.String),
  /** The API address of its issue or pull request: `.../issues/<number>`. */
  issue_url: Schema.String,
  created_at: Schema.String,
  updated_at: lenient(Schema.String),
});
export type GitHubComment = typeof Comment.Type;

const Profile = Schema.Struct({
  login: Schema.String,
  /** The address the person chose to show on their profile, if any. */
  email: lenient(Schema.String),
});
export type GitHubProfile = typeof Profile.Type;

/** `owner/name` as two path segments. */
export const repositoryPath = (repository: string): string => {
  const [owner = "", name = ""] = repository.split("/");
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
};

/** The issue number a comment's `issue_url` ends in, or null. */
export const issueNumberOf = (issueUrl: string): number | null => {
  const match = /\/issues\/(\d+)$/.exec(issueUrl);
  return match ? Number(match[1]) : null;
};

const numberHeader = (headers: Headers, name: string): number | null => {
  const raw = headers.get(name);
  if (raw === null || raw.trim() === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : null;
};

export const rateOf = (headers: Headers): GitHubRate => {
  const reset = numberHeader(headers, "x-ratelimit-reset");
  return {
    remaining: numberHeader(headers, "x-ratelimit-remaining"),
    resetAt: reset === null ? null : reset * 1000,
  };
};

/** Whether a `Link` header names a next page. */
export const hasNextPage = (link: string | null): boolean | null =>
  link === null ? null : /<[^>]*>\s*;[^,]*\brel="?next"?/.test(link);

/**
 * What a 403 or 429 asks for: a wait, or null when it is a plain refusal.
 * `message` is the answer's own `message` field, read only for the words
 * "rate limit" and kept nowhere.
 */
export const rateLimitWait = (
  status: number,
  headers: Headers,
  message: string,
  now: number,
): { readonly until: number; readonly limit: "primary" | "secondary" } | null => {
  if (status !== 403 && status !== 429) return null;
  const retryAfter = numberHeader(headers, "retry-after");
  const rate = rateOf(headers);
  const secondary = /secondary rate limit|abuse/i.test(message);
  if (retryAfter !== null) return { until: now + retryAfter * 1000, limit: "secondary" };
  if (rate.remaining === 0) {
    // A reset already past (clocks differ) still means "not this second".
    const until = Math.max(rate.resetAt ?? 0, now + 1000);
    return { until, limit: secondary ? "secondary" : "primary" };
  }
  if (secondary || status === 429 || /rate limit/i.test(message)) {
    return { until: now + SECONDARY_WAIT_MS, limit: "secondary" };
  }
  return null;
};

const errorKind = (status: number): GitHubErrorKind => {
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 410) return "gone";
  if (status >= 300 && status < 400) return "redirect";
  if (status >= 500) return "unavailable";
  return "unexpected";
};

/** The `message` of an error body, for {@link rateLimitWait}. Empty when there is none. */
const messageOf = async (response: Response): Promise<string> => {
  try {
    const body: unknown = await response.json();
    return Option.match(
      Schema.decodeUnknownOption(Schema.Struct({ message: Schema.String }))(body),
      { onNone: () => "", onSome: (decoded) => decoded.message },
    );
  } catch {
    return "";
  }
};

export interface GitHubClientOptions {
  readonly token: string;
  readonly fetch: GitHubFetch;
  /** The clock, for the instant a wait ends. */
  readonly now?: () => number;
}

export interface ListOptions {
  readonly page: number;
  /** ISO 8601: only what was updated at or after this. */
  readonly since?: string | null;
}

export interface GitHubClient {
  /** Requests made so far. */
  readonly requests: () => number;
  labels(repository: string, page: number): Promise<GitHubAnswer<readonly GitHubLabel[]>>;
  milestones(repository: string, page: number): Promise<GitHubAnswer<readonly GitHubMilestone[]>>;
  /** Issues and pull requests, oldest first. A pull request carries `pull_request`. */
  issues(repository: string, options: ListOptions): Promise<GitHubAnswer<readonly GitHubIssue[]>>;
  /** The newest issue or pull request, for the highest number in use. */
  newestIssue(repository: string): Promise<GitHubAnswer<GitHubIssue | null>>;
  /** Every issue's and pull request's comments in the repository, oldest first. */
  comments(
    repository: string,
    options: ListOptions,
  ): Promise<GitHubAnswer<readonly GitHubComment[]>>;
  /** A login's public profile. Null when there is no such account. */
  user(login: string): Promise<GitHubAnswer<GitHubProfile | null>>;
}

export const makeGitHubClient = (options: GitHubClientOptions): GitHubClient => {
  const now = options.now ?? Date.now;
  let requests = 0;

  const get = async <S extends Schema.Top & { readonly DecodingServices: never }>(
    path: string,
    query: Readonly<Record<string, string | number | null | undefined>>,
    schema: S,
    onMissing?: () => S["Type"],
  ): Promise<GitHubAnswer<S["Type"]>> => {
    const url = new URL(GITHUB_API + path);
    for (const [key, value] of Object.entries(query)) {
      if (value !== null && value !== undefined) url.searchParams.set(key, String(value));
    }
    requests++;
    let response: Response;
    try {
      response = await options.fetch(url.toString(), {
        method: "GET",
        redirect: "manual",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: {
          authorization: `Bearer ${options.token}`,
          accept: "application/vnd.github+json",
          "x-github-api-version": GITHUB_API_VERSION,
          "user-agent": USER_AGENT,
        },
      });
    } catch {
      // What `fetch` throws can quote the request: none of it is kept.
      throw new GitHubError("unavailable", 0);
    }
    const { status, headers } = response;
    if (status < 200 || status >= 300) {
      const message = status === 403 || status === 429 ? await messageOf(response) : "";
      if (message === "") await response.body?.cancel().catch(() => {});
      const wait = rateLimitWait(status, headers, message, now());
      if (wait) return { kind: "wait", ...wait };
      if (status === 404 && onMissing) {
        return { kind: "ok", value: onMissing(), more: false, rate: rateOf(headers) };
      }
      throw new GitHubError(errorKind(status), status);
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new GitHubError("invalid", status);
    }
    const decoded = Schema.decodeUnknownOption(schema)(body);
    if (Option.isNone(decoded)) throw new GitHubError("invalid", status);
    const value: S["Type"] = decoded.value;
    const next = hasNextPage(headers.get("link"));
    const perPage = Number(query["per_page"] ?? GITHUB_PAGE_SIZE);
    return {
      kind: "ok",
      value,
      // Without a `Link` header a full page is taken to have a successor.
      more: next ?? (Array.isArray(value) && value.length >= perPage),
      rate: rateOf(headers),
    };
  };

  return {
    requests: () => requests,
    labels: (repository, page) =>
      get(
        `${repositoryPath(repository)}/labels`,
        { per_page: GITHUB_PAGE_SIZE, page },
        Schema.Array(Label),
      ),
    milestones: (repository, page) =>
      get(
        `${repositoryPath(repository)}/milestones`,
        { state: "all", sort: "due_on", direction: "asc", per_page: GITHUB_PAGE_SIZE, page },
        Schema.Array(Milestone),
      ),
    issues: (repository, { page, since }) =>
      get(
        `${repositoryPath(repository)}/issues`,
        {
          state: "all",
          sort: "created",
          direction: "asc",
          per_page: GITHUB_PAGE_SIZE,
          page,
          since,
        },
        Schema.Array(Issue),
      ),
    newestIssue: async (repository) => {
      const answer = await get(
        `${repositoryPath(repository)}/issues`,
        { state: "all", sort: "created", direction: "desc", per_page: 1, page: 1 },
        Schema.Array(Issue),
      );
      return answer.kind === "ok" ? { ...answer, value: answer.value[0] ?? null } : answer;
    },
    comments: (repository, { page, since }) =>
      get(
        `${repositoryPath(repository)}/issues/comments`,
        { sort: "created", direction: "asc", per_page: GITHUB_PAGE_SIZE, page, since },
        Schema.Array(Comment),
      ),
    user: (login) =>
      get(`/users/${encodeURIComponent(login)}`, {}, Schema.NullOr(Profile), () => null),
  };
};
