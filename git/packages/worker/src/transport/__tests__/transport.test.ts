import { describe, expect, it } from "vitest";
import type { RepoAccess } from "../../auth/access";
import { ANONYMOUS, type Principal } from "../../auth/principal";
import type { Env } from "../../env";
import { type GitDirectory, parseRepositoryPath } from "../directory";
import { contentDisposition, rawHeaders } from "../http/raw-headers";
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

  it("answers a missing and a private repository the same way, to anyone who cannot read", async () => {
    for (const principal of [ANONYMOUS, user]) {
      const dir = directory({ "alice/private": { access: "none" } }, principal);
      const answers = await Promise.all(
        ["/alice/private.git", "/alice/missing.git"].map(async (path) => {
          const response = (await get(`${path}/info/refs?service=git-upload-pack`, dir))!;
          return {
            status: response.status,
            body: await response.text(),
            headers: [...response.headers],
          };
        }),
      );
      expect(answers[0]).toEqual(answers[1]);
    }
  });

  it("never lets the session cookie authenticate smart HTTP", async () => {
    const seen: Array<string | null> = [];
    const dir: GitDirectory = {
      ...directory({ "alice/public": { access: "read" } }, ANONYMOUS),
      authenticate: async (request) => {
        seen.push(request.headers.get("cookie"));
        return { principal: ANONYMOUS, refused: false };
      },
    };
    const headers = { cookie: "__Host-iwg-session=v1.a.b.c" };
    await gitHttp(
      new Request("https://git.example/alice/private.git/info/refs?service=git-upload-pack", {
        headers,
      }),
      env,
      dir,
    );
    expect(seen).toEqual([null]);
  });

  it("refuses a body in an encoding it does not take", async () => {
    const dir = directory({ "alice/public": { access: "write" } }, user);
    for (const encoding of ["br", "gzip, gzip", "deflate"]) {
      const response = await gitHttp(
        new Request("https://git.example/alice/public.git/git-upload-pack", {
          method: "POST",
          body: "0000",
          headers: { "content-encoding": encoding },
        }),
        env,
        dir,
      );
      expect(response?.status, encoding).toBe(415);
    }
  });

  it("serves a repository's files so that none can run on this origin", () => {
    const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);
    const page = rawHeaders("site/index.html", bytes("<script>alert(1)</script>"), false);
    expect(page.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(page.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    expect(page.get("x-content-type-options")).toBe("nosniff");
    expect(page.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(page.get("cache-control")).toBe("private, no-store");
    const svg = rawHeaders("logo.svg", bytes("<svg onload='x()'/>"), false);
    expect(svg.get("content-type")).toBe("image/svg+xml");
    expect(svg.get("content-disposition")).toMatch(/^attachment;/);
    expect(
      rawHeaders("a.png", new Uint8Array([0x89, 0]), false).get("content-disposition"),
    ).toMatch(/^inline;/);
    expect(rawHeaders("a.png", new Uint8Array([0x89, 0]), true).get("content-disposition")).toMatch(
      /^attachment;/,
    );
    expect(rawHeaders("blob", new Uint8Array([0, 1, 2]), false).get("content-type")).toBe(
      "application/octet-stream",
    );
    // A file name can neither end the header nor add another.
    const named = contentDisposition("attachment", 'a"b\r\nSet-Cookie: x=1;é.txt');
    expect(named).not.toMatch(/[\r\n]/);
    expect(named).toBe(
      "attachment; filename=\"a_b__Set-Cookie: x=1__.txt\"; filename*=UTF-8''a%22b%0D%0ASet-Cookie%3A%20x%3D1%3B%C3%A9.txt",
    );
  });

  it("counts every route against whoever authenticated, before it looks anything up", async () => {
    const resolved: string[] = [];
    const dir: GitDirectory = {
      ...directory({ "alice/demo": { access: "write" } }, user),
      resolveRepository: async (owner, name) => {
        resolved.push(`${owner}/${name}`);
        return null;
      },
    };
    const counted: Array<{ path: string; principal: Principal }> = [];
    const tooMany = () => new Response("Too many requests.\n", { status: 429 });
    const call = (method: string, path: string, refuse: boolean) =>
      gitHttp(new Request(`https://git.example${path}`, { method }), env, dir, async (r, p) => {
        counted.push({ path: new URL(r.url).pathname, principal: p });
        return refuse ? tooMany() : null;
      });
    const routes = [
      ["GET", "/alice/demo.git/info/refs?service=git-upload-pack"],
      ["POST", "/alice/demo.git/git-upload-pack"],
      ["POST", "/alice/demo.git/git-receive-pack"],
      ["GET", `/alice/demo/raw/${SHA}/README.md`],
      ["GET", `/alice/demo/archive/${SHA}.tar.gz`],
    ] as const;
    for (const [method, path] of routes) {
      expect((await call(method, path, true))?.status, path).toBe(429);
    }
    expect(counted.map((each) => each.principal)).toEqual(routes.map(() => user));
    // Refused before the repository was asked for: a caller past its budget costs nothing more.
    expect(resolved).toEqual([]);
    // Let in, the request goes on to the repository.
    await call("GET", "/alice/demo.git/info/refs?service=git-upload-pack", false);
    expect(resolved).toEqual(["alice/demo"]);
    // A refused credential is a 401 and is never counted as anyone.
    counted.length = 0;
    const refused = await gitHttp(
      new Request("https://git.example/alice/demo.git/info/refs?service=git-upload-pack"),
      env,
      directory({}, "refused"),
      async (r, p) => {
        counted.push({ path: new URL(r.url).pathname, principal: p });
        return tooMany();
      },
    );
    expect(refused?.status).toBe(401);
    expect(counted).toEqual([]);
  });

  it("takes an archive token only from the archive route's query", async () => {
    const dir = directory({ "alice/private": { access: "none" } }, ANONYMOUS);
    const response = await get(`/alice/private/archive/${SHA}.tar.gz?token=iwj_forged`, dir);
    expect(response?.status).toBe(401);
  });
});
