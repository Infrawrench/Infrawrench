import { describe, expect, it } from "vitest";
import { affectedOperations, operationFingerprints } from "../operations.js";

const file = (a: string, b: string, shared = "string"): string => `export interface paths {
    "/a": {
        parameters: { query?: never; };
        get: operations["getA"];
        put?: never;
    };
    "/b": {
        parameters: { query?: never; };
        get: operations["getB"];
        post: { requestBody: shared_12345678; };
        put?: never;
    };
}
export interface components {
    schemas: {
        A: { value: ${a}; };
        B: { value: ${b}; };
    };
}
export interface operations {
    getA: { responses: { 200: components["schemas"]["A"]; }; };
    getB: { responses: { 200: components["schemas"]["B"]; }; };
}
type shared_12345678 = { field: ${shared}; };
`;

describe("operationFingerprints", () => {
  it("lists real operations and skips the absent ones", () => {
    expect([...operationFingerprints(file("string", "string")).keys()].sort()).toEqual([
      "GET /a",
      "GET /b",
      "POST /b",
    ]);
  });
});

describe("affectedOperations", () => {
  it("is empty when nothing moved", () => {
    expect(affectedOperations(file("string", "string"), file("string", "string"))).toEqual([]);
  });

  it("ignores formatting and the header", () => {
    const before = file("string", "string");
    const after = `// Generated from elsewhere\n${before.replaceAll("    ", "  ")}`;
    expect(affectedOperations(before, after)).toEqual([]);
  });

  it("follows an operation through to a component it reaches", () => {
    expect(affectedOperations(file("string", "string"), file("number", "string"))).toEqual([
      "GET /a",
    ]);
  });

  it("follows an operation through to a shared alias", () => {
    expect(
      affectedOperations(file("string", "string"), file("string", "string", "number")),
    ).toEqual(["POST /b"]);
  });

  it("reports an operation added or removed", () => {
    const before = file("string", "string");
    const after = before.replace(
      `        put?: never;\n    };\n    "/b"`,
      `        put: operations["getA"];\n    };\n    "/b"`,
    );
    expect(affectedOperations(before, after)).toEqual(["PUT /a"]);
    expect(affectedOperations(after, before)).toEqual(["PUT /a"]);
  });
});
