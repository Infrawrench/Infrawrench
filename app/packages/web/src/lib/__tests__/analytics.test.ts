import { describe, expect, it } from "vitest";
import { redactAppUrl } from "../analytics";

describe("redactAppUrl", () => {
  it("drops the query string and fragment", () => {
    expect(redactAppUrl("https://app.infrawrench.com/claim?code=abc123#x")).toBe(
      "https://app.infrawrench.com/claim",
    );
  });

  it("redacts token path segments", () => {
    expect(redactAppUrl("https://app.infrawrench.com/share/tok_1")).toBe(
      "https://app.infrawrench.com/share/[redacted]",
    );
    expect(redactAppUrl("/invite/abc")).toBe("/invite/[redacted]");
    expect(redactAppUrl("/api/invitations/by-token/abc")).toBe(
      "/api/invitations/by-token/[redacted]",
    );
    expect(redactAppUrl("/api/org/o1/shared-consoles/invites/abc/join")).toBe(
      "/api/org/o1/shared-consoles/invites/[redacted]/join",
    );
    expect(redactAppUrl("/api/issue-webhooks/linear/abc")).toBe(
      "/api/issue-webhooks/linear/[redacted]",
    );
  });

  it("leaves ordinary paths alone", () => {
    expect(redactAppUrl("https://app.infrawrench.com/org/o1/resources/r1")).toBe(
      "https://app.infrawrench.com/org/o1/resources/r1",
    );
  });
});
