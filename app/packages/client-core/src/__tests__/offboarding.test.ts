import { describe, expect, it } from "vitest";
import {
  matchIdentityFields,
  matchIdentityValue,
  normalizeAliases,
  offboardingItemActionable,
  offboardingProgress,
  offboardingToCsv,
  validateOffboardingIdentity,
  type Offboarding,
  type OffboardingItem,
} from "../offboarding";

const person = { email: "Jane.Doe@example.com", aliases: ["jdoe-gh", "@janed"], name: "Jane Doe" };

describe("matchIdentityValue", () => {
  it("matches the email exactly, ignoring case and spaces", () => {
    expect(matchIdentityValue(" jane.doe@EXAMPLE.com ", person)?.confidence).toBe("exact");
  });

  it("matches listed aliases with or without a leading @", () => {
    expect(matchIdentityValue("jdoe-gh", person)?.confidence).toBe("alias");
    expect(matchIdentityValue("@jdoe-gh", person)?.confidence).toBe("alias");
    expect(matchIdentityValue("janed", person)?.confidence).toBe("alias");
  });

  it("only suggests weaker matches as possible", () => {
    expect(matchIdentityValue("jane.doe", person)).toMatchObject({
      confidence: "possible",
      basis: "local-part",
    });
    expect(matchIdentityValue("jane.doe@old.example.org", person)).toMatchObject({
      confidence: "possible",
      basis: "other-domain",
    });
    expect(matchIdentityValue("Jane Doe", person)).toMatchObject({
      confidence: "possible",
      basis: "name",
    });
  });

  it("never matches someone else", () => {
    expect(matchIdentityValue("john@example.com", person)).toBeNull();
    expect(matchIdentityValue("jane", person)).toBeNull();
    expect(matchIdentityValue("", person)).toBeNull();
  });

  it("does not suggest a one-word name or a very short local part", () => {
    expect(
      matchIdentityValue("admin", { email: "x@example.com", aliases: [], name: "admin" }),
    ).toBeNull();
    expect(matchIdentityValue("al", { email: "al@example.com", aliases: [] })).toBeNull();
  });
});

describe("matchIdentityFields", () => {
  it("finds the strongest match at any depth and names the field", () => {
    const hit = matchIdentityFields(
      { name: "jane.doe", tags: { owner: "jane.doe@example.com" }, list: ["x"] },
      person,
    );
    expect(hit).toMatchObject({ confidence: "exact", field: "tags.owner" });
  });

  it("ignores long documents", () => {
    expect(
      matchIdentityFields({ policy: `${"x".repeat(400)} jane.doe@example.com` }, person),
    ).toBeNull();
  });
});

describe("normalizeAliases", () => {
  it("drops the email, duplicates, @ prefixes and one-letter handles", () => {
    expect(
      normalizeAliases(["@JDoe", "jdoe", "j", "jane.doe@example.com", " x2 "], person.email),
    ).toEqual(["jdoe", "x2"]);
  });
});

describe("validateOffboardingIdentity", () => {
  it("requires an email address", () => {
    expect(validateOffboardingIdentity("jane", [])).not.toBeNull();
    expect(validateOffboardingIdentity("jane@example.com", [])).toBeNull();
  });
});

function item(over: Partial<OffboardingItem>): OffboardingItem {
  return {
    id: "i",
    kind: "seat",
    title: "Copilot Business",
    detail: null,
    pluginId: "github",
    providerName: "GitHub",
    accountId: "a",
    accountName: "acme",
    resourceId: null,
    resourceTypeId: null,
    confidence: "exact",
    matchReason: "Their email",
    matchState: "matched",
    actions: ["remove-seat"],
    status: "open",
    resolution: null,
    lastError: null,
    note: null,
    resolvedByName: null,
    resolvedAt: null,
    firstSeenAt: "2026-11-01T00:00:00.000Z",
    lastSeenAt: "2026-11-01T00:00:00.000Z",
    ...over,
  };
}

describe("progress and actionability", () => {
  it("counts resolved rows and leaves rejected matches out", () => {
    const progress = offboardingProgress([
      item({ status: "done" }),
      item({ status: "gone" }),
      item({ status: "failed" }),
      item({ status: "open", matchState: "unconfirmed" }),
      item({ status: "open", matchState: "rejected" }),
    ]);
    expect(progress).toEqual({ total: 4, resolved: 2, open: 1, failed: 1, unconfirmed: 1 });
  });

  it("offers no action on an unconfirmed or rejected match", () => {
    expect(offboardingItemActionable(item({ matchState: "unconfirmed" }))).toBe(false);
    expect(offboardingItemActionable(item({ matchState: "rejected" }))).toBe(false);
    expect(offboardingItemActionable(item({ matchState: "confirmed" }))).toBe(true);
    expect(offboardingItemActionable(item({ status: "done" }))).toBe(false);
    expect(offboardingItemActionable(item({ status: "failed" }))).toBe(true);
  });
});

describe("offboardingToCsv", () => {
  it("quotes every cell and neutralises formulas", () => {
    const offboarding: Offboarding = {
      id: "o",
      email: "jane.doe@example.com",
      name: "Jane Doe",
      userId: null,
      aliases: [],
      status: "open",
      source: "manual",
      sourceDetail: null,
      startedByName: null,
      note: null,
      createdAt: "2026-11-01T00:00:00.000Z",
      updatedAt: "2026-11-01T00:00:00.000Z",
      completedAt: null,
      lastScannedAt: null,
      scanTruncated: false,
      progress: { total: 1, resolved: 0, open: 1, failed: 0, unconfirmed: 0 },
      items: [item({ title: "=HYPERLINK(1)" })],
    };
    const csv = offboardingToCsv(offboarding);
    const [header, row] = csv.split("\r\n");
    expect(header?.startsWith('"Person","Offboarding status"')).toBe(true);
    expect(row).toContain('"\t=HYPERLINK(1)"');
    expect(csv.endsWith("\r\n")).toBe(true);
  });
});
