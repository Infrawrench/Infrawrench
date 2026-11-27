import { describe, expect, it } from "vitest";
import { coAuthorsOf } from "../trailers";

describe("coAuthorsOf", () => {
  it("reads the trailers of the last paragraph, each email once, never the author", () => {
    const message = [
      "fix: a thing",
      "",
      "Body text that mentions Co-authored-by: Not A <trailer@example.com> mid-paragraph.",
      "",
      "Signed-off-by: Ada <ada@example.com>",
      "Co-authored-by: Claude Opus 5.5 <noreply@anthropic.com>",
      "co-authored-by: Grace Hopper <grace@example.com>",
      "Co-Authored-By: Again <NOREPLY@anthropic.com>",
      "Co-authored-by: Ada <ADA@example.com>",
      "",
    ].join("\n");
    expect(coAuthorsOf(message, "ada@example.com")).toEqual([
      { name: "Claude Opus 5.5", email: "noreply@anthropic.com" },
      { name: "Grace Hopper", email: "grace@example.com" },
    ]);
  });

  it("finds none in a one-line message or a body without trailers", () => {
    expect(coAuthorsOf("Co-authored-by: A <a@example.com>", "b@example.com")).toEqual([]);
    expect(coAuthorsOf("subject\n\njust a body", "b@example.com")).toEqual([]);
  });

  it("refuses lines that are not a name and an address", () => {
    const message = "s\n\nCo-authored-by: nobody\nCo-authored-by: <x@example.com>";
    expect(coAuthorsOf(message, "b@example.com")).toEqual([
      { name: "x@example.com", email: "x@example.com" },
    ]);
  });
});
