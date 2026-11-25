import { describe, expect, it } from "vitest";
import type { RepoAccess } from "../../auth/access";
import { ANONYMOUS, type Principal } from "../../auth/principal";
import type { Env } from "../../env";
import { type GitDirectory, parseRepositoryPath } from "../directory";
import { gitHttp, matchGitRoute } from "../http/routes";
import { parseCommand, unquote } from "../ssh/command";
import { type CacheLike, addressKey, cacheFailureLimiter } from "../ssh/rate-limit";

const SHA = "a".repeat(40);

describe("repository paths", () => {
  it("takes owner/repo with or without .git and a leading slash", () => {
    expect(parseRepositoryPath("alice/demo.git")).toEqual({ owner: "alice", name: "demo" });
    expect(parseRepositoryPath("/alice/demo")).toEqual({ owner: "alice", name: "demo" });
    expect(parseRepositoryPath("Org-1/a.b_c.GIT")).toEqual({ owner: "Org-1", name: "a.b_c" });
  });

  it("refuses everything else", () => {
    for (const path of [
      "demo.git",
      "a/b/c",
      "~alice/demo",
      "../etc/passwd",
      "alice/..",
      "alice/.git",
      "alice/de mo",
      "alice/demo;rm",
      "alice/",
      "/",
      "",
    ]) {
      expect(parseRepositoryPath(path), path).toBeNull();
    }
  });
});

describe("the SSH command", () => {
  it("is one of git's two services with a quoted path", () => {
    expect(parseCommand("git-upload-pack 'alice/demo.git'")).toEqual({
      kind: "git",
      service: "git-upload-pack",
      owner: "alice",
      name: "demo",
    });
    expect(parseCommand("git-receive-pack '/alice/demo'")).toMatchObject({
      kind: "git",
      service: "git-receive-pack",
    });
    expect(parseCommand("git upload-pack alice/demo.git")).toMatchObject({ kind: "git" });
  });

  it("is never anything else", () => {
    const refused = (command: string): string => {
      const parsed = parseCommand(command);
      expect(parsed.kind, command).toBe("unsupported");
      return parsed.kind === "unsupported" ? parsed.reason : "";
    };
    expect(refused("git-upload-pack '~alice/demo.git'")).toMatch(/Home directory/);
    expect(refused("git-upload-pack '/~/demo.git'")).toMatch(/Home directory/);
    expect(refused("git-upload-pack 'alice/demo.git'; cat /etc/passwd")).toMatch(/Invalid/);
    expect(refused("git-upload-pack 'alice/demo.git' extra")).toMatch(/Invalid/);
    expect(refused("git-upload-pack $(id)/demo")).toMatch(/Invalid/);
    expect(refused("git-upload-pack 'a/b/c'")).toMatch(/Invalid/);
    expect(refused("git-upload-archive 'alice/demo.git'")).toMatch(/archive/);
    expect(refused("ls -la")).toMatch(/Only git/);
    expect(refused("")).toMatch(/Only git/);
  });

  it("unquotes the way git quotes", () => {
    expect(unquote("'a b'")).toBe("a b");
    expect(unquote("'it'\\''s'")).toBe("it's");
    expect(unquote("'wow'\\!''")).toBe("wow!");
    expect(unquote("'open")).toBeNull();
    expect(unquote("'a'b")).toBeNull();
    expect(unquote("a b")).toBeNull();
  });
});

describe("failed SSH authentication", () => {
  const memoryCache = (): CacheLike & { size(): number } => {
    const entries = new Map<string, string>();
    return {
      match: async (key) => {
        const body = entries.get(key);
        return body === undefined ? undefined : new Response(body);
      },
      put: async (key, response) => void entries.set(key, await response.text()),
      delete: async (key) => entries.delete(key),
      size: () => entries.size,
    };
  };

  it("blocks an address after too many failures, until the window passes", async () => {
    let now = 1_000_000;
    const limiter = cacheFailureLimiter(
      memoryCache(),
      { maxFailures: 3, windowSeconds: 60 },
      () => now,
    );
    for (let i = 0; i < 3; i++) {
      expect(await limiter.blocked("203.0.113.7")).toBe(false);
      await limiter.failed("203.0.113.7");
    }
    expect(await limiter.blocked("203.0.113.7")).toBe(true);
    expect(await limiter.blocked("203.0.113.8")).toBe(false);
    now += 61_000;
    expect(await limiter.blocked("203.0.113.7")).toBe(false);
  });

  it("never blocks where there is no cache", async () => {
    const limiter = cacheFailureLimiter(null, { maxFailures: 1, windowSeconds: 60 });
    await limiter.failed("203.0.113.7");
    expect(await limiter.blocked("203.0.113.7")).toBe(false);
  });

  it("keys by address, without the port", () => {
    expect(addressKey("203.0.113.7:51234")).toBe("203.0.113.7");
    expect(addressKey("[2001:db8::1]:51234")).toBe("2001:db8::1");
    expect(addressKey("2001:db8::1")).toBe("2001:db8::1");
    expect(addressKey(undefined)).toBeNull();
  });
});

describe("git routes", () => {
  it("matches the smart HTTP routes and the two CI routes, and nothing else", () => {
    expect(matchGitRoute("GET", "/alice/demo.git/info/refs")).toEqual({
      kind: "info-refs",
      owner: "alice",
      name: "demo",
    });
    expect(matchGitRoute("POST", "/alice/demo/git-upload-pack")).toMatchObject({
      kind: "service",
      service: "git-upload-pack",
    });
    expect(matchGitRoute("POST", "/alice/demo.git/git-receive-pack")).toMatchObject({
      service: "git-receive-pack",
    });
    expect(matchGitRoute("GET", `/alice/demo/raw/${SHA}/src/a%20b.txt`)).toEqual({
      kind: "raw",
      owner: "alice",
      name: "demo",
      sha: SHA,
      path: "src/a b.txt",
    });
    expect(matchGitRoute("GET", `/alice/demo/archive/${SHA}.tar.gz`)).toMatchObject({
      kind: "archive",
      sha: SHA,
    });
    for (const [method, path] of [
      ["GET", "/alice/demo"],
      ["GET", "/alice/demo/tree/main"],
      ["GET", "/alice/demo/raw/main/README.md"],
      ["GET", `/alice/demo/archive/${SHA}.zip`],
      ["GET", "/alice/demo/git-upload-pack"],
      ["POST", "/alice/demo/info/refs"],
      ["POST", "/alice/demo/git-upload-archive"],
      ["GET", "/api/v1/repos/alice/demo"],
      ["GET", `/alice/demo/raw/${SHA}/%E0%A4%A`],
    ] as const) {
      expect(matchGitRoute(method, path), `${method} ${path}`).toBeNull();
    }
  });

  const directory = (
    repos: Record<string, { access: RepoAccess; archived?: boolean }>,
    principal: Principal | "refused",
  ): GitDirectory => ({
    authenticate: async () =>
      principal === "refused"
        ? { principal: ANONYMOUS, refused: true }
        : { principal, refused: false },
    authenticateArchiveToken: async () => null,
    authenticateKey: async () => null,
    describe: async () => "there",
    resolveRepository: async (owner, name) => {
      const found = repos[`${owner}/${name}`];
      return found
        ? {
            id: "repo-1",
            owner,
            name,
            archived: found.archived ?? false,
            access: found.access,
            pushPolicy: async () => ({ rules: [], userId: null, admin: false }),
          }
        : null;
    },
  });
  // No route below gets as far as the Durable Object.
  const env = {} as Pick<Env, "REPO">;
  const user: Principal = {
    kind: "user",
    userId: "u",
    via: "token",
    scopes: [],
    credentialId: "t",
  };
  const get = (path: string, dir: GitDirectory): Promise<Response | null> =>
    gitHttp(new Request(`https://git.example${path}`), env, dir);

  it("asks anyone without credentials to sign in, whether or not the repository exists", async () => {
    const dir = directory({ "alice/private": { access: "none" } }, ANONYMOUS);
    for (const path of ["/alice/private.git", "/alice/missing.git"]) {
      const response = await get(`${path}/info/refs?service=git-upload-pack`, dir);
      expect(response?.status).toBe(401);
      expect(response?.headers.get("www-authenticate")).toContain(
        'Basic realm="git.infrawrench.com"',
      );
    }
  });

  it("refuses a bad credential before looking at the repository", async () => {
    const response = await get(
      "/alice/public.git/info/refs?service=git-upload-pack",
      directory({ "alice/public": { access: "read" } }, "refused"),
    );
    expect(response?.status).toBe(401);
  });

  it("hides a repository from someone who may not read it, and explains a refused push", async () => {
    const dir = directory(
      { "alice/private": { access: "none" }, "alice/readable": { access: "read" } },
      user,
    );
    expect((await get("/alice/private.git/info/refs?service=git-upload-pack", dir))?.status).toBe(
      404,
    );
    expect((await get("/alice/missing.git/info/refs?service=git-upload-pack", dir))?.status).toBe(
      404,
    );
    const push = await get("/alice/readable.git/info/refs?service=git-receive-pack", dir);
    expect(push?.status).toBe(403);
    expect(await push?.text()).toBe("You do not have permission to push to alice/readable.\n");
    expect(push?.headers.get("content-type")).toContain("text/plain");
    const archived = await get(
      "/alice/old.git/info/refs?service=git-receive-pack",
      directory({ "alice/old": { access: "read", archived: true } }, user),
    );
    expect(await archived?.text()).toBe("alice/old is archived and read-only.\n");
  });

  it("does not serve the dumb protocol, and leaves other paths to the router", async () => {
    const dir = directory({ "alice/public": { access: "read" } }, ANONYMOUS);
    expect((await get("/alice/public.git/info/refs", dir))?.status).toBe(403);
    expect(await get("/alice/public", dir)).toBeNull();
    expect(await get("/", dir)).toBeNull();
  });

  it("takes an archive token only from the archive route's query", async () => {
    const dir = directory({ "alice/private": { access: "none" } }, ANONYMOUS);
    const response = await get(`/alice/private/archive/${SHA}.tar.gz?token=iwj_forged`, dir);
    expect(response?.status).toBe(401);
  });
});
