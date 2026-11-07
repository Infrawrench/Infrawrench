import { describe, expect, it } from "vitest";
import { shareRepeatedTypes } from "../sharing.js";

const big = (name: string): string =>
  `{ ${Array.from({ length: 30 }, (_, i) => `${name}${i}: string;`).join(" ")} }`;

describe("shareRepeatedTypes", () => {
  it("gives a large repeated type one alias, named after where it was found", () => {
    const out = shareRepeatedTypes(
      `export interface paths { a: { project: ${big("field")}; one: string; }; b: { project: ${big("field")}; two: string; }; }\n`,
    );
    const alias = /project: (project_[0-9a-f]{8})/.exec(out)?.[1];
    expect(alias).toBeDefined();
    expect(out).toContain(`type ${alias} =`);
    expect(out.match(/field0: string/g)).toHaveLength(1);
  });

  it("leaves a small repeated type alone", () => {
    const out = shareRepeatedTypes(
      `export interface paths { a: { x: { y: string }; }; b: { x: { y: string }; }; }\n`,
    );
    expect(out).not.toMatch(/^type /m);
  });

  it("names an alias by its content, so one shape changing does not rename another", () => {
    const one = big("one");
    const render = (other: string) =>
      shareRepeatedTypes(
        `export interface paths { a: { p: ${one}; q: ${other}; }; b: { p: ${one}; q: ${other}; }; }\n`,
      );
    const aliasesOf = (text: string) => text.match(/\bp_[0-9a-f]{8}\b/g)?.[0];
    expect(aliasesOf(render(big("two")))).toBe(aliasesOf(render(big("three"))));
  });

  it("puts back an alias that ended up with one user", () => {
    const inner = big("inner");
    const outer = `{ nested: ${inner}; pad: string; }`;
    const out = shareRepeatedTypes(
      `export interface paths { a: { x: ${outer}; }; b: { x: ${outer}; }; }\n`,
    );
    expect(out.match(/^type /gm)).toHaveLength(1);
    expect(out.match(/inner0: string/g)).toHaveLength(1);
  });
});
