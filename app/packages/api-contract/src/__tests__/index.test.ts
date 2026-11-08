/**
 * The package entry: every domain's `HttpApi` is listed once, and each one
 * documents on its own, from this package alone. The web server's spec build
 * and the semantic spec diff cover what the documents say; this covers that a
 * definition needs nothing outside the contract to load and reflect.
 */
import { HttpApi, OpenApi } from "effect/http-api";
import { describe, expect, it } from "vitest";
import { ALL_APIS, API_DEFINITIONS } from "../index";

describe("API_DEFINITIONS", () => {
  it("lists HttpApi values, each under one name", () => {
    expect(ALL_APIS.length).toBe(Object.keys(API_DEFINITIONS).length);
    for (const [name, api] of Object.entries(API_DEFINITIONS)) {
      expect(HttpApi.isHttpApi(api), name).toBe(true);
    }
    expect(new Set(ALL_APIS).size).toBe(ALL_APIS.length);
    expect(new Set(ALL_APIS.map((api) => api.identifier)).size).toBe(ALL_APIS.length);
  });

  it("documents every domain without the server", () => {
    // Some domains are excluded from the document whole (`OpenApi.Exclude`),
    // so an empty `paths` is fine; building it is the check.
    for (const api of ALL_APIS) {
      // `fromApi` infers one API's groups, which a union of 150 cannot give it.
      const erased = api as unknown as HttpApi.HttpApi<string, never>;
      expect(OpenApi.fromApi(erased).paths, api.identifier).toBeTypeOf("object");
    }
  });
});
