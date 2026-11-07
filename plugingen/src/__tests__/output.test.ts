import { describe, expect, it } from "vitest";
import { assertTypesOnly, generatedHeader } from "../output.js";

describe("assertTypesOnly", () => {
  it("accepts what the generator writes", () => {
    expect(() =>
      assertTypesOnly(`// comment
/* eslint-disable */
export interface paths { "/a": { get: operations["x"]; }; }
export type webhooks = Record<string, never>;
export interface operations { x: { /** Format: uri */ a: string }; }
type shared_12345678 = { a: string };
`),
    ).not.toThrow();
  });

  it.each([
    ["a value", `export const x = 1;`],
    ["a call", `fetch("https://evil.test");`],
    ["a class", `export class X {}`],
    ["an enum", `export enum X { A }`],
    ["an import", `import "./evil.js";`],
    ["a type import", `import type { X } from "./evil.js";\nexport type Y = X;`],
    ["an inline type import", `export type X = import("./evil.js").Y;`],
    ["a reference directive", `/// <reference path="./evil.d.ts" />\nexport type X = string;`],
    ["a syntax error", `export type X = {`],
  ])("refuses %s", (_name, source) => {
    expect(() => assertTypesOnly(source)).toThrowError(expect.objectContaining({ kind: "unsafe" }));
  });
});

describe("generatedHeader", () => {
  it("names the tool and the config, in the three lines the proof strips", () => {
    const header = generatedHeader("acme", "https://x.test/a");
    expect(header).toContain("plugingen");
    expect(header).toContain("plugingen.json");
    expect(header).toContain("https://x.test/a");
    expect(header.trimEnd().split("\n")).toHaveLength(3);
  });
});
