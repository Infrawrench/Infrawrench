import { describe, expect, it } from "vitest";
import { revnuConsentRefreshPath, revnuHeldPath } from "../analytics";

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

describe("revnuHeldPath", () => {
  it("keeps the tag off status pages and every path with a secret in it", () => {
    expect(revnuHeldPath("/status/acme")).toBe(true);
    expect(revnuHeldPath("/share/abc123")).toBe(true);
    expect(revnuHeldPath("/invite/abc123")).toBe(true);
    expect(revnuHeldPath("/org/org-1/by-token/abc123")).toBe(true);
  });

  it("gives the same answer when asked twice", () => {
    expect(revnuHeldPath("/share/abc123")).toBe(true);
    expect(revnuHeldPath("/share/abc123")).toBe(true);
  });

  it("allows ordinary app pages", () => {
    expect(revnuHeldPath("/")).toBe(false);
    expect(revnuHeldPath("/org/org-1/settings/billing")).toBe(false);
    expect(revnuHeldPath("/onboarding")).toBe(false);
  });
});
