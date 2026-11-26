import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Env } from "../../env";
import { admissionFor } from "../admission";
import { DEFAULT_RATE_BUDGETS, type RateClass } from "../rate-limit";

/** `wrangler.jsonc` as data: its comments are whole lines, and its lists end in commas. */
const wrangler = (): Record<string, unknown> => {
  const text = readFileSync(
    fileURLToPath(new URL("../../../wrangler.jsonc", import.meta.url)),
    "utf8",
  );
  const bare = text
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n")
    .replace(/,(\s*[}\]])/g, "$1");
  return JSON.parse(bare) as Record<string, unknown>;
};

interface Declared {
  readonly name: string;
  readonly namespace_id: string;
  readonly simple: { readonly limit: number; readonly period: number };
}

/** The binding each class and kind of caller is counted by, as `admissionFor` reads `Env`. */
const BINDINGS: Record<`${RateClass}:${"anonymous" | "signedIn"}`, keyof Env> = {
  "read:anonymous": "RL_READ_ANON",
  "heavy:anonymous": "RL_HEAVY_ANON",
  "write:anonymous": "RL_WRITE_ANON",
  "read:signedIn": "RL_READ_SIGNED_IN",
  "heavy:signedIn": "RL_HEAVY_SIGNED_IN",
  "write:signedIn": "RL_WRITE_SIGNED_IN",
};

describe("the deployed configuration", () => {
  const config = wrangler();

  it("binds a rate limit for every class and kind of caller, with the budgets the code has", () => {
    const declared = config["ratelimits"] as Declared[];
    const byName = new Map(declared.map((each) => [each.name, each]));
    expect(byName.size).toBe(declared.length);
    for (const [slot, name] of Object.entries(BINDINGS)) {
      const [kind, caller] = slot.split(":") as [RateClass, "anonymous" | "signedIn"];
      const budget = DEFAULT_RATE_BUDGETS[kind][caller];
      // Without a binding the count falls back to the code's budget: the two say the same.
      expect(byName.get(name)?.simple, name).toEqual({
        limit: budget.limit,
        period: budget.windowSeconds,
      });
    }
    expect(byName.size).toBe(Object.keys(BINDINGS).length);
    // Two bindings with one namespace would share their counts.
    const namespaces = declared.map((each) => each.namespace_id);
    expect(new Set(namespaces).size).toBe(namespaces.length);
    for (const id of namespaces) expect(id).toMatch(/^[1-9][0-9]*$/);
  });

  it("asks each binding by the caller it is for", async () => {
    const asked: string[] = [];
    const env = Object.fromEntries(
      Object.values(BINDINGS).map((name) => [
        name,
        {
          limit: async ({ key }: { key: string }) => {
            asked.push(`${name} ${key}`);
            return { success: name !== "RL_HEAVY_SIGNED_IN" };
          },
        },
      ]),
    ) as unknown as Env;
    const admission = admissionFor(env);
    const request = (method: string, path: string, headers: Record<string, string> = {}) =>
      new Request(`https://git.example.test${path}`, {
        method,
        headers: { "cf-connecting-ip": "203.0.113.7", ...headers },
      });
    const key = {
      kind: "api-key" as const,
      apiKeyId: "k_1",
      organizationId: "o_1",
      userId: "u_1",
      permissions: [],
    };
    expect(await admission.refuse(request("GET", "/api/repos/acme/infra"))).toBeNull();
    expect(await admission.refuse(request("GET", "/api/repos/acme/infra/blame?path=x"))).toBeNull();
    expect(await admission.refuse(request("POST", "/api/repos/acme/infra/issues"))).toBeNull();
    // A credential is not counted by address; who it is, is counted once that is known.
    const bearer = { authorization: "Bearer something" };
    expect(await admission.refuse(request("GET", "/api/repos/acme/infra", bearer))).toBeNull();
    expect(await admission.admit(request("GET", "/api/repos/acme/infra", bearer), key)).toBeNull();
    expect(
      (await admission.admit(request("GET", "/api/repos/acme/infra/blame?path=x", bearer), key))
        ?.status,
    ).toBe(429);
    expect(
      await admission.admit(request("POST", "/api/repos/acme/infra/issues", bearer), key),
    ).toBeNull();
    expect(asked).toEqual([
      "RL_READ_ANON addr:203.0.113.7",
      "RL_HEAVY_ANON addr:203.0.113.7",
      "RL_WRITE_ANON addr:203.0.113.7",
      "RL_READ_SIGNED_IN key:k_1",
      "RL_HEAVY_SIGNED_IN key:k_1",
      "RL_WRITE_SIGNED_IN key:k_1",
    ]);
  });

  it("keeps query strings out of the logs, and has no second origin", () => {
    // The archive route's job token rides in the query.
    expect(config["observability"]).toMatchObject({ enabled: true, redact_query_string: true });
    expect(config["workers_dev"]).toBe(false);
    expect(config["preview_urls"]).toBe(false);
  });
});
