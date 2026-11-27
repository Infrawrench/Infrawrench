import { describe, expect, it } from "vitest";
import type { Principal } from "../../auth/principal";
import { cacheFailureLimiter } from "../../transport/ssh/rate-limit";
import { CREDENTIAL_FAILURE_LIMITS, makeAdmission, presentsCredential } from "../admission";
import {
  DEFAULT_RATE_BUDGETS,
  bindingLimiter,
  memoryCounterStore,
  windowLimiter,
} from "../rate-limit";

const cache = () => {
  const entries = new Map<string, Response>();
  return {
    match: async (key: string) => entries.get(key)?.clone(),
    put: async (key: string, response: Response) => void entries.set(key, response),
    delete: async (key: string) => entries.delete(key),
  };
};

const admission = (now: () => number = () => 1_000_000) =>
  makeAdmission(
    windowLimiter(memoryCounterStore(1000, now), undefined, now),
    cacheFailureLimiter(cache(), CREDENTIAL_FAILURE_LIMITS, now),
  );

const request = (path: string, headers: Record<string, string> = {}, method = "GET") =>
  new Request(`https://git.example.test${path}`, {
    method,
    headers: { "cf-connecting-ip": "203.0.113.7", ...headers },
  });

describe("admission", () => {
  it("lets a caller without a credential make its budget of heavy reads and no more", async () => {
    const gate = admission();
    const archive = () => request("/acme/infra/archive/" + "a".repeat(40) + ".tar.gz");
    for (let i = 0; i < 30; i++) expect(await gate.refuse(archive())).toBeNull();
    const refused = await gate.refuse(archive());
    expect(refused?.status).toBe(429);
    expect(Number(refused?.headers.get("retry-after"))).toBeGreaterThan(0);
    // A cheap read has its own budget, and another address its own count.
    expect(await gate.refuse(request("/api/repos/acme/infra"))).toBeNull();
    expect(
      await gate.refuse(
        request("/acme/infra/archive/" + "a".repeat(40) + ".tar.gz", {
          "cf-connecting-ip": "203.0.113.8",
        }),
      ),
    ).toBeNull();
  });

  it("counts the image proxy by address even when a session rides along", async () => {
    const gate = admission();
    const image = () =>
      request("/-/image?url=https%3A%2F%2Fexample.com%2Fa.png", {
        cookie: "__Host-iwg-session=abc",
      });
    for (let i = 0; i < DEFAULT_RATE_BUDGETS.read.anonymous.limit; i++) {
      expect(await gate.refuse(image())).toBeNull();
    }
    expect((await gate.refuse(image()))?.status).toBe(429);
    // A page read with the same cookie is the signed-in person's, counted once they are known.
    expect(
      await gate.refuse(request("/api/user", { cookie: "__Host-iwg-session=abc" })),
    ).toBeNull();
  });

  it("counts an IPv6 caller by its /64", async () => {
    const gate = admission();
    const clone = (host: string) =>
      request(
        "/acme/infra.git/git-upload-pack",
        { "cf-connecting-ip": `2001:db8:1:2::${host}` },
        "POST",
      );
    for (let i = 0; i < 30; i++) expect(await gate.refuse(clone(i.toString(16)))).toBeNull();
    expect((await gate.refuse(clone("ffff")))?.status).toBe(429);
  });

  it("counts a caller who authenticated by who they are, against the signed-in budget", async () => {
    const gate = admission();
    const ada: Principal = {
      kind: "user",
      userId: "ada",
      via: "token",
      scopes: ["repo:write"],
      credentialId: "pat_1",
    };
    const session: Principal = { ...ada, via: "session", scopes: null, credentialId: null };
    const grace: Principal = { ...ada, userId: "grace" };
    const compare = (address: string) =>
      request(
        "/api/repos/acme/infra/compare/diff?base=a&head=b",
        { "cf-connecting-ip": address, authorization: "Bearer a-token" },
        "GET",
      );
    const budget = DEFAULT_RATE_BUDGETS.heavy.signedIn.limit;
    // From any address, and through either credential: one person, one budget.
    for (let i = 0; i < budget; i++) {
      const who = i % 2 === 0 ? ada : session;
      expect(await gate.admit(compare(`203.0.113.${i % 250}`), who)).toBeNull();
    }
    const refused = await gate.admit(compare("203.0.113.7"), ada);
    expect(refused?.status).toBe(429);
    expect(Number(refused?.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await gate.admit(compare("198.51.100.1"), session))?.status).toBe(429);
    // Someone else at the same address is not held to it, nor is Ada's cheap reading.
    expect(await gate.admit(compare("203.0.113.7"), grace)).toBeNull();
    expect(await gate.admit(request("/api/repos/acme/infra"), ada)).toBeNull();
    // An archive, a blame, a clone and a search come out of the same budget.
    for (const [method, path] of [
      ["GET", `/acme/infra/archive/${"a".repeat(40)}.tar.gz`],
      ["GET", "/api/repos/acme/infra/blame?path=main.tf"],
      ["POST", "/acme/infra.git/git-upload-pack"],
      ["GET", "/api/explore/repos?q=terraform"],
    ] as const) {
      expect((await gate.admit(request(path, {}, method), ada))?.status, path).toBe(429);
    }
    // Writes have their own.
    const merge = () => request("/api/repos/acme/infra/branches/feature%2Fa/merge", {}, "POST");
    for (let i = 0; i < DEFAULT_RATE_BUDGETS.write.signedIn.limit; i++) {
      expect(await gate.admit(merge(), ada)).toBeNull();
    }
    expect((await gate.admit(merge(), ada))?.status).toBe(429);
    // Nobody is counted here for being nobody: that was done by address, before.
    for (let i = 0; i < 100; i++) {
      expect(await gate.admit(compare("203.0.113.9"), { kind: "anonymous" })).toBeNull();
    }
  });

  it("asks the signed-in bindings by principal when the Worker has them", async () => {
    const asked: string[] = [];
    const binding = (name: string, allow: boolean) => ({
      limit: async ({ key }: { key: string }) => {
        asked.push(`${name} ${key}`);
        return { success: allow };
      },
    });
    const gate = makeAdmission(
      bindingLimiter(
        {
          "heavy:signedIn": binding("heavy", false),
          "write:signedIn": binding("write", true),
          "heavy:anonymous": binding("anonymous", true),
        },
        60,
      ),
      cacheFailureLimiter(cache(), CREDENTIAL_FAILURE_LIMITS),
    );
    const key: Principal = {
      kind: "api-key",
      apiKeyId: "k_1",
      organizationId: "o_1",
      userId: "u_1",
      permissions: ["git:write"],
    };
    const blame = request("/api/repos/acme/infra/blame?path=x", { authorization: "Bearer k" });
    expect((await gate.admit(blame, key))?.status).toBe(429);
    expect(
      await gate.admit(request("/acme/infra.git/git-receive-pack", {}, "POST"), key),
    ).toBeNull();
    // No binding for cheap reads here, and no fallback: let through.
    expect(await gate.admit(request("/api/repos/acme/infra"), key)).toBeNull();
    expect(asked).toEqual(["heavy key:k_1", "write key:k_1"]);
  });

  it("does not count a caller who brings a credential against the anonymous budget", async () => {
    const gate = admission();
    const signedIn = () =>
      request("/api/repos/acme/infra/compare/a...b", { authorization: "Bearer placeholder" });
    for (let i = 0; i < 100; i++) expect(await gate.refuse(signedIn())).toBeNull();
  });

  it("refuses an address whose credentials keep being refused, until the window ends", async () => {
    let at = 1_000_000;
    const gate = admission(() => at);
    const guess = () =>
      request("/acme/infra.git/info/refs?service=git-upload-pack", {
        authorization: "Basic placeholder",
      });
    const unauthorized = () => new Response(null, { status: 401 });
    for (let i = 0; i < CREDENTIAL_FAILURE_LIMITS.maxFailures; i++) {
      expect(await gate.refuse(guess())).toBeNull();
      await gate.record(guess(), unauthorized());
    }
    expect((await gate.refuse(guess()))?.status).toBe(429);
    // Without a credential the same address still reads what is public.
    expect(await gate.refuse(request("/api/repos/acme/infra"))).toBeNull();
    at += CREDENTIAL_FAILURE_LIMITS.windowSeconds * 1000 + 1;
    expect(await gate.refuse(guess())).toBeNull();
  });

  it("counts only a 401 to a request that brought a credential", async () => {
    const gate = admission();
    const anonymous = request("/acme/infra.git/info/refs?service=git-upload-pack");
    const withToken = request("/api/user", { authorization: "Bearer placeholder" });
    for (let i = 0; i < 200; i++) {
      await gate.record(anonymous, new Response(null, { status: 401 }));
      await gate.record(withToken, new Response(null, { status: 404 }));
      await gate.record(withToken, new Response(null, { status: 200 }));
    }
    expect(await gate.refuse(withToken)).toBeNull();
  });

  it("knows what a credential looks like", () => {
    expect(presentsCredential(request("/x"))).toBe(false);
    expect(presentsCredential(request("/x?token=placeholder"))).toBe(true);
    expect(presentsCredential(request("/x", { cookie: "a=b; __Host-iwg-session=v1.x" }))).toBe(
      true,
    );
    expect(presentsCredential(request("/x", { cookie: "other=1" }))).toBe(false);
  });
});
