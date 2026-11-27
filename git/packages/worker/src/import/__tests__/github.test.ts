import { describe, expect, it } from "vitest";
import {
  GITHUB_API,
  GitHubError,
  type GitHubFetch,
  hasNextPage,
  issueNumberOf,
  makeGitHubClient,
  rateLimitWait,
  rateOf,
  repositoryPath,
} from "../github";

const TOKEN = "unit-test-credential-0123456789";
const NOW = 1_800_000_000_000;

interface Seen {
  readonly url: URL;
  readonly init: RequestInit;
}

const json = (body: unknown, init: ResponseInit = {}): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });

const clientWith = (answer: (url: URL) => Response | Promise<Response>) => {
  const seen: Seen[] = [];
  const fetch: GitHubFetch = async (url, init) => {
    const parsed = new URL(url);
    seen.push({ url: parsed, init });
    return answer(parsed);
  };
  return { seen, client: makeGitHubClient({ token: TOKEN, fetch, now: () => NOW }) };
};

describe("the parts of a response", () => {
  it("reads a next page from the Link header", () => {
    expect(hasNextPage(null)).toBe(null);
    expect(
      hasNextPage(
        '<https://api.github.com/repositories/1/issues?page=2>; rel="next", <https://api.github.com/repositories/1/issues?page=9>; rel="last"',
      ),
    ).toBe(true);
    expect(
      hasNextPage(
        '<https://api.github.com/repositories/1/issues?page=1>; rel="prev", <https://api.github.com/repositories/1/issues?page=1>; rel="first"',
      ),
    ).toBe(false);
  });

  it("reads the rate limit headers, the reset as milliseconds", () => {
    expect(
      rateOf(new Headers({ "x-ratelimit-remaining": "12", "x-ratelimit-reset": "1800000100" })),
    ).toEqual({ remaining: 12, resetAt: 1_800_000_100_000 });
    expect(rateOf(new Headers())).toEqual({ remaining: null, resetAt: null });
    expect(rateOf(new Headers({ "x-ratelimit-remaining": "soon" }))).toEqual({
      remaining: null,
      resetAt: null,
    });
  });

  it("finds a comment's issue number, and percent-encodes a repository's path", () => {
    expect(issueNumberOf("https://api.github.com/repos/acme-example/widgets/issues/41")).toBe(41);
    expect(issueNumberOf("https://api.github.com/repos/acme-example/widgets/pulls/41")).toBe(null);
    expect(repositoryPath("acme-example/widgets")).toBe("/repos/acme-example/widgets");
    expect(repositoryPath("a b/c?d")).toBe("/repos/a%20b/c%3Fd");
  });
});

describe("rateLimitWait", () => {
  const wait = (status: number, headers: Record<string, string>, message = "") =>
    rateLimitWait(status, new Headers(headers), message, NOW);

  it("waits until the reset when nothing remains", () => {
    expect(wait(403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1800000600" })).toEqual({
      until: 1_800_000_600_000,
      limit: "primary",
    });
    expect(wait(429, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1800000600" })).toEqual({
      until: 1_800_000_600_000,
      limit: "primary",
    });
  });

  it("never answers an instant already past", () => {
    expect(wait(403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1700000000" })).toEqual({
      until: NOW + 1000,
      limit: "primary",
    });
  });

  it("takes retry-after over the reset", () => {
    expect(
      wait(403, {
        "retry-after": "30",
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": "1800000600",
      }),
    ).toEqual({ until: NOW + 30_000, limit: "secondary" });
  });

  it("waits a minute for a secondary limit that names no time", () => {
    expect(
      wait(
        403,
        { "x-ratelimit-remaining": "4000" },
        "You have exceeded a secondary rate limit. Please wait a few minutes before you try again.",
      ),
    ).toEqual({ until: NOW + 60_000, limit: "secondary" });
    expect(wait(429, {})).toEqual({ until: NOW + 60_000, limit: "secondary" });
  });

  it("leaves a plain refusal, and every other status, alone", () => {
    expect(wait(403, { "x-ratelimit-remaining": "4000" }, "Resource not accessible")).toBe(null);
    expect(wait(404, { "x-ratelimit-remaining": "0" })).toBe(null);
    expect(wait(200, { "retry-after": "5" })).toBe(null);
  });
});

describe("the client", () => {
  it("asks the one host, with the token, the version, and redirects off", async () => {
    const { client, seen } = clientWith(() => json([]));
    await client.issues("acme-example/widgets", { page: 3, since: "2024-05-01T00:00:00.000Z" });
    await client.comments("acme-example/widgets", { page: 2 });
    await client.labels("acme-example/widgets", 1);
    await client.milestones("acme-example/widgets", 1);
    expect(client.requests()).toBe(4);
    for (const { url, init } of seen) {
      expect(url.origin).toBe(GITHUB_API);
      expect(init.redirect).toBe("manual");
      expect(init.method).toBe("GET");
      const headers = new Headers(init.headers);
      expect(headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
      expect(headers.get("accept")).toBe("application/vnd.github+json");
      expect(headers.get("x-github-api-version")).toBe("2022-11-28");
      expect(headers.get("user-agent")).toBe("infrawrench-git-import");
    }
    const [issues, comments, labels, milestones] = seen.map(({ url }) => url);
    expect(issues!.pathname).toBe("/repos/acme-example/widgets/issues");
    expect(Object.fromEntries(issues!.searchParams)).toEqual({
      state: "all",
      sort: "created",
      direction: "asc",
      per_page: "100",
      page: "3",
      since: "2024-05-01T00:00:00.000Z",
    });
    expect(comments!.pathname).toBe("/repos/acme-example/widgets/issues/comments");
    expect(Object.fromEntries(comments!.searchParams)).toEqual({
      sort: "created",
      direction: "asc",
      per_page: "100",
      page: "2",
    });
    expect(labels!.pathname).toBe("/repos/acme-example/widgets/labels");
    expect(milestones!.searchParams.get("state")).toBe("all");
  });

  it("pages by the Link header, and by a full page without one", async () => {
    const one = { name: "bug", color: "d73a4a", description: null, node_id: "ignored" };
    const linked = clientWith(() =>
      json([one], {
        headers: { link: '<https://api.github.com/repositories/1/labels?page=2>; rel="next"' },
      }),
    );
    expect(await linked.client.labels("acme-example/widgets", 1)).toMatchObject({
      kind: "ok",
      more: true,
      value: [{ name: "bug", color: "d73a4a" }],
    });
    const last = clientWith(() =>
      json([one], {
        headers: { link: '<https://api.github.com/repositories/1/labels?page=1>; rel="prev"' },
      }),
    );
    expect(await last.client.labels("acme-example/widgets", 2)).toMatchObject({ more: false });
    const full = clientWith(() => json(Array.from({ length: 100 }, () => one)));
    expect(await full.client.labels("acme-example/widgets", 1)).toMatchObject({ more: true });
    const short = clientWith(() => json(Array.from({ length: 99 }, () => one)));
    expect(await short.client.labels("acme-example/widgets", 1)).toMatchObject({ more: false });
  });

  it("decodes leniently: unknown fields ignored, a null user kept as null", async () => {
    const { client } = clientWith(() =>
      json([
        {
          id: 9_000_000_003,
          number: 3,
          title: "No author",
          body: null,
          state: "open",
          user: null,
          labels: ["bug", { id: 1, name: "enhancement", color: "a2eeef" }],
          created_at: "2023-02-01T10:00:00Z",
          reactions: { total_count: 2 },
          something_new: { nested: true },
        },
      ]),
    );
    const answer = await client.issues("acme-example/widgets", { page: 1 });
    expect(answer).toMatchObject({
      kind: "ok",
      value: [
        { id: 9_000_000_003, user: null, body: null, labels: ["bug", { name: "enhancement" }] },
      ],
    });
  });

  it("answers a rate limit as a wait, and reads nothing else of the body", async () => {
    const primary = clientWith(() =>
      json(
        { message: "API rate limit exceeded for user ID 1.", documentation_url: "https://docs" },
        {
          status: 403,
          headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1800000900" },
        },
      ),
    );
    expect(await primary.client.comments("acme-example/widgets", { page: 4 })).toEqual({
      kind: "wait",
      until: 1_800_000_900_000,
      limit: "primary",
    });
    const secondary = clientWith(() =>
      json({ message: "You have exceeded a secondary rate limit." }, { status: 403 }),
    );
    expect(await secondary.client.user("mona-example")).toEqual({
      kind: "wait",
      until: NOW + 60_000,
      limit: "secondary",
    });
  });

  it("answers a missing account as null, and a missing repository as an error", async () => {
    const { client } = clientWith(() => json({ message: "Not Found" }, { status: 404 }));
    expect(await client.user("nobody-example")).toMatchObject({ kind: "ok", value: null });
    await expect(client.labels("acme-example/widgets", 1)).rejects.toMatchObject({
      kind: "not_found",
      status: 404,
    });
  });

  it("names each failure without the token or the response in it", async () => {
    const secret = "the response said something private";
    const cases: ReadonlyArray<readonly [number, string]> = [
      [401, "unauthorized"],
      [403, "forbidden"],
      [410, "gone"],
      [301, "redirect"],
      [302, "redirect"],
      [502, "unavailable"],
      [418, "unexpected"],
    ];
    for (const [status, kind] of cases) {
      const { client } = clientWith(
        () =>
          new Response(status >= 300 && status < 400 ? null : JSON.stringify({ message: secret }), {
            status,
            headers: { location: "https://elsewhere.example/widgets" },
          }),
      );
      const error = await client.issues("acme-example/widgets", { page: 1 }).catch((e) => e);
      expect(error).toBeInstanceOf(GitHubError);
      expect(error).toMatchObject({ kind, status });
      const text = `${error.message} ${String(error.stack)} ${JSON.stringify(error)}`;
      expect(text).not.toContain(TOKEN);
      expect(text).not.toContain(secret);
      expect(text).not.toContain("elsewhere.example");
    }
  });

  it("does not follow a redirect", async () => {
    const { client, seen } = clientWith(
      () => new Response(null, { status: 301, headers: { location: "https://elsewhere.example" } }),
    );
    await expect(client.labels("old-example/widgets", 1)).rejects.toMatchObject({
      kind: "redirect",
    });
    expect(seen).toHaveLength(1);
  });

  it("turns a failed connection and an unreadable body into its own errors", async () => {
    const down = makeGitHubClient({
      token: TOKEN,
      fetch: async () => {
        throw new Error(`connect failed with Bearer ${TOKEN}`);
      },
    });
    const error = await down.labels("acme-example/widgets", 1).catch((e) => e);
    expect(error).toMatchObject({ kind: "unavailable", status: 0 });
    expect(`${error.message} ${String(error.cause)}`).not.toContain(TOKEN);

    const html = clientWith(() => new Response("<html>", { status: 200 }));
    await expect(html.client.labels("acme-example/widgets", 1)).rejects.toMatchObject({
      kind: "invalid",
    });
    const wrong = clientWith(() => json({ not: "a list" }));
    await expect(wrong.client.labels("acme-example/widgets", 1)).rejects.toMatchObject({
      kind: "invalid",
    });
  });
});
