import { describe, expect, it } from "vitest";
import { tagKeyChipOptions, tagKeySuggestions } from "../tag-key-options";

const options = [
  { value: "team", label: "team", preferred: true },
  { value: "env", label: "env" },
  { value: "Environment", label: "Environment" },
];

describe("tagKeyChipOptions", () => {
  it("stars preferred keys and keeps the server's order", () => {
    expect(tagKeyChipOptions(options, null).map((o) => o.label)).toEqual([
      "★ team",
      "env",
      "Environment",
    ]);
  });

  it("keeps a selected key the list no longer offers", () => {
    expect(tagKeyChipOptions(options, "aws:createdBy").at(-1)).toEqual({
      value: "aws:createdBy",
      label: "aws:createdBy",
    });
  });
});

describe("tagKeySuggestions", () => {
  it("filters by typed prefix, case-insensitively", () => {
    expect(tagKeySuggestions(options, "en").map((o) => o.value)).toEqual(["env", "Environment"]);
  });

  it("stops suggesting once the field holds an exact key", () => {
    expect(tagKeySuggestions(options, "env")).toEqual([]);
  });
});
