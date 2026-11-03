import { afterEach, describe, expect, it } from "vitest";
import { readRevnuMeasurement } from "../revnu-measurement";

const ANON = `ra_${"ab".repeat(16)}`;

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

describe("readRevnuMeasurement", () => {
  it("returns nothing when the tag is absent", () => {
    (globalThis as { window?: unknown }).window = {};
    expect(readRevnuMeasurement()).toBeUndefined();
  });

  it("reads the id and the saved choices, and drops a bad id", () => {
    (globalThis as { window?: unknown }).window = {
      revnu: {
        anonymousId: ANON,
        getContext: () => ({
          anonymousId: ANON,
          consentState: "granted",
          googleAdUserData: "unknown",
          googleAdPersonalization: "unknown",
        }),
      },
    };
    expect(readRevnuMeasurement()).toEqual({
      anonymousId: ANON,
      consentState: "granted",
      googleAdUserData: "unknown",
      googleAdPersonalization: "unknown",
    });

    (globalThis as { window?: unknown }).window = {
      revnu: { getContext: () => ({ anonymousId: "person@example.com", consentState: "nope" }) },
    };
    expect(readRevnuMeasurement()).toBeUndefined();
  });
});
