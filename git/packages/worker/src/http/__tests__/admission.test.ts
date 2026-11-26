import { describe, expect, it } from "vitest";
import { cacheFailureLimiter } from "../../transport/ssh/rate-limit";
import { CREDENTIAL_FAILURE_LIMITS, makeAdmission, presentsCredential } from "../admission";
import { memoryCounterStore, windowLimiter } from "../rate-limit";

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
