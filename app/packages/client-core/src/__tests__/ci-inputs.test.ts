import { describe, expect, it } from "vitest";
import { checkCiInputs, type CiInput } from "../ci";

const inputs: CiInput[] = [
  { name: "urls", type: "string", required: false },
  { name: "force", type: "boolean", required: false },
  {
    name: "target",
    type: "choice",
    required: false,
    default: "staging",
    options: ["staging", "production"],
  },
  { name: "shards", type: "number", required: false, default: "4" },
  { name: "note", type: "string", required: true },
];

// The same cases as the runner's `inputs_are_checked_against_their_types`
// and `inputs_read_as_values_with_their_defaults`, so the form refuses what
// the runner would.
describe("checkCiInputs", () => {
  it("fills in defaults and reads values as text", () => {
    const { problems, values } = checkCiInputs(inputs, {
      note: "ship it",
      force: true,
      shards: " 1.5e3 ",
    });
    expect(problems).toEqual({});
    expect(values).toEqual({
      urls: "",
      force: "true",
      target: "staging",
      shards: "1.5e3",
      note: "ship it",
    });
  });

  it("refuses what the runner refuses", () => {
    const { problems } = checkCiInputs(inputs, {
      force: "yes",
      target: "prod",
      shards: "NaN",
      nope: "x",
    });
    expect(problems).toEqual({
      force: { kind: "boolean" },
      target: { kind: "choice", options: ["staging", "production"] },
      shards: { kind: "number" },
      nope: { kind: "unknown" },
      note: { kind: "required" },
    });
    for (const bad of ["inf", "-Infinity", "0x10", "1,5"]) {
      expect(checkCiInputs(inputs, { note: "n", shards: bad }).problems).toEqual({
        shards: { kind: "number" },
      });
    }
    expect(checkCiInputs(inputs, { note: "" }).problems).toEqual({ note: { kind: "required" } });
    expect(checkCiInputs(inputs, { note: "x".repeat(16 * 1024 + 1) }).problems.note?.kind).toBe(
      "too-long",
    );
  });

  it("keeps a hostile string exactly as typed", () => {
    const hostile = "$(touch /tmp/pwned) `id` '; rm -rf / #\"\nsecond ${{ secrets.TOKEN }}";
    const { problems, values } = checkCiInputs(inputs, { note: "n", urls: hostile });
    expect(problems).toEqual({});
    expect(values.urls).toBe(hostile);
  });
});
