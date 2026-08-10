import { describe, expect, it } from "vitest";
import {
  OWNERSHIP_LIMITS,
  formatTicketRef,
  toOwnerSummary,
  validateOwnershipPatch,
  validateTicketUrl,
  type ResourceOwnership,
} from "../ownership";

function record(patch: Partial<ResourceOwnership> = {}): ResourceOwnership {
  return {
    id: "own-1",
    resourceId: "res-1",
    accountId: "acc-1",
    pluginId: "hetzner",
    resourceTypeId: "volume",
    resourceName: "backups",
    ownerUserId: null,
    ownerName: null,
    ownerEmail: null,
    ownerLabel: null,
    purpose: null,
    ticketUrl: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...patch,
  };
}

describe("toOwnerSummary", () => {
  it("prefers the org member over a free-text label, and marks it routable", () => {
    const summary = toOwnerSummary(
      record({
        ownerUserId: "user-1",
        ownerName: "Sam Reyes",
        ownerLabel: "Platform team",
      }),
    );
    expect(summary).toEqual({
      userId: "user-1",
      displayName: "Sam Reyes",
      isLabel: false,
      ticketUrl: null,
      purpose: null,
    });
  });

  it("falls back to the email when the member has no display name", () => {
    const summary = toOwnerSummary(record({ ownerUserId: "user-1", ownerEmail: "sam@acme.com" }));
    expect(summary?.displayName).toBe("sam@acme.com");
    expect(summary?.isLabel).toBe(false);
  });

  it("falls back to the label when the member was removed — the row keeps its value", () => {
    // owner_user_id is nulled on user deletion; the label is why both columns exist.
    const summary = toOwnerSummary(record({ ownerUserId: null, ownerLabel: "Platform team" }));
    expect(summary).toEqual({
      userId: null,
      displayName: "Platform team",
      isLabel: true,
      ticketUrl: null,
      purpose: null,
    });
  });

  it("is null when only a purpose is recorded — there is still nobody to tell", () => {
    expect(toOwnerSummary(record({ purpose: "Staging load tests" }))).toBeNull();
  });

  it("is null for an all-whitespace label", () => {
    expect(toOwnerSummary(record({ ownerLabel: "   " }))).toBeNull();
  });

  it("carries purpose and ticket through for the surfaces that render them", () => {
    const summary = toOwnerSummary(
      record({
        ownerUserId: "user-1",
        ownerName: "Sam",
        purpose: "Load tests",
        ticketUrl: "https://linear.app/acme/issue/ENG-482",
      }),
    );
    expect(summary?.purpose).toBe("Load tests");
    expect(summary?.ticketUrl).toBe("https://linear.app/acme/issue/ENG-482");
  });
});

describe("validateTicketUrl", () => {
  it("treats an empty value as cleared, not invalid", () => {
    expect(validateTicketUrl("")).toBeNull();
    expect(validateTicketUrl("   ")).toBeNull();
  });

  it("accepts http and https", () => {
    expect(validateTicketUrl("https://github.com/acme/api/issues/482")).toBeNull();
    expect(validateTicketUrl("http://jira.internal/browse/ENG-1")).toBeNull();
  });

  it("rejects a bare reference that isn't a URL", () => {
    expect(validateTicketUrl("ENG-482")).toMatch(/full URL/);
  });

  it("rejects javascript: — the value is rendered as an href", () => {
    expect(validateTicketUrl("javascript:alert(1)")).toMatch(/http or https/);
  });
});

describe("validateOwnershipPatch", () => {
  it("requires a resource", () => {
    expect(validateOwnershipPatch({ resourceId: "" })).toMatch(/resource is required/);
  });

  it("accepts a patch that only touches one field", () => {
    expect(validateOwnershipPatch({ resourceId: "res-1", purpose: "Load tests" })).toBeNull();
  });

  it("does not check fields the patch omits", () => {
    // A purpose-only edit must not be rejected for a ticket recorded earlier.
    expect(validateOwnershipPatch({ resourceId: "res-1", purpose: "x" })).toBeNull();
  });

  it("enforces the length limits", () => {
    const long = "x".repeat(OWNERSHIP_LIMITS.maxPurposeLength + 1);
    expect(validateOwnershipPatch({ resourceId: "res-1", purpose: long })).toMatch(/limited to/);
  });

  it("accepts null for every optional field — that is how they are cleared", () => {
    expect(
      validateOwnershipPatch({
        resourceId: "res-1",
        ownerUserId: null,
        ownerLabel: null,
        purpose: null,
        ticketUrl: null,
      }),
    ).toBeNull();
  });
});

describe("formatTicketRef", () => {
  it("shortens a GitHub issue to owner/repo#n", () => {
    expect(formatTicketRef("https://github.com/acme/api/issues/482")).toBe("acme/api#482");
  });

  it("shortens a GitHub pull request the same way", () => {
    expect(formatTicketRef("https://github.com/acme/api/pull/17")).toBe("acme/api#17");
  });

  it("extracts a Linear issue key", () => {
    expect(formatTicketRef("https://linear.app/acme/issue/ENG-482/fix-the-thing")).toBe("ENG-482");
  });

  it("extracts a Jira issue key", () => {
    expect(formatTicketRef("https://acme.atlassian.net/browse/ENG-1")).toBe("ENG-1");
  });

  it("falls back to host/last-segment so the cell is never empty", () => {
    expect(formatTicketRef("https://notion.so/some-page")).toBe("notion.so/some-page");
  });

  it("falls back to the raw value when it isn't a URL", () => {
    expect(formatTicketRef("not a url")).toBe("not a url");
  });
});
