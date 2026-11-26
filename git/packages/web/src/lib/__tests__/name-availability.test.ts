// @vitest-environment node
import { describe, expect, it } from "vitest";
import { deriveNameAvailability, mayUseName } from "../name-availability";

const free = (name: string) => ({ name, available: true, reason: null, message: null });
const taken = (name: string) => ({
  name,
  available: false,
  reason: "taken" as const,
  message: "A repository with that name exists here",
});

describe("deriveNameAvailability", () => {
  it("says nothing of an empty name", () => {
    expect(
      deriveNameAvailability({ name: "", settled: "", answer: undefined, failed: false }).state,
    ).toBe("empty");
  });

  it("applies the name rules before asking", () => {
    const answer = deriveNameAvailability({
      name: "-x",
      settled: "-x",
      answer: undefined,
      failed: false,
    });
    expect(answer.state).toBe("invalid");
    expect(answer.message).toEqual(expect.any(String));
  });

  it("waits while typing runs ahead of the answer", () => {
    expect(
      deriveNameAvailability({
        name: "infra-2",
        settled: "infra",
        answer: free("infra"),
        failed: false,
      }).state,
    ).toBe("checking");
    // An answer for another name is not this name's.
    expect(
      deriveNameAvailability({
        name: "infra-2",
        settled: "infra-2",
        answer: free("infra"),
        failed: false,
      }).state,
    ).toBe("checking");
  });

  it("reads the API's answer for the name", () => {
    const available = deriveNameAvailability({
      name: "fresh",
      settled: "fresh",
      answer: free("fresh"),
      failed: false,
    });
    expect(available).toEqual({ state: "available", message: null });
    expect(mayUseName(available)).toBe(true);
    const refused = deriveNameAvailability({
      name: "infra",
      settled: "infra",
      answer: taken("infra"),
      failed: false,
    });
    expect(refused).toEqual({
      state: "taken",
      message: "A repository with that name exists here",
    });
    expect(mayUseName(refused)).toBe(false);
  });

  it("calls a repository's own name the same, whatever its case", () => {
    const same = deriveNameAvailability({
      name: "Infra",
      settled: "Infra",
      current: "infra",
      answer: undefined,
      failed: false,
    });
    expect(same.state).toBe("same");
  });

  it("leaves a check that failed to the server", () => {
    const unknown = deriveNameAvailability({
      name: "fresh",
      settled: "fresh",
      answer: undefined,
      failed: true,
    });
    expect(unknown.state).toBe("unknown");
    expect(mayUseName(unknown)).toBe(true);
  });
});
