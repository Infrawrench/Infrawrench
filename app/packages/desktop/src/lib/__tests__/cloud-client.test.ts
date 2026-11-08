/**
 * The parts of the renderer's cloud client (`../cloud-client.ts`) that are
 * not about the transport: the lenient enums of a request, and the server's
 * error sentence. The calls end to end are in
 * `electron/__tests__/cloud-transport.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { Option, Schema, SchemaAST } from "effect";
import { DESKTOP_CLOUD_APIS } from "../../../shared/cloud-apis";
import {
  CloudResponseError,
  serverErrorSentence,
  widenLiteralEnums,
  withServerSentence,
} from "../cloud-client";

/** `schema` encoded with its enums widened; the test schemas need no services. */
const lenientEncode = (schema: Schema.Codec<unknown, unknown>) =>
  Schema.encodeUnknownSync(
    Schema.make<Schema.Codec<unknown, unknown>>(widenLiteralEnums(schema.ast)),
  );

describe("widenLiteralEnums", () => {
  const Filter = Schema.Struct({
    kind: Schema.Literal("relative"),
    preset: Schema.Literals(["7d", "30d"]),
    basis: Schema.optionalKey(Schema.Literals(["cash", "amortized"])),
    window: Schema.Literals([7, 28]),
    tags: Schema.Array(Schema.NullOr(Schema.Literals(["in", "not_in"]))),
  });

  it("lets any string through a string enum, at any depth, optional keys kept", () => {
    const encode = lenientEncode(Filter);
    expect(encode({ kind: "relative", preset: "365d", window: 7, tags: ["any", null] })).toEqual({
      kind: "relative",
      preset: "365d",
      window: 7,
      tags: ["any", null],
    });
    expect(
      encode({ kind: "relative", preset: "7d", basis: "blended", window: 28, tags: [] }),
    ).toEqual({ kind: "relative", preset: "7d", basis: "blended", window: 28, tags: [] });
  });

  it("keeps a single literal, a numeric enum and every other check strict", () => {
    const encode = lenientEncode(Filter);
    const valid = { kind: "relative", preset: "7d", window: 7, tags: [] };
    expect(() => encode({ ...valid, kind: "absolute" })).toThrow();
    expect(() => encode({ ...valid, window: 30 })).toThrow();
    expect(() => encode({ ...valid, preset: 7 })).toThrow();
    expect(() => encode({ ...valid, tags: [1] })).toThrow();
    const { preset: _preset, ...missing } = valid;
    expect(() => encode(missing)).toThrow();
  });

  it("still picks a discriminated union's member by its literal tag", () => {
    const Range = Schema.Union([
      Schema.Struct({ kind: Schema.Literal("relative"), preset: Schema.Literals(["7d", "30d"]) }),
      Schema.Struct({ kind: Schema.Literal("absolute"), from: Schema.String }),
    ]);
    const encode = lenientEncode(Range);
    expect(encode({ kind: "absolute", from: "2026-01-01" })).toEqual({
      kind: "absolute",
      from: "2026-01-01",
    });
    expect(encode({ kind: "relative", preset: "ytd" })).toEqual({
      kind: "relative",
      preset: "ytd",
    });
    expect(() => encode({ kind: "rolling", preset: "7d" })).toThrow();
  });

  /** Every string enum still strict in `ast`, as paths. */
  function strictEnums(ast: SchemaAST.AST, path: string, seen: Set<SchemaAST.AST>): string[] {
    if (seen.has(ast)) return [];
    seen.add(ast);
    const found: string[] = [];
    for (const link of ast.encoding ?? []) found.push(...strictEnums(link.to, path, seen));
    switch (ast._tag) {
      case "Union": {
        const literals = ast.types.filter(
          (member) =>
            SchemaAST.isLiteral(member) &&
            typeof member.literal === "string" &&
            member.encoding === undefined &&
            member.checks === undefined,
        );
        if (literals.length >= 2) found.push(path);
        for (const member of ast.types) found.push(...strictEnums(member, path, seen));
        break;
      }
      case "Enum":
        if (ast.enums.every(([, value]) => typeof value === "string")) found.push(path);
        break;
      case "Objects":
        for (const property of ast.propertySignatures) {
          found.push(...strictEnums(property.type, `${path}.${String(property.name)}`, seen));
        }
        for (const index of ast.indexSignatures) {
          found.push(...strictEnums(index.type, `${path}[key]`, seen));
        }
        break;
      case "Arrays":
        for (const element of [...ast.elements, ...ast.rest]) {
          found.push(...strictEnums(element, `${path}[]`, seen));
        }
        break;
      case "Suspend":
        found.push(...strictEnums(ast.thunk(), path, seen));
        break;
      case "Declaration":
        for (const parameter of ast.typeParameters) {
          found.push(...strictEnums(parameter, path, seen));
        }
        break;
    }
    return found;
  }

  it("leaves no string enum strict in any request of any registered domain", () => {
    const strict: string[] = [];
    for (const [name, { endpoints }] of Object.entries(DESKTOP_CLOUD_APIS)) {
      for (const { group, endpoint } of endpoints) {
        const id = `${name}.${group}.${endpoint.identifier}`;
        const schemas: Array<[string, Schema.Top]> = [];
        if (endpoint.params) schemas.push(["params", endpoint.params]);
        if (endpoint.query) schemas.push(["query", endpoint.query]);
        if (endpoint.headers) schemas.push(["headers", endpoint.headers]);
        for (const { schemas: payloads } of endpoint.payload.values()) {
          for (const payload of payloads) schemas.push(["payload", payload]);
        }
        for (const [part, schema] of schemas) {
          strict.push(...strictEnums(widenLiteralEnums(schema.ast), `${id} ${part}`, new Set()));
        }
      }
    }
    expect(strict).toEqual([]);
  });
});

describe("the server's error sentence", () => {
  it("reads the `error` string of a JSON body", () => {
    expect(serverErrorSentence('{"error":"Probe not found"}')).toEqual(
      Option.some("Probe not found"),
    );
    expect(serverErrorSentence('{"error":{"code":1}}')).toEqual(Option.none());
    expect(serverErrorSentence("Bad gateway")).toEqual(Option.none());
    expect(serverErrorSentence("")).toEqual(Option.none());
  });

  it("replaces a failed answer's message with it, keeping the status and body", () => {
    const failed = new CloudResponseError({
      message: 'Cloud request failed: 409 /x {"error":"Frozen"}',
      status: 409,
      body: '{"error":"Frozen"}',
    });
    expect(withServerSentence(failed)).toMatchObject({
      _tag: "CloudResponseError",
      message: "Frozen",
      status: 409,
      body: '{"error":"Frozen"}',
    });
    const plain = new CloudResponseError({ message: "kept", status: 502, body: "Bad gateway" });
    expect(withServerSentence(plain)).toBe(plain);
    const other = new Error("not a response");
    expect(withServerSentence(other)).toBe(other);
  });
});
