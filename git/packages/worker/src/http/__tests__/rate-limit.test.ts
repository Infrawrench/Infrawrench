import { describe, expect, it } from "vitest";
import {
  type CacheLike,
  DEFAULT_RATE_BUDGETS,
  type RateBudgets,
  type RateLimitBinding,
  bindingLimiter,
  cacheCounterStore,
  classify,
  memoryCounterStore,
  refusedCredential,
  subjectOf,
  tooManyRequests,
  windowLimiter,
} from "../rate-limit";

const at = (path: string) => new URL(`https://git.example.test${path}`);

describe("classify", () => {
  it("tells cheap reads, heavy reads and writes apart by method and path", () => {
    const repo = "/api/repos/acme/infra";
    expect(classify("GET", at(`${repo}/refs`))).toBe("read");
    expect(classify("GET", at(`${repo}/blob?path=README.md`))).toBe("read");
    expect(classify("GET", at(`${repo}/commits`))).toBe("read");
    expect(classify("GET", at(`${repo}/tree?lastCommits=false`))).toBe("read");
    expect(classify("GET", at(`${repo}/tree`))).toBe("heavy");
    expect(classify("GET", at(`${repo}/tree/last-commits`))).toBe("heavy");
    expect(classify("GET", at(`${repo}/commits?path=main.tf`))).toBe("heavy");
    expect(classify("GET", at(`${repo}/commits?author=ada`))).toBe("heavy");
    expect(classify("GET", at(`${repo}/commits/abc123`))).toBe("heavy");
    expect(classify("GET", at(`${repo}/commits/abc123/diff`))).toBe("heavy");
    expect(classify("GET", at(`${repo}/compare?base=a&head=b`))).toBe("heavy");
    expect(classify("GET", at(`${repo}/compare/diff?base=a&head=b`))).toBe("heavy");
    expect(classify("GET", at(`${repo}/blame?path=x`))).toBe("heavy");
    expect(classify("GET", at(`${repo}/pulls/7/files`))).toBe("heavy");
    expect(classify("GET", at(`${repo}/pulls/7/mergeability`))).toBe("heavy");
    expect(classify("GET", at(`${repo}/pulls/7`))).toBe("read");
    expect(classify("POST", at(`${repo}/pulls/7/merge`))).toBe("write");
    expect(classify("DELETE", at(`${repo}/branches`))).toBe("write");
    expect(classify("GET", at("/acme/infra/archive/0123.tar.gz"))).toBe("heavy");
    expect(classify("GET", at("/acme/infra/raw/0123/main.tf"))).toBe("heavy");
    expect(classify("GET", at("/acme/infra.git/info/refs?service=git-upload-pack"))).toBe("read");
    expect(classify("POST", at("/acme/infra.git/git-upload-pack"))).toBe("heavy");
    expect(classify("GET", at("/acme/infra.git/info/refs?service=git-receive-pack"))).toBe("write");
    expect(classify("POST", at("/acme/infra.git/git-receive-pack"))).toBe("write");
    expect(classify("GET", at("/acme/infra"))).toBe("read");
  });
});

describe("subjectOf", () => {
  const from = (address: string | null) =>
    new Request("https://git.example.test/", {
      headers: address === null ? {} : { "CF-Connecting-IP": address },
    });

  it("counts a signed-in person by id and anyone else by address, an IPv6 one by its /64", () => {
    expect(subjectOf(from("203.0.113.7"), "user-1")).toEqual({
      key: "user:user-1",
      anonymous: false,
    });
    expect(subjectOf(from("203.0.113.7"), null)).toEqual({
      key: "addr:203.0.113.7",
      anonymous: true,
    });
    expect(subjectOf(from("2001:db8:1:2:aaaa::1"), null).key).toBe("addr:2001:db8:1:2::/64");
    expect(subjectOf(from("2001:db8:1:2:bbbb::9"), null).key).toBe("addr:2001:db8:1:2::/64");
    expect(subjectOf(from(null), null)).toEqual({ key: "addr:unknown", anonymous: true });
  });
});

describe("windowLimiter", () => {
  const budgets: RateBudgets = {
    ...DEFAULT_RATE_BUDGETS,
    heavy: {
      anonymous: { limit: 3, windowSeconds: 60 },
      signedIn: { limit: 5, windowSeconds: 60 },
    },
  };
  const anonymous = { key: "addr:203.0.113.7", anonymous: true };
  const person = { key: "user:user-1", anonymous: false };

  it("refuses past the budget until the window ends, with Retry-After to its end", async () => {
    let now = 60_000 * 1000 + 15_000;
    const limiter = windowLimiter(
      memoryCounterStore(100, () => now),
      budgets,
      () => now,
    );
    const decisions = [];
    for (let i = 0; i < 4; i++) decisions.push(await limiter.take("heavy", anonymous));
    expect(decisions.map((decision) => decision.allowed)).toEqual([true, true, true, false]);
    expect(decisions[3]!.retryAfterSeconds).toBe(45);
    // Other classes and other subjects have budgets of their own.
    expect((await limiter.take("read", anonymous)).allowed).toBe(true);
    expect((await limiter.take("heavy", { ...anonymous, key: "addr:198.51.100.1" })).allowed).toBe(
      true,
    );
    // A signed-in person has the larger budget.
    for (let i = 0; i < 5; i++) expect((await limiter.take("heavy", person)).allowed).toBe(true);
    expect((await limiter.take("heavy", person)).allowed).toBe(false);
    now += 45_000;
    expect((await limiter.take("heavy", anonymous)).allowed).toBe(true);
  });

  it("keeps at most maxKeys counters in memory, the oldest forgotten first", async () => {
    const now = 1_000_000;
    const store = memoryCounterStore(2, () => now);
    expect(await store.add("a", 60)).toBe(1);
    expect(await store.add("a", 60)).toBe(2);
    await store.add("b", 60);
    await store.add("c", 60);
    // "a" was the oldest of three, so it starts again.
    expect(await store.add("a", 60)).toBe(1);
    expect(await store.add("c", 60)).toBe(2);
  });

  it("counts in the Cache API, and a cache that fails counts nothing", async () => {
    const entries = new Map<string, string>();
    const cache: CacheLike = {
      match: async (key) => (entries.has(key) ? new Response(entries.get(key)) : undefined),
      put: async (key, response) => {
        entries.set(key, await response.text());
      },
    };
    const store = cacheCounterStore(cache);
    expect(await store.add("k", 60)).toBe(1);
    expect(await store.add("k", 60)).toBe(2);
    const broken = cacheCounterStore({
      match: async () => {
        throw new Error("no cache");
      },
      put: async () => {
        throw new Error("no cache");
      },
    });
    expect(await broken.add("k", 60)).toBe(1);
    expect(await broken.add("k", 60)).toBe(1);
  });
});

describe("bindingLimiter", () => {
  it("asks the binding for the class and kind of caller, and falls back without one", async () => {
    const asked: string[] = [];
    const binding = (allow: boolean): RateLimitBinding => ({
      limit: async ({ key }) => {
        asked.push(key);
        return { success: allow };
      },
    });
    const fallback = windowLimiter(memoryCounterStore(), {
      ...DEFAULT_RATE_BUDGETS,
      write: {
        anonymous: { limit: 0, windowSeconds: 60 },
        signedIn: { limit: 0, windowSeconds: 60 },
      },
    });
    const limiter = bindingLimiter(
      { "heavy:anonymous": binding(false), "heavy:signedIn": binding(true) },
      60,
      fallback,
    );
    expect(await limiter.take("heavy", { key: "addr:a", anonymous: true })).toEqual({
      allowed: false,
      retryAfterSeconds: 60,
    });
    expect((await limiter.take("heavy", { key: "user:u", anonymous: false })).allowed).toBe(true);
    expect(asked).toEqual(["addr:a", "user:u"]);
    expect((await limiter.take("write", { key: "user:u", anonymous: false })).allowed).toBe(false);
    expect(
      (await bindingLimiter({}).take("read", { key: "addr:a", anonymous: true })).allowed,
    ).toBe(true);
  });
});

describe("answers", () => {
  it("says 429 with Retry-After", async () => {
    const response = tooManyRequests({ allowed: false, retryAfterSeconds: 12 });
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("12");
    expect(await response.text()).toContain("Too many requests");
  });

  it("counts a 401 against the address only when the request brought a credential", () => {
    const refused = new Response(null, { status: 401 });
    const plain = new Request("https://git.example.test/acme/infra.git/info/refs");
    const basic = new Request(plain.url, { headers: { Authorization: "Basic eDp5" } });
    const cookie = new Request(plain.url, { headers: { Cookie: "a=b; __Host-iwg-session=x" } });
    const token = new Request("https://git.example.test/acme/infra/archive/0.tar.gz?token=x");
    expect(refusedCredential(plain, refused)).toBe(false);
    expect(refusedCredential(basic, refused)).toBe(true);
    expect(refusedCredential(cookie, refused)).toBe(true);
    expect(refusedCredential(token, refused)).toBe(true);
    expect(refusedCredential(basic, new Response(null, { status: 404 }))).toBe(false);
  });
});
