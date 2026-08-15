/**
 * The Create API Key dialog's scope catalog.
 *
 * These are the properties that hold without knowing the server's permission
 * list; the half that needs it — that the offered scopes and the deliberately
 * unoffered ones partition `ALL_PERMISSIONS` exactly — lives in
 * `web/src/api/__tests__/api-key-scope-catalog.test.ts`, which is the only
 * package that can import both sides.
 */
import { describe, it, expect } from "vitest";
import {
  API_KEY_SCOPE_GROUPS,
  API_KEY_UNOFFERED_SCOPES,
  AVAILABLE_SCOPES,
  DEPRECATED_API_KEY_SCOPES,
} from "../settings/api-key-scopes.js";

const offered = AVAILABLE_SCOPES.map((s) => s.value);

describe("API key scope catalog", () => {
  it("flattens the groups in order, with no duplicates", () => {
    expect(offered).toEqual(API_KEY_SCOPE_GROUPS.flatMap((g) => g.scopes.map((s) => s.value)));
    expect(new Set(offered).size).toBe(offered.length);
  });

  it("labels every scope and titles every group", () => {
    for (const group of API_KEY_SCOPE_GROUPS) {
      expect(group.title.trim()).not.toBe("");
      expect(group.scopes.length).toBeGreaterThan(0);
      for (const scope of group.scopes) {
        expect(scope.value).toMatch(/^[a-z][a-z-]*(:[a-z][a-z-]*)+$/);
        expect(scope.label.trim()).not.toBe("");
      }
    }
    const labels = AVAILABLE_SCOPES.map((s) => s.label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("never offers a scope it also declares unoffered", () => {
    for (const value of Object.keys(API_KEY_UNOFFERED_SCOPES)) {
      expect(offered).not.toContain(value);
    }
  });

  /**
   * The issue this catalog was rewritten for: the Terraform provider's primary
   * surface is cost allocation and reporting, it authenticates with an `iwk_`
   * key, and the dialog could not produce a key holding the scopes the docs
   * tell you to select.
   */
  it("offers every scope the Terraform provider's documented key needs", () => {
    for (const scope of [
      "costs:read",
      "costs:write",
      "budgets:read",
      "budgets:write",
      "resources:read",
      "resources:write",
      "org:settings:write",
    ]) {
      expect(offered).toContain(scope);
    }
  });

  /**
   * `sync:read` / `sync:write` are rewritten to `resources:read` /
   * `resources:write` the next time a key carrying them authenticates, so
   * offering them mints a key whose scopes silently change under it.
   */
  it("does not offer the deprecated sync scopes", () => {
    for (const scope of DEPRECATED_API_KEY_SCOPES) {
      expect(offered).not.toContain(scope);
    }
  });
});
