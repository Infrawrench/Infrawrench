import { describe, expect, it, vi } from "vitest";
import type { CheckReport } from "../check.js";
import {
  checkWatcherBranch,
  createForgeTracker,
  forgeCredentials,
  forgeRemote,
  forgeSettings,
  type ForgeSettings,
} from "../watch/forge.js";
import { issueTitle, renderPullRequestBody } from "../watch/render.js";

// Not shaped like a real token of anyone's, so no scanner minds it.
const TOKEN = "plugingen-test-credential-0123456789";
const SETTINGS: ForgeSettings = {
  origin: "https://forge.test",
  owner: "Acme",
  repo: "Mono",
  token: TOKEN,
};
const API = "https://forge.test/api/repos/Acme/Mono";

interface Call {
  method: string;
  /** Path and query below `/api/repos/Acme/Mono`. */
  path: string;
  body: unknown;
  headers: Record<string, string>;
}

type Reply = { status?: number; json?: unknown; text?: string; headers?: Record<string, string> };
type Route = (call: Call) => Reply | undefined;

/** A stand-in forge: each route answers the calls it knows, and anything else is a 500. */
function forge(...routes: Route[]) {
  const calls: Call[] = [];
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    expect(url.startsWith(API)).toBe(true);
    expect(init?.redirect).toBe("error");
    const call: Call = {
      method: init?.method ?? "GET",
      path: url.slice(API.length),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      headers: { ...(init?.headers as Record<string, string>) },
    };
    calls.push(call);
    for (const route of routes) {
      const reply = route(call);
      if (reply) {
        return new Response(reply.text ?? JSON.stringify(reply.json ?? {}), {
          status: reply.status ?? 200,
          headers: reply.headers ?? {},
        });
      }
    }
    return new Response(JSON.stringify({ error: `no route for ${call.method} ${call.path}` }), {
      status: 500,
    });
  });
  const git = { deleteBranch: vi.fn(async (_branch: string) => {}) };
  const sleep = vi.fn(async (_ms: number) => {});
  const tracker = createForgeTracker(SETTINGS, {
    fetch: fetch as typeof globalThis.fetch,
    git,
    sleep,
  });
  const writes = () => calls.filter((call) => call.method !== "GET");
  return { tracker, calls, writes, git, sleep };
}

const on =
  (method: string, path: string | RegExp, reply: Reply | ((call: Call) => Reply)): Route =>
  (call) => {
    if (call.method !== method) return undefined;
    if (typeof path === "string" ? call.path !== path : !path.test(call.path)) return undefined;
    return typeof reply === "function" ? reply(call) : reply;
  };

const HOSTILE = "$(touch /tmp/pwned) `id` ; rm -rf / \"' \n::error::x @everyone";

describe("forgeSettings", () => {
  it("defaults to the monorepo on git.infrawrench.com", () => {
    expect(forgeSettings({ PLUGINGEN_FORGE_TOKEN: TOKEN })).toEqual({
      origin: "https://git.infrawrench.com",
      owner: "Infrawrench",
      repo: "Infrawrench",
      token: TOKEN,
    });
  });

  it("takes another address and repository, and drops a trailing slash", () => {
    const settings = forgeSettings({
      PLUGINGEN_FORGE_URL: "http://localhost:5174/",
      PLUGINGEN_FORGE_REPOSITORY: "acme/infra.tools",
      PLUGINGEN_FORGE_TOKEN: TOKEN,
    });
    expect(settings.origin).toBe("http://localhost:5174");
    expect(forgeRemote(settings)).toBe("http://localhost:5174/acme/infra.tools.git");
  });

  it("names the variable when the token is missing or empty", () => {
    expect(() => forgeSettings({})).toThrow(/PLUGINGEN_FORGE_TOKEN is not set/);
    expect(() => forgeSettings({ PLUGINGEN_FORGE_TOKEN: "" })).toThrow(/PLUGINGEN_FORGE_TOKEN/);
  });

  it("refuses a token that could not be one, without repeating it", () => {
    const bad = `${TOKEN}\npassword=other`;
    let message = "";
    try {
      forgeSettings({ PLUGINGEN_FORGE_TOKEN: bad });
    } catch (error) {
      message = String(error);
    }
    expect(message).toContain("PLUGINGEN_FORGE_TOKEN");
    expect(message).not.toContain(TOKEN);
  });

  it.each([
    ["not a url", /is not a URL/],
    ["http://forge.test", /https/],
    ["https://user:pw@forge.test", /address alone/],
    ["https://forge.test/some/path", /address alone/],
    ["https://forge.test/?x=1", /address alone/],
  ])("refuses the address %s", (url, message) => {
    expect(() => forgeSettings({ PLUGINGEN_FORGE_URL: url, PLUGINGEN_FORGE_TOKEN: TOKEN })).toThrow(
      message,
    );
  });

  it.each(["acme", "acme/infra/more", "acme/infra.git", "-acme/infra", "acme/in fra", "../x/y"])(
    "refuses the repository %s",
    (repository) => {
      expect(() =>
        forgeSettings({ PLUGINGEN_FORGE_REPOSITORY: repository, PLUGINGEN_FORGE_TOKEN: TOKEN }),
      ).toThrow(/PLUGINGEN_FORGE_REPOSITORY must be owner\/name/);
    },
  );
});

describe("what git is given for the forge", () => {
  it("has the token in neither the remote nor the arguments", () => {
    const everything = [forgeRemote(SETTINGS), ...forgeCredentials(SETTINGS)].join("\n");
    expect(everything).not.toContain(TOKEN);
    expect(forgeRemote(SETTINGS)).toBe("https://forge.test/Acme/Mono.git");
    expect(new URL(forgeRemote(SETTINGS)).username).toBe("");
  });

  it("drops inherited helpers, answers for the forge alone and follows no redirect", () => {
    const args = forgeCredentials(SETTINGS);
    expect(args.slice(0, 2)).toEqual(["-c", "credential.helper="]);
    expect(args[3]).toMatch(/^credential\.https:\/\/forge\.test\.helper=!/);
    expect(args[3]).toContain('"$PLUGINGEN_FORGE_TOKEN"');
    expect(args.slice(4)).toEqual(["-c", "http.followRedirects=false"]);
  });

  it("only ever names a plugingen branch", () => {
    expect(() => checkWatcherBranch("plugingen/acme-cloud2")).not.toThrow();
    for (const branch of [
      "main",
      "plugingen/",
      "plugingen/Acme",
      "plugingen/a/b",
      "plugingen/a b",
      "plugingen/../main",
      "plugingen/a\nmain",
      "refs/heads/plugingen/a",
      "owner/repo:plugingen/a",
      "plugingen/a~2",
      "--delete",
    ]) {
      expect(() => checkWatcherBranch(branch)).toThrow(/not a branch plugingen watch owns/);
    }
  });
});

describe("issues on the forge", () => {
  const summary = (number: number, title: string, extra: object = {}) => ({
    id: `id-${number}`,
    number,
    title,
    state: "open",
    stateReason: null,
    labels: [{ id: "l1", name: "bug", color: "d73a4a", description: null }],
    ...extra,
  });

  it("finds its issues by exact title across pages, and reads each one's body", async () => {
    const { tracker, calls } = forge(
      on("GET", /^\/issues\?.*cursor=c2/, {
        json: {
          items: [summary(9, issueTitle("zeta")), summary(10, `Re: ${issueTitle("acme")}`)],
          nextCursor: null,
          counts: { open: 4, closed: 0 },
        },
      }),
      on("GET", /^\/issues\?/, {
        json: {
          items: [
            summary(3, issueTitle("acme")),
            summary(4, `${issueTitle("acme")} (again)`),
            summary(5, "plugingen: Acme could not be checked against its vendor document"),
          ],
          nextCursor: "c2",
        },
      }),
      on("GET", /^\/issues\/\d+$/, (call) => ({ json: { body: `body of ${call.path}` } })),
    );

    await expect(tracker.listIssues()).resolves.toEqual([
      { number: 3, plugin: "acme", body: "body of /issues/3" },
      { number: 9, plugin: "zeta", body: "body of /issues/9" },
    ]);
    const [first, second] = calls;
    const query = new URLSearchParams(first?.path.split("?")[1]);
    expect(Object.fromEntries(query)).toEqual({
      state: "open",
      label: "bug",
      q: "plugingen checked vendor document",
      limit: "100",
    });
    expect(new URLSearchParams(second?.path.split("?")[1]).get("cursor")).toBe("c2");
    expect(first?.headers["authorization"]).toBe(`Bearer ${TOKEN}`);
    expect(calls.every((call) => call.method === "GET")).toBe(true);
  });

  it("reads past fields and values it has never heard of", async () => {
    const { tracker } = forge(
      on("GET", /^\/issues\?/, {
        json: {
          items: [
            summary(3, issueTitle("acme"), {
              stateReason: "a_reason_from_next_year",
              severity: { level: 3 },
              labels: "not even a list",
            }),
            "not an object",
            null,
            { number: "7", title: issueTitle("acme") },
            { number: 8 },
          ],
          nextCursor: null,
          somethingNew: true,
        },
      }),
      on("GET", "/issues/3", { json: { body: "b", viewer: { canDoSomethingNew: true } } }),
    );
    await expect(tracker.listIssues()).resolves.toEqual([{ number: 3, plugin: "acme", body: "b" }]);
  });

  it("stops on a cursor that repeats rather than reading forever", async () => {
    const { tracker, calls } = forge(
      on("GET", /^\/issues\?/, { json: { items: [], nextCursor: "same" } }),
    );
    await expect(tracker.listIssues()).resolves.toEqual([]);
    expect(calls).toHaveLength(2);
  });

  it("makes the bug label when the repository has none, then opens the issue with it", async () => {
    const { tracker, writes } = forge(
      on("GET", "/labels", { json: { labels: [{ id: "l0", name: "question" }] } }),
      on("POST", "/labels", { status: 201, json: { id: "l1", name: "bug" } }),
      on("POST", "/issues", { json: summary(12, "t") }),
    );
    await expect(tracker.createIssue("t", HOSTILE)).resolves.toBe(
      "https://forge.test/Acme/Mono/issues/12",
    );
    expect(writes().map((call) => [call.method, call.path, call.body])).toEqual([
      [
        "POST",
        "/labels",
        { name: "bug", color: "d73a4a", description: "Something is not working" },
      ],
      ["POST", "/issues", { title: "t", body: HOSTILE, labels: ["bug"] }],
    ]);
  });

  it("uses the label that is there, whatever its case, or one made in between", async () => {
    const present = forge(
      on("GET", "/labels", { json: { labels: [{ id: "l1", name: "Bug" }] } }),
      on("POST", "/issues", { json: summary(12, "t") }),
    );
    await present.tracker.createIssue("t", "b");
    expect(present.writes().map((call) => call.path)).toEqual(["/issues"]);

    const raced = forge(
      on("GET", "/labels", { json: { labels: [] } }),
      on("POST", "/labels", { status: 409, json: { error: "exists", code: "name_taken" } }),
      on("POST", "/issues", { json: summary(12, "t") }),
    );
    await expect(raced.tracker.createIssue("t", "b")).resolves.toContain("/issues/12");
  });

  it("takes back an issue the forge opened without the label, and says why", async () => {
    const { tracker, writes } = forge(
      on("GET", "/labels", { json: { labels: [{ name: "bug" }] } }),
      on("POST", "/issues", { json: summary(12, "t", { labels: [] }) }),
      on("PATCH", "/issues/12", { json: {} }),
    );
    await expect(tracker.createIssue("t", "b")).rejects.toThrow(
      /issue #12 was opened without the bug label.*triage access/,
    );
    expect(writes().at(-1)).toMatchObject({
      method: "PATCH",
      path: "/issues/12",
      body: { state: "closed", stateReason: "not_planned" },
    });
  });

  it("rewrites a body, and closes with a comment", async () => {
    const { tracker, writes } = forge(
      on("PATCH", "/issues/3", { json: {} }),
      on("POST", "/issues/3/comments", { json: {} }),
    );
    await tracker.editIssue(3, HOSTILE);
    await tracker.closeIssue(3, "done");
    expect(writes().map((call) => [call.method, call.path, call.body])).toEqual([
      ["PATCH", "/issues/3", { body: HOSTILE }],
      ["POST", "/issues/3/comments", { body: "done" }],
      ["PATCH", "/issues/3", { state: "closed", stateReason: "completed" }],
    ]);
  });
});

describe("branch pages on the forge", () => {
  const page = (number: number, headRef: string, extra: object = {}) => ({
    number,
    key: headRef,
    headRef,
    title: "Plugingen acme",
    state: "open",
    draft: true,
    crossRepository: false,
    ...extra,
  });
  const ACME = "/branches/plugingen%2Facme";

  it("lists the open pages of its own branches, with their descriptions", async () => {
    const { tracker, calls } = forge(
      on("GET", /^\/branch-pages\?/, {
        json: {
          items: [
            page(7, "plugingen/acme", { status: "a_status_from_next_year" }),
            page(8, "feature/x"),
            page(9, "plugingen/fork", { crossRepository: true, key: "them/Mono:plugingen/fork" }),
            page(10, "plugingen/Not-A-Plugin"),
            page(11, "plugingen/unsaid", { crossRepository: undefined }),
          ],
          nextCursor: null,
        },
      }),
      on("GET", ACME, { json: { ...page(7, "plugingen/acme"), body: "the body" } }),
    );
    await expect(tracker.listPullRequests()).resolves.toEqual([
      {
        number: 7,
        plugin: "acme",
        body: "the body",
        url: "https://forge.test/Acme/Mono/branches/plugingen/acme",
      },
    ]);
    expect(calls[0]?.path).toBe("/branch-pages?state=open&limit=100");
    expect(tracker.changeForm).toBe("branch-page");
  });

  it("waits for the pushed branch's page, then titles it, describes it and marks it ready", async () => {
    let reads = 0;
    const { tracker, writes, sleep } = forge(
      on("GET", ACME, () => {
        reads += 1;
        return reads < 3
          ? { status: 404, json: { error: "No such branch page" } }
          : { json: { ...page(7, "plugingen/acme"), body: "" } };
      }),
      on("PATCH", ACME, { json: {} }),
      on("PUT", `${ACME}/draft`, { json: {} }),
    );
    await expect(tracker.createPullRequest("plugingen/acme", "the title", HOSTILE)).resolves.toBe(
      "https://forge.test/Acme/Mono/branches/plugingen/acme",
    );
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(writes().map((call) => [call.method, call.path, call.body])).toEqual([
      ["PATCH", ACME, { title: "the title", body: HOSTILE }],
      ["PUT", `${ACME}/draft`, { draft: false }],
    ]);
  });

  it("writes nothing to a page that already says it and is ready", async () => {
    const { tracker, writes } = forge(
      on("GET", ACME, {
        json: { ...page(7, "plugingen/acme", { draft: false, title: "t" }), body: "b" },
      }),
    );
    await tracker.createPullRequest("plugingen/acme", "t", "b");
    expect(writes()).toEqual([]);
  });

  it("reopens a page somebody closed", async () => {
    const { tracker, writes } = forge(
      on("GET", ACME, { json: { ...page(7, "plugingen/acme", { state: "closed" }), body: "b" } }),
      on("POST", `${ACME}/reopen`, {
        json: { ...page(7, "plugingen/acme", { draft: false, title: "t" }), body: "b" },
      }),
    );
    await tracker.createPullRequest("plugingen/acme", "t", "b");
    expect(writes().map((call) => `${call.method} ${call.path}`)).toEqual([`POST ${ACME}/reopen`]);
  });

  it("opens the page itself when none appears, or takes the one opened meanwhile", async () => {
    const merged = { ...page(3, "plugingen/acme", { state: "merged" }), body: "old" };
    const proposed = forge(
      on("GET", ACME, { json: merged }),
      on("POST", "/branch-pages", {
        json: { ...page(7, "plugingen/acme", { draft: false, title: "t" }), body: "b" },
      }),
    );
    await proposed.tracker.createPullRequest("plugingen/acme", "t", "b");
    expect(proposed.sleep).toHaveBeenCalledTimes(4);
    expect(proposed.writes().map((call) => [call.method, call.path, call.body])).toEqual([
      ["POST", "/branch-pages", { head: "plugingen/acme", title: "t", body: "b", draft: false }],
    ]);

    let reads = 0;
    const raced = forge(
      on("GET", ACME, () => {
        reads += 1;
        return reads <= 5
          ? { status: 404, json: { error: "No such branch page" } }
          : { json: { ...page(7, "plugingen/acme"), body: "" } };
      }),
      on("POST", "/branch-pages", {
        status: 409,
        json: { error: "This branch already has an open page", code: "branch_page_exists" },
      }),
      on("PATCH", ACME, { json: {} }),
      on("PUT", `${ACME}/draft`, { json: {} }),
    );
    await raced.tracker.createPullRequest("plugingen/acme", "t", "b");
    expect(raced.writes().map((call) => `${call.method} ${call.path}`)).toEqual([
      "POST /branch-pages",
      `PATCH ${ACME}`,
      `PUT ${ACME}/draft`,
    ]);
  });

  it("edits a listed page by its branch, with the watcher's title, and readies a draft", async () => {
    const { tracker, writes } = forge(
      on("GET", /^\/branch-pages\?/, {
        json: { items: [page(7, "plugingen/acme")], nextCursor: null },
      }),
      on("GET", ACME, { json: { body: "old" } }),
      on("PATCH", ACME, { json: {} }),
      on("PUT", `${ACME}/draft`, { json: {} }),
    );
    await tracker.listPullRequests();
    await tracker.editPullRequest(7, "new body");
    await tracker.editPullRequest(7, "newer body");
    expect(writes().map((call) => [call.method, call.path, call.body])).toEqual([
      ["PATCH", ACME, { title: "chore(acme): update generated API types", body: "new body" }],
      ["PUT", `${ACME}/draft`, { draft: false }],
      ["PATCH", ACME, { title: "chore(acme): update generated API types", body: "newer body" }],
    ]);
  });

  it("asks which branch a number names when it did not list it", async () => {
    const { tracker, calls } = forge(
      on("GET", "/branch-pages/7", { json: { key: "plugingen/acme" } }),
      on("PATCH", ACME, { json: {} }),
      on("PUT", `${ACME}/draft`, { json: {} }),
    );
    await tracker.editPullRequest(7, "b");
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "GET /branch-pages/7",
      `PATCH ${ACME}`,
      `PUT ${ACME}/draft`,
    ]);
  });

  it("closes with a comment, closes the page and deletes the branch", async () => {
    const { tracker, writes, git } = forge(
      on("GET", "/branch-pages/7", { json: { key: "plugingen/acme" } }),
      on("POST", "/issues/7/comments", { json: {} }),
      on("POST", `${ACME}/close`, { json: {} }),
    );
    await tracker.closePullRequest(7, "matches main");
    expect(writes().map((call) => [call.method, call.path, call.body])).toEqual([
      ["POST", "/issues/7/comments", { body: "matches main" }],
      ["POST", `${ACME}/close`, undefined],
    ]);
    expect(git.deleteBranch.mock.calls).toEqual([["plugingen/acme"]]);
  });

  it("still deletes the branch of a page that is closed already", async () => {
    const { tracker, git } = forge(
      on("GET", "/branch-pages/7", { json: { key: "plugingen/acme" } }),
      on("POST", "/issues/7/comments", { json: {} }),
      on("POST", `${ACME}/close`, {
        status: 422,
        json: { error: "already", code: "already_merged" },
      }),
    );
    await tracker.closePullRequest(7, "c");
    expect(git.deleteBranch).toHaveBeenCalledWith("plugingen/acme");
  });

  it("never closes or deletes a branch that is not the watcher's", async () => {
    for (const key of ["main", "them/Mono:plugingen/acme", "plugingen/acme~2"]) {
      const { tracker, writes, git } = forge(on("GET", "/branch-pages/7", { json: { key } }));
      await expect(tracker.closePullRequest(7, "c")).rejects.toThrow(/not a branch plugingen/);
      await expect(tracker.editPullRequest(7, "b")).rejects.toThrow(/not a branch plugingen/);
      expect(writes()).toEqual([]);
      expect(git.deleteBranch).not.toHaveBeenCalled();
    }
    const { tracker } = forge();
    await expect(tracker.createPullRequest("main", "t", "b")).rejects.toThrow(/not a branch/);
  });
});

describe("when the forge refuses or is away", () => {
  it("explains a refused token by its variable and never repeats the token", async () => {
    for (const status of [401, 403]) {
      const { tracker } = forge(
        on("GET", /^\/issues\?/, {
          status,
          json: { error: `This needs a signed-in person, not ${TOKEN}` },
        }),
      );
      const failure = await tracker.listIssues().catch((error: unknown) => String(error));
      expect(failure).toContain(`HTTP ${status}: This needs a signed-in person, not ***`);
      expect(failure).toContain("Check PLUGINGEN_FORGE_TOKEN");
      expect(failure).toContain("iwg_");
      expect(failure).not.toContain(TOKEN);
    }
  });

  it("says when the repository cannot be seen", async () => {
    const { tracker } = forge(
      on("GET", /^\/issues\?/, { status: 404, json: { error: "Repository not found" } }),
    );
    await expect(tracker.listIssues()).rejects.toThrow(/Acme\/Mono does not exist on the forge/);
  });

  it("keeps the token out of a network failure's message", async () => {
    const tracker = createForgeTracker(SETTINGS, {
      fetch: (async () => {
        throw new TypeError(`fetch failed for Bearer ${TOKEN}`);
      }) as typeof fetch,
      git: { deleteBranch: async () => {} },
    });
    const failure = await tracker.listPullRequests().catch((error: unknown) => String(error));
    expect(failure).toContain("the forge could not be reached");
    expect(failure).not.toContain(TOKEN);
  });

  it("flattens whatever the forge says into one line", async () => {
    const { tracker } = forge(
      on("PATCH", "/issues/3", { status: 422, json: { error: "no\n::error::x\u001b[31m" } }),
    );
    const failure = await tracker.editIssue(3, "b").catch((error: unknown) => String(error));
    expect(failure).not.toContain("\n");
    expect(failure).toContain("forge PATCH /issues/3 failed: HTTP 422");
  });

  it("reports an answer that is not JSON", async () => {
    const { tracker } = forge(on("GET", /^\/issues\?/, { text: "<html>hello</html>" }));
    await expect(tracker.listIssues()).rejects.toThrow(/not JSON/);
  });

  it("waits and tries again when told it is asking too fast", async () => {
    let asked = 0;
    const { tracker, sleep } = forge(
      on("GET", /^\/issues\?/, () => {
        asked += 1;
        return asked === 1
          ? { status: 429, json: { error: "slow down" }, headers: { "retry-after": "3" } }
          : { json: { items: [], nextCursor: null } };
      }),
    );
    await expect(tracker.listIssues()).resolves.toEqual([]);
    expect(sleep).toHaveBeenCalledWith(3000);
  });

  it("gives up on a forge that stays busy", async () => {
    const { tracker, calls } = forge(
      on("GET", /^\/issues\?/, { status: 503, json: { error: "storage is away" } }),
    );
    await expect(tracker.listIssues()).rejects.toThrow(/HTTP 503: storage is away/);
    expect(calls).toHaveLength(3);
  });
});

describe("a branch page's description", () => {
  const report: CheckReport = {
    plugin: "acme",
    status: "changed",
    reason: "changed",
    specUrls: ["https://vendor.test/doc"],
    documents: [],
    operations: ["GET /a` @everyone\n# heading"],
  };

  it("is the pull request's, guards included, under the forge's own words", () => {
    const typecheck = { state: "failed", output: "error TS1: ```\n@everyone" } as const;
    const pullRequest = renderPullRequestBody(report, typecheck);
    const branchPage = renderPullRequestBody(report, typecheck, "branch-page");
    expect(renderPullRequestBody(report, typecheck, "pull-request")).toBe(pullRequest);

    const upToFooter = (body: string) => body.slice(0, body.lastIndexOf("\n---\n"));
    expect(upToFooter(branchPage)).toBe(
      upToFooter(pullRequest).replace(
        "this pull request exists for",
        "this branch page exists for",
      ),
    );
    expect(branchPage).not.toContain("pull request");
    expect(branchPage).toContain("deletes the branch");
    expect(branchPage).toContain("- `GET /a' @everyone # heading`");
    expect(branchPage).toContain("````text\nerror TS1: ```\n@everyone\n````");
  });
});
