import { describe, expect, it } from "vitest";
import { revnuConsentForAnalytics, revnuParentCookie } from "../revnu";

const ANON = `ra_${"ab".repeat(16)}`;

describe("revnuConsentForAnalytics", () => {
  it("maps a missing consent manager to granted and otherwise keeps the answer", () => {
    expect(revnuConsentForAnalytics("inactive")).toBe("granted");
    expect(revnuConsentForAnalytics("granted")).toBe("granted");
    expect(revnuConsentForAnalytics("denied")).toBe("denied");
    expect(revnuConsentForAnalytics("pending")).toBe("pending");
  });
});

describe("revnuParentCookie", () => {
  it("copies the visitor id onto the parent domain only after a grant", () => {
    expect(revnuParentCookie("granted", ANON, "infrawrench.com", "https:")).toBe(
      `revnu_aid=${ANON}; Domain=.infrawrench.com; Path=/; Max-Age=31536000; SameSite=Lax; Secure`,
    );
    expect(revnuParentCookie("granted", ANON, "app.infrawrench.com", "https:")).toContain(
      "Domain=.infrawrench.com",
    );
  });

  it("deletes the parent cookie on denial and leaves it alone while pending", () => {
    expect(revnuParentCookie("denied", ANON, "www.infrawrench.com", "https:")).toBe(
      "revnu_aid=; Domain=.infrawrench.com; Path=/; Max-Age=0; SameSite=Lax; Secure",
    );
    expect(revnuParentCookie("pending", ANON, "infrawrench.com", "https:")).toBeNull();
  });

  it("does not write the cookie off the site, without https, or for a bad id", () => {
    expect(revnuParentCookie("granted", ANON, "localhost", "http:")).toBeNull();
    expect(revnuParentCookie("granted", ANON, "example.com", "https:")).toBeNull();
    expect(revnuParentCookie("granted", "not-an-id", "infrawrench.com", "https:")).toBeNull();
    expect(revnuParentCookie("denied", null, "localhost", "https:")).toBeNull();
  });
});
