import { describe, expect, it } from "vitest";
import { describeError, redact } from "../log";

describe("describeError", () => {
  it("keeps the class, the message and where it was thrown", () => {
    const text = describeError(new TypeError("cannot read the thing"));
    expect(text).toMatch(/^TypeError: cannot read the thing\n {2}at /);
  });

  it("leaves a statement's parameters out", () => {
    const error = new Error(
      'Failed query: insert into "git_comments" ("body") values ($1)\nparams: the text of a private comment,someone@example.test',
    );
    const text = describeError(error);
    expect(text).toContain('insert into "git_comments"');
    expect(text).not.toContain("private comment");
    expect(text).not.toContain("someone@example.test");
  });

  it("names a schema error without the value that failed", () => {
    const error = Object.assign(new Error('Expected a string, got "iwg_notarealtokenvalue0000"'), {
      _tag: "HttpApiSchemaError",
      kind: "Body",
      cause: { issue: { actual: { secret: "iwg_notarealtokenvalue0000" } } },
    });
    const text = describeError(error);
    expect(text).toContain("HttpApiSchemaError kind=Body");
    expect(text).not.toContain("notarealtokenvalue");
  });

  it("writes credentials as their kind only, wherever they are", () => {
    const cause = new Error("upstream said no to Authorization: Bearer abcdefghijklmnop.qrstuv");
    const error = new Error(
      "fetch https://example.test/x?token=iwj_abcdefghijklmnop.sig&ref=main failed for iwk_abcdefghijklmnop",
      { cause },
    );
    const text = describeError(error);
    expect(text).not.toContain("abcdefghijklmnop");
    expect(text).toContain("token=[redacted]");
    expect(text).toContain("iwk_[redacted]");
    expect(text).toContain("caused by Error: upstream said no to Authorization: Bearer [redacted]");
  });

  it("stays on its lines and within bounds whatever the message holds", () => {
    const text = describeError(new Error(`one\r\ntwo\u2028three ${"x".repeat(5000)}`));
    expect(text.split("\n")[0]).toContain("one  two three");
    expect(text.split("\n")[0]!.length).toBeLessThan(1100);
  });

  it("describes what is not an error, and never throws", () => {
    expect(describeError("plain iwg_abcdefghijklmnop")).toBe("plain iwg_[redacted]");
    expect(describeError(undefined)).toBe("(undefined)");
    expect(describeError({ _tag: "Refused", secret: "value" })).toBe("(Refused)");
    const hostile = new Proxy(
      {},
      {
        has: () => {
          throw new Error("no");
        },
      },
    );
    expect(describeError(hostile)).toBe("(an error that could not be described)");
    const loop = new Error("a");
    loop.cause = loop;
    expect(describeError(loop).match(/caused by/g)?.length).toBe(3);
  });
});

describe("redact", () => {
  it("cuts a sealed cookie value", () => {
    expect(redact("cookie v1.aaaaaaaaaaaa.bbbbbbbbbbbb.cccccccccccccccc end")).toBe(
      "cookie [sealed] end",
    );
  });
});
