/**
 * The Create API Key dialog's scope list, against the server that enforces it.
 *
 * A key's effective permissions are its stored scopes intersected with its
 * owner's current role (`auth/effective-permissions.ts`), so an unlisted scope
 * is a 403 and nothing else. The dialog is the only way to mint a key, which
 * makes its list the real ceiling on what any key can do — and for a long time
 * it offered eleven strings out of sixty-four, which is how the Terraform
 * provider came to need `costs:read` / `costs:write` and be unable to get them.
 *
 * These are the two directions that have to keep adding up:
 *
 *  - every offered scope is a real permission the server recognises, and
 *  - every permission the server recognises is either offered or explicitly
 *    unoffered because the routes it gates are closed to keys regardless.
 *
 * `@infrawrench/ui/settings/api-key-scopes` is a React-free entry point so this
 * suite can read the table without loading the component barrel.
 */
import { describe, it, expect } from "vitest";
import { ALL_PERMISSIONS } from "@infrawrench/server-core/permissions/catalog";
import {
  API_KEY_UNOFFERED_SCOPES,
  AVAILABLE_SCOPES,
} from "@infrawrench/ui/settings/api-key-scopes";
import { apiKeyRouteDenial } from "@/auth/api-key-route-policy";

const offered = AVAILABLE_SCOPES.map((s) => s.value);
const unoffered = Object.keys(API_KEY_UNOFFERED_SCOPES);

describe("API key scopes cover the permission catalog", () => {
  it("offers only permissions the server recognises", () => {
    const catalog = new Set<string>(ALL_PERMISSIONS);
    expect(offered.filter((s) => !catalog.has(s))).toEqual([]);
  });

  it("classifies every permission as offered or deliberately unoffered", () => {
    const classified = new Set([...offered, ...unoffered]);
    // A permission added to the catalog and to no route the dialog can reach is
    // a capability no API key will ever hold. Adding it to one of the two lists
    // is the decision this failure is asking for.
    expect(ALL_PERMISSIONS.filter((p) => !classified.has(p))).toEqual([]);
  });

  it("names no permission the server has dropped", () => {
    const catalog = new Set<string>(ALL_PERMISSIONS);
    expect(unoffered.filter((s) => !catalog.has(s))).toEqual([]);
  });
});

/**
 * The unoffered list is only defensible if the routes really are closed. One
 * representative request per permission, taken from the route→permission map
 * in `api/openapi/index.ts`, asserted against the deny policy itself.
 */
describe("every unoffered scope gates a route API keys cannot reach anyway", () => {
  const samples: Record<string, { method: string; path: string }> = {
    "apikeys:read": { method: "GET", path: "/api-keys" },
    "apikeys:write": { method: "POST", path: "/api-keys" },
    "billing:read": { method: "GET", path: "/billing/status" },
    "billing:write": { method: "POST", path: "/billing/checkout" },
    "team:invite": { method: "POST", path: "/team/invitations" },
    "team:role:write": { method: "POST", path: "/team/roles" },
    "team:remove": { method: "DELETE", path: "/team/members/m1" },
    "access:request": { method: "POST", path: "/access-requests" },
    "access:approve": { method: "POST", path: "/access-requests/r1/approve" },
  };

  it("has a sample request for each", () => {
    expect(Object.keys(samples).sort()).toEqual([...unoffered].sort());
  });

  for (const [scope, { method, path }] of Object.entries(samples)) {
    it(`${scope} — ${method} ${path} is denied to keys`, () => {
      expect(apiKeyRouteDenial(method, `/api/org/org_1${path}`)).not.toBeNull();
    });
  }
});

/**
 * The regression the issue reported, stated as the property that failed: the
 * cost surface the Terraform provider manages must be selectable, and the docs
 * quote these strings verbatim.
 */
describe("the cost surface is selectable", () => {
  for (const scope of ["costs:read", "costs:write", "budgets:read", "budgets:write"]) {
    it(`offers ${scope}`, () => {
      expect(offered).toContain(scope);
    });

    it(`does not close ${scope}'s routes to keys`, () => {
      expect(apiKeyRouteDenial("GET", "/api/org/org_1/cost-centres")).toBeNull();
      expect(apiKeyRouteDenial("POST", "/api/org/org_1/cost-centres")).toBeNull();
      expect(apiKeyRouteDenial("POST", "/api/org/org_1/budgets")).toBeNull();
    });
  }
});
