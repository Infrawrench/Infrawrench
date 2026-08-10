import { describe, expect, it } from "vitest";

import { fetchOrgPermissions, hasPermission } from "../permissions";
import type { CloudFetch } from "../fetch";

/**
 * These cases pin the same rule server-core's catalog implements. The two
 * copies exist because mobile cannot load the server package (see
 * `permissions.ts`); if one changes, the other has to.
 */
describe("hasPermission", () => {
  it("matches an exact grant", () => {
    expect(hasPermission(["workflows:approve"], "workflows:approve")).toBe(true);
    expect(hasPermission(["workflows:read"], "workflows:approve")).toBe(false);
  });

  it("honours a bare wildcard", () => {
    expect(hasPermission(["*"], "workflows:approve")).toBe(true);
  });

  it("honours a segment wildcard of the same arity", () => {
    expect(hasPermission(["workflows:*"], "workflows:approve")).toBe(true);
    expect(hasPermission(["*:approve"], "workflows:approve")).toBe(true);
    // `team:*` is two segments; `team:role:write` is three.
    expect(hasPermission(["team:*"], "team:role:write")).toBe(false);
    expect(hasPermission(["team:*:*"], "team:role:write")).toBe(true);
  });

  it("is false for an empty or missing grant list", () => {
    expect(hasPermission([], "workflows:read")).toBe(false);
    expect(hasPermission(undefined, "workflows:read")).toBe(false);
  });
});

describe("fetchOrgPermissions", () => {
  it("reads /team/me and degrades to no permissions on an empty body", async () => {
    const paths: string[] = [];
    const api = (reply: unknown): CloudFetch => ({
      baseUrl: "https://example.test",
      org: <T>(_orgId: string, path: string) => {
        paths.push(path);
        return Promise.resolve(reply as T);
      },
      api: <T>() => Promise.resolve(null as T),
      raw: () => Promise.resolve(new Response(null)),
    });

    const me = await fetchOrgPermissions(api({ permissions: ["workflows:approve"] }), "org1");
    expect(paths[0]).toBe("/team/me");
    expect(hasPermission(me.permissions, "workflows:approve")).toBe(true);

    const none = await fetchOrgPermissions(api(null), "org1");
    expect(none.permissions).toEqual([]);
  });
});
