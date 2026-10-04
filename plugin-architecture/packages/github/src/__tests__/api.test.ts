import { describe, expect, it } from "vitest";
import {
  billingBase,
  ghFetch,
  GitHubApiError,
  ownerBase,
  parseOwner,
  resolveHost,
} from "../api.js";
import { ctxWith, makeHttp } from "./helpers.js";

describe("resolveHost", () => {
  it("defaults to github.com", () => {
    for (const raw of [undefined, "", "github.com", "https://github.com/", "api.github.com"]) {
      expect(resolveHost(raw).apiUrl).toBe("https://api.github.com");
    }
  });

  it("maps every spelling of a GHE.com subdomain to its API host", () => {
    for (const raw of [
      "octocorp",
      "octocorp.ghe.com",
      "https://octocorp.ghe.com",
      "api.octocorp.ghe.com",
    ]) {
      const host = resolveHost(raw);
      expect(host.apiUrl).toBe("https://api.octocorp.ghe.com");
      expect(host.graphqlUrl).toBe("https://api.octocorp.ghe.com/graphql");
      expect(host.webUrl).toBe("https://octocorp.ghe.com");
      expect(host.dataResidency).toBe(true);
    }
  });

  it("refuses any other host rather than sending the token there", () => {
    expect(() => resolveHost("github.example.com")).toThrow(/not github.com/);
    expect(() => resolveHost("169.254.169.254")).toThrow();
  });
});

describe("parseOwner", () => {
  it("reads picker ids and bare names", () => {
    expect(parseOwner("org:acme")).toEqual({ kind: "org", slug: "acme" });
    expect(parseOwner("enterprise:acme-corp")).toEqual({ kind: "enterprise", slug: "acme-corp" });
    expect(parseOwner("acme")).toEqual({ kind: "org", slug: "acme" });
    expect(parseOwner("")).toBeUndefined();
  });

  it("builds the billing and owner roots per kind", () => {
    expect(billingBase({ kind: "org", slug: "acme" })).toBe("/organizations/acme/settings/billing");
    expect(billingBase({ kind: "enterprise", slug: "big" })).toBe(
      "/enterprises/big/settings/billing",
    );
    expect(ownerBase({ kind: "org", slug: "acme" })).toBe("/orgs/acme");
  });
});

describe("ghFetch", () => {
  it("sends the token, API version and a user agent", async () => {
    const { http, calls } = makeHttp(() => ({ body: { ok: true } }));
    await ghFetch(ctxWith(http), "/user");
    expect(calls[0]!.headers["Authorization"]).toBe("Bearer tok");
    expect(calls[0]!.headers["X-GitHub-Api-Version"]).toBe("2022-11-28");
    expect(calls[0]!.headers["User-Agent"]).toBe("Infrawrench");
  });

  it("surfaces GitHub's message with the status", async () => {
    const { http } = makeHttp(() => ({
      status: 403,
      body: { message: "Resource not accessible by personal access token" },
    }));
    const err = await ghFetch(ctxWith(http), "/orgs/x/codespaces").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitHubApiError);
    expect((err as GitHubApiError).status).toBe(403);
    expect((err as Error).message).toContain("Resource not accessible by personal access token");
  });
});
