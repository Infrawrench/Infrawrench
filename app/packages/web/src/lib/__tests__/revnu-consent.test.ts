import { describe, expect, it } from "vitest";
import { revnuConsentRefreshPath } from "../analytics";

describe("revnuConsentRefreshPath", () => {
  it("targets the org the page is already in", () => {
    expect(revnuConsentRefreshPath("/org/org-1/settings/billing")).toBe(
      "/api/org/org-1/billing/measurement-consent",
    );
  });

  it("does not refresh from login, status, or the marketing site", () => {
    expect(revnuConsentRefreshPath("/login")).toBeNull();
    expect(revnuConsentRefreshPath("/status/acme")).toBeNull();
    expect(revnuConsentRefreshPath("/")).toBeNull();
  });
});
