import http from "node:http";
import type { AddressInfo } from "node:net";
import { createRequire } from "node:module";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { documentToTypes, generateDocument } from "../generate.js";
import type { JsonObject } from "../json.js";
import { parseDocument } from "../parse.js";

const options = { silent: true };

const doc = (schema: JsonObject): JsonObject => ({
  openapi: "3.1.0",
  info: { title: "x", version: "1" },
  paths: {
    "/a": {
      get: {
        operationId: "getA",
        responses: {
          "200": { description: "ok", content: { "application/json": { schema } } },
          "404": {
            description: "no",
            content: { "application/json": { schema: { type: "number" } } },
          },
        },
      },
    },
  },
});

describe("the TypeScript in use", () => {
  it("is the JS compiler API, for this package and for openapi-typescript alike", () => {
    expect(ts.version).toMatch(/^6\./);
    const require = createRequire(import.meta.url);
    const fromGenerator = createRequire(require.resolve("openapi-typescript")).resolve(
      "typescript",
    );
    expect(fromGenerator).toBe(require.resolve("typescript"));
    expect(fromGenerator).toContain("typescript6");
  });
});

describe("documentToTypes", () => {
  it("writes types for the listed operations only, with 2xx bodies", async () => {
    const types = await documentToTypes(
      doc({
        type: "object",
        required: ["id"],
        properties: { id: { type: "string", description: "no" } },
      }),
      { paths: { "/a": ["get"] }, patches: [] },
      options,
    );
    expect(types).toContain(`"/a": {`);
    expect(types).toContain("id: string;");
    expect(types).not.toContain("number");
    expect(types).not.toContain("description");
  });

  it("treats a server-side default as optional in a request", async () => {
    const types = await documentToTypes(
      doc({ type: "object", properties: { id: { type: "string", default: "x" } } }),
      { paths: { "/a": ["get"] }, patches: [] },
      options,
    );
    expect(types).toContain("id?: string;");
  });

  it("applies patches after a pathPrefix has been removed", async () => {
    const source = doc({ type: "string" });
    source["paths"] = { "/v2/a": Object(source["paths"])["/a"] };
    const types = await documentToTypes(
      source,
      {
        pathPrefix: "/v2",
        paths: { "/a": ["get"] },
        patches: [
          {
            pointer: "/paths/~1a/get/responses/200/content/application~1json/schema/type",
            value: "boolean",
            why: "test",
          },
        ],
      },
      options,
    );
    expect(types).toContain(`"/a"`);
    expect(types).not.toContain("/v2");
    expect(types).toContain("boolean");
  });

  it("generates from a converted Swagger 2 document", async () => {
    const parsed = parseDocument(
      JSON.stringify({
        swagger: "2.0",
        info: { title: "x", version: "1" },
        paths: {
          "/a": {
            get: {
              operationId: "getA",
              produces: ["application/json"],
              responses: { "200": { description: "ok", schema: { $ref: "#/definitions/A" } } },
            },
          },
        },
        definitions: { A: { type: "object", properties: { id: { type: "integer" } } } },
      }),
      "https://x.test/a",
    );
    const types = await documentToTypes(parsed, { paths: { "/a": ["get"] }, patches: [] }, options);
    expect(types).toContain(`components["schemas"]["A"]`);
    expect(types).toContain("id?: number");
  });
});

describe("hostile documents", () => {
  const generate = (schema: JsonObject) =>
    generateDocument(
      "acme",
      {
        fileName: "api-types.gen.ts",
        specUrl: "https://x.test/a",
        paths: { "/a": ["get"] },
        patches: [],
      },
      () => Promise.resolve(JSON.stringify(doc(schema))),
      options,
    );

  it.each([
    ["a format closing its comment", { type: "string", format: "*/ export const pwned = 1; /*" }],
    ["a default closing its comment", { type: "string", default: "*/ export const pwned = 1; /*" }],
    ["an enum value with quotes", { type: "string", enum: [`"; export const pwned = 1; "`] }],
    [
      "a property name with quotes",
      {
        type: "object",
        properties: { [`a"]: string; }; export const pwned = 1; //`]: { type: "string" } },
      },
    ],
  ])("leaves no code from %s", async (_name, schema) => {
    const { text } = await generate(schema);
    const output = ts.transpileModule(text, { compilerOptions: { removeComments: true } });
    expect(output.outputText).not.toContain("pwned");
  });

  it("makes no request for a reference held in an extension", async () => {
    let requests = 0;
    const server = http.createServer((_request, response) => {
      requests += 1;
      response.end(`{"type":"string"}`);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port }: AddressInfo = Object(server.address());
    try {
      const url = `http://127.0.0.1:${port}/x.json`;
      const { text } = await generate({
        type: "string",
        "x-direct": { $ref: url },
        "x-samples": [{ code: { $ref: url } }],
      });
      expect(text).toContain(`"/a"`);
      expect(requests).toBe(0);
    } finally {
      server.close();
    }
  });

  it("refuses a $ref that leaves the document, before anything resolves it", async () => {
    await expect(generate({ $ref: "../../../../.env" })).rejects.toMatchObject({ kind: "unsafe" });
    await expect(generate({ $ref: "https://evil.test/x.json" })).rejects.toMatchObject({
      kind: "unsafe",
    });
  });
});
