import { PluginGenError } from "../errors.js";
import { oneLine } from "../text.js";
import type { OpenIssue, OpenPullRequest } from "./decide.js";
import type { BranchRemover } from "./git.js";
import {
  ISSUE_SEARCH_WORDS,
  pluginOfBranch,
  pluginOfIssueTitle,
  pullRequestTitle,
} from "./render.js";
import type { TrackerPort } from "./tracker.js";

/**
 * The forge (git.infrawrench.com) as the watcher's tracker.
 *
 * There are no pull requests to open there: every branch but the default one gets a page
 * at its first push, as a draft. So "open the pull request" is the push itself, followed
 * here by giving the page the title and description and marking it ready, and "close the
 * pull request" is closing the page and deleting the branch. Issues are issues.
 *
 * The client is written by hand against the forge's contract (`git/packages/contract`)
 * rather than importing it, because plugingen has no workspace dependencies. It decodes
 * leniently: only the fields read here are looked at, and a value it does not know (a
 * new state, a new field) never fails it.
 */

export const FORGE_URL_ENV = "PLUGINGEN_FORGE_URL";
export const FORGE_REPOSITORY_ENV = "PLUGINGEN_FORGE_REPOSITORY";
export const FORGE_TOKEN_ENV = "PLUGINGEN_FORGE_TOKEN";

const DEFAULT_URL = "https://git.infrawrench.com";
const DEFAULT_REPOSITORY = "Infrawrench/Infrawrench";

export interface ForgeSettings {
  /** Scheme and host, with no path and no trailing slash. */
  origin: string;
  owner: string;
  repo: string;
  token: string;
}

const NAME = "[A-Za-z0-9_][A-Za-z0-9._-]*";
const REPOSITORY = new RegExp(`^(${NAME})/(${NAME})$`);
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Reads the forge's settings. No message here ever holds the token's value. */
export function forgeSettings(env: NodeJS.ProcessEnv): ForgeSettings {
  const rawUrl = env[FORGE_URL_ENV]?.trim() || DEFAULT_URL;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new PluginGenError("config", `${FORGE_URL_ENV} is not a URL`);
  }
  const plain = url.protocol === "http:" && LOCAL_HOSTS.has(url.hostname);
  if (url.protocol !== "https:" && !plain) {
    throw new PluginGenError("config", `${FORGE_URL_ENV} must be an https URL`);
  }
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new PluginGenError(
      "config",
      `${FORGE_URL_ENV} must be the forge's address alone, such as ${DEFAULT_URL}: no path, query or credentials`,
    );
  }

  const repository = env[FORGE_REPOSITORY_ENV]?.trim() || DEFAULT_REPOSITORY;
  const match = REPOSITORY.exec(repository);
  if (!match || repository.endsWith(".git")) {
    throw new PluginGenError(
      "config",
      `${FORGE_REPOSITORY_ENV} must be owner/name, such as ${DEFAULT_REPOSITORY}`,
    );
  }

  const token = env[FORGE_TOKEN_ENV] ?? "";
  if (token === "") {
    throw new PluginGenError(
      "config",
      `${FORGE_TOKEN_ENV} is not set. The forge target needs a personal access token (iwg_) with the repo:write scope, from an account that can write to ${repository}.`,
    );
  }
  // It travels through a credential helper's output, one value to a line.
  if (!/^[\x21-\x7e]+$/.test(token)) {
    throw new PluginGenError(
      "config",
      `${FORGE_TOKEN_ENV} holds a space, a line break or another character a token never has`,
    );
  }
  return { origin: url.origin, owner: match[1] ?? "", repo: match[2] ?? "", token };
}

/** The address `git` pushes to. Never holds a credential. */
export function forgeRemote(settings: ForgeSettings): string {
  return `${settings.origin}/${settings.owner}/${settings.repo}.git`;
}

/**
 * How `git` gets the token: a credential helper that reads it from the environment when
 * `git` asks, so the helper's text is on the command line and the token is not, and
 * nothing is written to `.git/config`. The username means nothing to the forge, which
 * takes the password whether it is a personal access token or an API key.
 *
 * The helper answers for the forge's address only and redirects are not followed, so a
 * redirect to another host is never handed the token. The text is fixed apart from that
 * address, which `forgeSettings` has already checked.
 */
export function forgeCredentials(settings: ForgeSettings): string[] {
  const helper = `!f() { test "$1" = get && printf 'username=x-access-token\\npassword=%s\\n' "$${FORGE_TOKEN_ENV}"; }; f`;
  return [
    "-c",
    "credential.helper=",
    "-c",
    `credential.${settings.origin}.helper=${helper}`,
    "-c",
    "http.followRedirects=false",
  ];
}

const WATCHER_BRANCH = /^plugingen\/[a-z0-9][a-z0-9-]*$/;

export function isWatcherBranch(branch: string): boolean {
  return WATCHER_BRANCH.test(branch);
}

/**
 * The only branches the watcher writes or deletes on the forge. A plugin's id is its
 * directory's name, which is ours, and this still holds if one is ever something else.
 */
export function checkWatcherBranch(branch: string): void {
  if (!isWatcherBranch(branch)) {
    throw new PluginGenError(
      "generator",
      `${oneLine(branch, 100)} is not a branch plugingen watch owns`,
    );
  }
}

export interface ForgeDeps {
  /** Deletes a branch, which the forge's API has no call for. */
  git: BranchRemover;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

type Row = Record<string, unknown>;

interface Answer {
  status: number;
  data: Row;
}

/** What is known about a page from the list, so that an edit needs no second look. */
interface KnownPage {
  key: string;
  branch: string;
  /** `undefined` when the forge did not say. */
  draft: boolean | undefined;
}

const REQUEST_TIMEOUT_MS = 60_000;
const PAGE_SIZE = 100;
const MAX_PAGES = 100;
/** A page is opened by the forge's queue after the push, so it can be a moment behind. */
const PAGE_ATTEMPTS = 5;
const PAGE_WAIT_MS = 2000;
const BUSY_ATTEMPTS = 3;
const MAX_BUSY_WAIT_MS = 30_000;
const BUG_LABEL = "bug";
const BUG_COLOR = "d73a4a";

function isRow(value: unknown): value is Row {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rows(value: unknown): Row[] {
  return Array.isArray(value) ? value.filter(isRow) : [];
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function wholeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function hasBugLabel(labels: unknown): boolean {
  return rows(labels).some((label) => text(label["name"]).toLowerCase() === BUG_LABEL);
}

export function createForgeTracker(settings: ForgeSettings, deps: ForgeDeps): TrackerPort {
  const send = deps.fetch ?? fetch;
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const repository = `${settings.owner}/${settings.repo}`;
  const api = `${settings.origin}/api/repos/${encodeURIComponent(settings.owner)}/${encodeURIComponent(settings.repo)}`;
  const site = `${settings.origin}/${encodeURIComponent(settings.owner)}/${encodeURIComponent(settings.repo)}`;
  const tokenHint = `Check ${FORGE_TOKEN_ENV}: it has to be a personal access token (iwg_) with the repo:write scope, from an account that can write to ${repository}. An API key (iwk_) can push but cannot open issues or edit branch pages.`;

  /** One line of somebody else's text, with the token taken out whatever it said. */
  const clean = (value: string, limit = 300): string =>
    oneLine(value.replaceAll(settings.token, "***"), limit);

  const fail = (method: string, path: string, detail: string, hint = ""): PluginGenError =>
    new PluginGenError(
      "generator",
      `forge ${method} ${clean(path)} failed: ${detail}${hint ? ` ${hint}` : ""}`,
    );

  /**
   * One call. Answers a status listed in `allow` instead of throwing for it. The error
   * names the method, the path and what the forge said, and never a header.
   */
  const request = async (
    method: string,
    path: string,
    body?: Row,
    allow: readonly number[] = [],
  ): Promise<Answer> => {
    for (let attempt = 1; ; attempt += 1) {
      let response: Response;
      let raw: string;
      try {
        response = await send(`${api}${path}`, {
          method,
          headers: {
            accept: "application/json",
            authorization: `Bearer ${settings.token}`,
            "user-agent": "plugingen-watch",
            ...(body === undefined ? {} : { "content-type": "application/json" }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          // A redirect would carry the token to wherever it points.
          redirect: "error",
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        raw = await response.text();
      } catch (error) {
        throw fail(
          method,
          path,
          `the forge could not be reached: ${clean(error instanceof Error ? error.message : String(error))}`,
        );
      }

      if ((response.status === 429 || response.status === 503) && attempt < BUSY_ATTEMPTS) {
        const seconds = Number(response.headers.get("retry-after"));
        const wait = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 1000 * attempt;
        await sleep(Math.min(wait, MAX_BUSY_WAIT_MS));
        continue;
      }

      let data: Row = {};
      try {
        const parsed: unknown = raw === "" ? {} : JSON.parse(raw);
        if (isRow(parsed)) data = parsed;
      } catch {
        if (response.ok) throw fail(method, path, "the forge answered something that is not JSON");
      }
      if (response.ok || allow.includes(response.status)) return { status: response.status, data };

      const said = clean(text(data["error"]));
      const hint =
        response.status === 401 || response.status === 403
          ? tokenHint
          : response.status === 404 && said === "Repository not found"
            ? `${repository} does not exist on the forge, or the token cannot read it. ${tokenHint}`
            : "";
      throw fail(method, path, `HTTP ${response.status}${said ? `: ${said}` : ""}`, hint);
    }
  };

  /** Every item of a list, following `nextCursor` until the forge says there is no more. */
  const list = async (path: string): Promise<Row[]> => {
    const items: Row[] = [];
    const seen = new Set<string>();
    let cursor = "";
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const query = `limit=${PAGE_SIZE}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      const { data } = await request("GET", `${path}${path.includes("?") ? "&" : "?"}${query}`);
      items.push(...rows(data["items"]));
      const next = data["nextCursor"];
      if (typeof next !== "string" || next === "" || seen.has(next)) return items;
      seen.add(next);
      cursor = next;
    }
    throw fail("GET", path, `the list did not end within ${MAX_PAGES} pages`);
  };

  /** A branch page's key is one path segment, slashes included. */
  const branchPath = (key: string): string => `/branches/${encodeURIComponent(key)}`;
  const pageUrl = (key: string): string =>
    `${site}/branches/${key.split("/").map(encodeURIComponent).join("/")}`;
  const issueUrl = (number: number): string => `${site}/issues/${number}`;

  const known = new Map<number, KnownPage>();

  const draftOf = (page: Row): boolean | undefined =>
    typeof page["draft"] === "boolean" ? page["draft"] : undefined;

  const pageOf = async (number: number): Promise<KnownPage> => {
    const listed = known.get(number);
    if (listed) return listed;
    const { data } = await request("GET", `/branch-pages/${number}`);
    const key = text(data["key"]);
    if (key === "") throw fail("GET", `/branch-pages/${number}`, "the forge named no branch");
    // A fork's page is `owner/name:branch`, which is no branch of ours and fails the check.
    return { key, branch: key, draft: undefined };
  };

  /** The page's title and description as given, and ready for review. */
  const present = async (
    page: KnownPage,
    wanted: { title?: string; body: string },
    current?: Row,
  ): Promise<void> => {
    const sameText =
      current !== undefined &&
      (wanted.title === undefined || current["title"] === wanted.title) &&
      current["body"] === wanted.body;
    if (!sameText) {
      await request("PATCH", branchPath(page.key), {
        ...(wanted.title === undefined ? {} : { title: wanted.title }),
        body: wanted.body,
      });
    }
    if (page.draft !== false) {
      await request("PUT", `${branchPath(page.key)}/draft`, { draft: false });
      page.draft = false;
    }
  };

  /**
   * The open page of a branch that has just been pushed. Reading it is also what opens
   * one for a branch that never had any. A page somebody closed is reopened, and one that
   * is neither (merged, with the branch since pushed again) is waited on, since the
   * forge's queue may be about to open its successor.
   */
  const openPage = async (branch: string): Promise<Row | undefined> => {
    for (let attempt = 0; attempt < PAGE_ATTEMPTS; attempt += 1) {
      if (attempt > 0) await sleep(PAGE_WAIT_MS);
      const got = await request("GET", branchPath(branch), undefined, [404]);
      if (got.status === 404) continue;
      if (got.data["state"] === "open") return got.data;
      if (got.data["state"] === "closed") {
        const reopened = await request("POST", `${branchPath(branch)}/reopen`, undefined, [422]);
        if (reopened.status !== 422 && reopened.data["state"] === "open") return reopened.data;
      }
    }
    return undefined;
  };

  const ensureBugLabel = async (): Promise<void> => {
    const { data } = await request("GET", "/labels");
    if (hasBugLabel(data["labels"])) return;
    // 409: somebody made it in between, which is all that was wanted.
    await request(
      "POST",
      "/labels",
      { name: BUG_LABEL, color: BUG_COLOR, description: "Something is not working" },
      [409],
    );
  };

  return {
    changeForm: "branch-page",

    async listPullRequests() {
      const found: OpenPullRequest[] = [];
      for (const row of await list("/branch-pages?state=open")) {
        const number = wholeNumber(row["number"]);
        const branch = text(row["headRef"]);
        // Anyone can propose a fork's `plugingen/x` here; that page is not ours.
        if (number === undefined || row["crossRepository"] !== false) continue;
        const plugin = isWatcherBranch(branch) ? pluginOfBranch(branch) : undefined;
        if (!plugin) continue;
        const key = text(row["key"]) || branch;
        const page = await request("GET", branchPath(key));
        known.set(number, { key, branch, draft: draftOf(row) });
        found.push({ number, url: pageUrl(key), plugin, body: text(page.data["body"]) });
      }
      return found;
    },

    async listIssues() {
      const found: OpenIssue[] = [];
      const query = `state=open&label=${BUG_LABEL}&q=${encodeURIComponent(ISSUE_SEARCH_WORDS)}`;
      for (const row of await list(`/issues?${query}`)) {
        const number = wholeNumber(row["number"]);
        // The search matches words anywhere; the title decides, exactly.
        const plugin = pluginOfIssueTitle(text(row["title"]));
        if (number === undefined || !plugin) continue;
        if (typeof row["state"] === "string" && row["state"] !== "open") continue;
        // The list has no bodies.
        const issue = await request("GET", `/issues/${number}`);
        found.push({ number, plugin, body: text(issue.data["body"]) });
      }
      return found;
    },

    async createPullRequest(branch, title, body) {
      checkWatcherBranch(branch);
      let page = await openPage(branch);
      if (!page) {
        const proposed = await request(
          "POST",
          "/branch-pages",
          { head: branch, title, body, draft: false },
          [409],
        );
        // 409: it was opened in between, so that one is the page.
        page =
          proposed.status === 409 ? (await request("GET", branchPath(branch))).data : proposed.data;
      }
      const key = text(page["key"]) || branch;
      await present({ key, branch, draft: draftOf(page) }, { title, body }, page);
      return pageUrl(key);
    },

    async editPullRequest(number, body) {
      const page = await pageOf(number);
      checkWatcherBranch(page.branch);
      const plugin = pluginOfBranch(page.branch);
      await present(page, { ...(plugin ? { title: pullRequestTitle(plugin) } : {}), body });
    },

    async closePullRequest(number, comment) {
      const page = await pageOf(number);
      checkWatcherBranch(page.branch);
      await request("POST", `/issues/${number}/comments`, { body: comment });
      // 422: it is closed or merged already. The branch still goes.
      await request("POST", `${branchPath(page.key)}/close`, undefined, [422]);
      await deps.git.deleteBranch(page.branch);
      known.delete(number);
    },

    async createIssue(title, body) {
      // An issue cannot carry a label the repository does not have.
      await ensureBugLabel();
      const { data } = await request("POST", "/issues", { title, body, labels: [BUG_LABEL] });
      const number = wholeNumber(data["number"]);
      if (number === undefined) throw fail("POST", "/issues", "the forge named no issue");
      // The forge leaves labels out, without refusing, for a caller who cannot triage. An
      // issue without the label is one no later run would find, so a new one would be
      // opened every day: take it back and say why.
      if (Array.isArray(data["labels"]) && !hasBugLabel(data["labels"])) {
        await request(
          "PATCH",
          `/issues/${number}`,
          { state: "closed", stateReason: "not_planned" },
          [403, 404, 422],
        );
        throw fail(
          "POST",
          "/issues",
          `issue #${number} was opened without the ${BUG_LABEL} label, so it was closed again`,
          `The token's account needs triage access to ${repository}.`,
        );
      }
      return issueUrl(number);
    },

    async editIssue(number, body) {
      await request("PATCH", `/issues/${number}`, { body });
    },

    async closeIssue(number, comment) {
      await request("POST", `/issues/${number}/comments`, { body: comment });
      await request("PATCH", `/issues/${number}`, { state: "closed", stateReason: "completed" });
    },
  };
}
