import { describe, expect, it } from "vitest";

import { lendRedis } from "../ci-credential.js";

describe("lendRedis", () => {
  it("lends the URL and its password where redis-cli reads them", () => {
    const m = lendRedis("rediss://default:p%40ss@cache.example.com:6380/0");
    expect(m.env).toEqual({
      REDIS_URL: "rediss://default:p%40ss@cache.example.com:6380/0",
      REDISCLI_AUTH: "p@ss",
    });
    expect(m.files).toEqual([]);
  });

  it("names an ACL user, which redis-cli needs with --user", () => {
    const m = lendRedis("redis://deployer:s%3Acret@cache:6379");
    expect(m.env).toEqual({
      REDIS_URL: "redis://deployer:s%3Acret@cache:6379",
      REDISCLI_AUTH: "s:cret",
      REDIS_USERNAME: [{ text: "deployer" }],
    });
  });

  it("lends a URL without a password as it is", () => {
    expect(lendRedis("redis://cache:6379").env).toEqual({ REDIS_URL: "redis://cache:6379" });
  });
});
