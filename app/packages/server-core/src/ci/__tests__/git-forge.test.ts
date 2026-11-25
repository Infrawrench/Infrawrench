import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { verifyGitJobToken } from "@infrawrench/client-core";

import {
  gitArchiveLink,
  gitBranchHead,
  gitReadFile,
  lsRefsRequest,
  parseLsRefs,
  pktLine,
} from "../git-forge";

const KEY = "k".repeat(48);
const A = "a".repeat(40);
const B = "b".repeat(40);
const repo = { gitRepositoryId: "repo-1", repoFullName: "Acme/web" };

interface Seen {
  url: string;
  init: RequestInit;
}

/** A forge that answers every request the same way, and remembers what it was asked. */
function forge(answer: () => Response): { fetcher: typeof fetch; seen: Seen[] } {
  const seen: Seen[] = [];
  const fetcher = (async (url: string | URL | Request, init: RequestInit = {}) => {
    seen.push({ url: String(url), init });
    return answer();
  }) as typeof fetch;
  return { fetcher, seen };
}

const header = (init: RequestInit, name: string): string =>
  (init.headers as Record<string, string>)[name] ?? "";

beforeEach(() => {
  process.env["GIT_JOB_TOKEN_KEY"] = KEY;
});

afterEach(() => {
  delete process.env["GIT_JOB_TOKEN_KEY"];
  delete process.env["GIT_BASE_URL"];
});

describe("pkt-lines", () => {
  it("counts its own four digits in the length", () => {
    expect(pktLine("command=ls-refs\n")).toBe("0014command=ls-refs\n");
  });

  it("asks for one prefix, capabilities and arguments apart", () => {
    expect(lsRefsRequest("refs/heads/main")).toBe(
      "0014command=ls-refs\n" +
        "0019agent=infrawrench-ci\n" +
        "0001" +
        "001fref-prefix refs/heads/main\n" +
        "0000",
    );
  });

  it("reads the refs of an answer, skipping what is not one", () => {
    const body =
      pktLine(`${A} refs/heads/main\n`) +
      pktLine(`${B} refs/heads/main-2 symref-target:refs/heads/x\n`) +
      pktLine("unborn HEAD\n") +
      "0000";
    expect([...parseLsRefs(body)]).toEqual([
      ["refs/heads/main", A],
      ["refs/heads/main-2", B],
    ]);
    expect(parseLsRefs("").size).toBe(0);
    expect(parseLsRefs("not pkt-lines at all").size).toBe(0);
  });
});

describe("gitBranchHead", () => {
  it("asks the forge over smart HTTP v2, with a read-only job token as git sends one", async () => {
    const { fetcher, seen } = forge(
      () => new Response(pktLine(`${A} refs/heads/main\n`) + "0000", { status: 200 }),
    );
    expect(await gitBranchHead(repo, "main", fetcher)).toBe(A);
    const [request] = seen;
    expect(request?.url).toBe("https://git.infrawrench.com/Acme/web.git/git-upload-pack");
    expect(request?.init.method).toBe("POST");
    expect(header(request!.init, "Git-Protocol")).toBe("version=2");
    expect(request?.init.body).toBe(lsRefsRequest("refs/heads/main"));
    const [scheme, encoded] = header(request!.init, "Authorization").split(" ");
    expect(scheme).toBe("Basic");
    const [user, token] = atob(encoded ?? "").split(":");
    expect(user).toBe("x-access-token");
    expect(await verifyGitJobToken(KEY, token ?? "", { repositoryId: "repo-1" })).toMatchObject({
      ok: true,
      claims: { access: "read" },
    });
  });

  it("takes only the branch asked for, not one its name begins", async () => {
    const { fetcher } = forge(
      () => new Response(pktLine(`${B} refs/heads/main-2\n`) + "0000", { status: 200 }),
    );
    expect(await gitBranchHead(repo, "main", fetcher)).toBeNull();
  });

  it("answers no branch for a repository that is gone, and throws when it cannot ask", async () => {
    expect(
      await gitBranchHead(repo, "main", forge(() => new Response("", { status: 404 })).fetcher),
    ).toBeNull();
    await expect(
      gitBranchHead(repo, "main", forge(() => new Response("", { status: 503 })).fetcher),
    ).rejects.toThrow(/503/);
  });
});

describe("gitReadFile", () => {
  it("reads a file at a commit with a Bearer job token", async () => {
    const { fetcher, seen } = forge(() => new Response("[env]\nA = 1\n", { status: 200 }));
    expect(await gitReadFile(repo, "deploy/.infraenv", A, fetcher)).toBe("[env]\nA = 1\n");
    expect(seen[0]?.url).toBe(`https://git.infrawrench.com/Acme/web/raw/${A}/deploy/.infraenv`);
    const token = header(seen[0]!.init, "Authorization").replace(/^Bearer /, "");
    expect((await verifyGitJobToken(KEY, token, { repositoryId: "repo-1" })).ok).toBe(true);
  });

  it("answers null for a file the commit does not have", async () => {
    const { fetcher } = forge(() => new Response("", { status: 404 }));
    expect(await gitReadFile(repo, ".infraenv", A, fetcher)).toBeNull();
  });

  it("escapes a path's segments, and asks nothing for what is not a commit", async () => {
    const { fetcher, seen } = forge(() => new Response("x", { status: 200 }));
    await gitReadFile(repo, "a b/#c?.env", A, fetcher);
    expect(seen[0]?.url.endsWith(`/raw/${A}/a%20b/%23c%3F.env`)).toBe(true);
    expect(await gitReadFile(repo, ".infraenv", "main", fetcher)).toBeNull();
    expect(seen).toHaveLength(1);
  });
});

describe("gitArchiveLink", () => {
  it("links the commit's archive with a short-lived, read-only token of its own", async () => {
    process.env["GIT_BASE_URL"] = "https://git.example.test";
    const now = Date.now();
    const link = new URL(await gitArchiveLink(repo, A, "run-9"));
    expect(`${link.origin}${link.pathname}`).toBe(
      `https://git.example.test/Acme/web/archive/${A}.tar.gz`,
    );
    const token = link.searchParams.get("token") ?? "";
    expect(
      await verifyGitJobToken(KEY, token, { repositoryId: "repo-1", commit: A }),
    ).toMatchObject({ ok: true, claims: { access: "read", runId: "run-9", commit: A } });
    // A link can be seen by more than the machine it was made for, so the
    // token in it clones nothing and downloads no other commit.
    expect(await verifyGitJobToken(KEY, token, { repositoryId: "repo-1" })).toEqual({
      ok: false,
      reason: "access",
    });
    expect(await verifyGitJobToken(KEY, token, { commit: B })).toEqual({
      ok: false,
      reason: "access",
    });
    expect(await verifyGitJobToken(KEY, token, { commit: A }, now + 11 * 60_000)).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  it("refuses what is not a commit, so nothing else reaches the URL", async () => {
    await expect(gitArchiveLink(repo, "main/../../x", "run-9")).rejects.toThrow();
  });
});
