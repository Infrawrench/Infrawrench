import { describe, expect, it } from "vitest";
import { parseDocument } from "../parse.js";

const URL_ = "https://vendor.test/doc";

describe("parseDocument", () => {
  it("reads JSON and YAML", () => {
    expect(parseDocument(`  {"openapi":"3.1.0"}`, URL_)).toEqual({ openapi: "3.1.0" });
    expect(parseDocument(`openapi: 3.0.3\npaths: {}\n`, URL_)).toEqual({
      openapi: "3.0.3",
      paths: {},
    });
  });

  it("converts Swagger 2, so paths and patches address the OpenAPI 3 form", () => {
    const doc = parseDocument(
      JSON.stringify({
        swagger: "2.0",
        info: { title: "x", version: "1" },
        basePath: "/v1",
        host: "x.test",
        paths: { "/a": { get: { responses: { 200: { schema: { $ref: "#/definitions/A" } } } } } },
        definitions: { A: { type: "object" } },
      }),
      URL_,
    );
    expect(doc["openapi"]).toMatch(/^3\./);
    expect(doc).toHaveProperty("components.schemas.A");
    expect(doc).toHaveProperty(["paths", "/a"]);
    expect(JSON.stringify(doc["servers"])).toContain("/v1");
  });

  it.each([
    ["an HTML page", "<html><body>Moved</body></html>"],
    ["malformed JSON", `{"openapi": `],
    ["malformed YAML", `a: b: c: [`],
    ["a bare string", "hello"],
    ["an array", "[1]"],
    ["some other document", `{"asyncapi":"2.0.0"}`],
    ["OpenAPI 4", `{"openapi":"4.0.0"}`],
  ])("rejects %s", (_name, text) => {
    expect(() => parseDocument(text, URL_)).toThrowError(
      expect.objectContaining({ kind: "parse" }),
    );
  });

  it("refuses a __proto__ key at any depth", () => {
    const text = `{"openapi":"3.0.0","a":[{"__proto__":{"polluted":true}}]}`;
    expect(() => parseDocument(text, URL_)).toThrowError(
      expect.objectContaining({ kind: "unsafe" }),
    );
    expect({}).not.toHaveProperty("polluted");
  });

  it("refuses a document that refers to itself", () => {
    const text = `openapi: 3.0.0\na: &a\n  b: *a\n`;
    expect(() => parseDocument(text, URL_)).toThrowError(
      expect.objectContaining({ kind: "unsafe" }),
    );
  });

  it("accepts an alias used twice, which is not a cycle", () => {
    const text = `openapi: 3.0.0\na: &a\n  x: 1\nb: *a\nc: *a\n`;
    expect(parseDocument(text, URL_)).toMatchObject({ b: { x: 1 }, c: { x: 1 } });
  });
});
