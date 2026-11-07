import { describe, expect, it } from "vitest";
import { isIncompleteListError, rethrowIncompleteList, SecretReadError } from "../list-errors.js";

describe("SecretReadError", () => {
  it("counts as an incomplete list, so a catch around a list read passes it on", () => {
    const err = new SecretReadError("apiKey", new Error("bad tag"));
    expect(isIncompleteListError(err)).toBe(true);
    expect(() => rethrowIncompleteList(err)).toThrow(err);
  });

  it("names the field, and keeps what went wrong out of its message", () => {
    const err = new SecretReadError("apiKey", new Error("Failed query: select secret"));
    expect(err.message).toContain("apiKey");
    expect(err.message).not.toContain("select secret");
    expect(err.cause).toBeInstanceOf(Error);
    expect(err.name).toBe("SecretReadError");
  });

  it("reaches a host's tracker when a plugin swallows it", () => {
    const seen: unknown[] = [];
    const hook = Symbol.for("infrawrench.incompleteList");
    Reflect.set(globalThis, hook, (error: unknown) => seen.push(error));
    try {
      const err = new SecretReadError("apiKey");
      expect(seen).toEqual([err]);
    } finally {
      Reflect.deleteProperty(globalThis, hook);
    }
  });
});
