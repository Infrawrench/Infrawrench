import { describe, expect, it } from "vitest";
import {
  DEFAULT_ALERT_EMAIL_SETTINGS,
  alertEmailRecipientsError,
  alertEmailSettingsError,
  describeAlertEmailRecipients,
  destinationKey,
  isAlertEmailAddressAllowed,
  memberEmailDomains,
  normalizeAlertEmailAddress,
  normalizeAlertEmailDomain,
  normalizeAlertEmailRecipients,
  normalizeAlertEmailSettings,
} from "../index";

const ctx = {
  memberIds: new Set(["u1", "u2"]),
  settings: DEFAULT_ALERT_EMAIL_SETTINGS,
  memberDomains: ["acme.com"],
};

describe("alert email addresses", () => {
  it("normalizes and rejects malformed addresses", () => {
    expect(normalizeAlertEmailAddress("  Finance@Acme.COM ")).toBe("finance@acme.com");
    expect(normalizeAlertEmailAddress("not-an-address")).toBeNull();
    expect(normalizeAlertEmailAddress("a@b")).toBeNull();
    expect(normalizeAlertEmailAddress("a,b@acme.com")).toBeNull();
  });

  it("normalizes domains, tolerating a leading @", () => {
    expect(normalizeAlertEmailDomain("@Partner.io")).toBe("partner.io");
    expect(normalizeAlertEmailDomain("localhost")).toBeNull();
  });

  it("derives member domains", () => {
    expect(memberEmailDomains(["a@acme.com", "b@ACME.com", "c@other.io"])).toEqual([
      "acme.com",
      "other.io",
    ]);
  });
});

describe("external-address policy", () => {
  it("allows member domains and allowlisted domains by default", () => {
    expect(
      isAlertEmailAddressAllowed("x@acme.com", DEFAULT_ALERT_EMAIL_SETTINGS, ["acme.com"]),
    ).toBe(true);
    expect(
      isAlertEmailAddressAllowed("x@gmail.com", DEFAULT_ALERT_EMAIL_SETTINGS, ["acme.com"]),
    ).toBe(false);
    expect(
      isAlertEmailAddressAllowed(
        "x@partner.io",
        { externalPolicy: "member-domains", allowedDomains: ["partner.io"] },
        ["acme.com"],
      ),
    ).toBe(true);
  });

  it("does not let a subdomain ride on its parent", () => {
    expect(
      isAlertEmailAddressAllowed("x@mail.acme.com", DEFAULT_ALERT_EMAIL_SETTINGS, ["acme.com"]),
    ).toBe(false);
  });

  it("allows anything under `any`", () => {
    expect(
      isAlertEmailAddressAllowed("x@gmail.com", { externalPolicy: "any", allowedDomains: [] }, []),
    ).toBe(true);
  });
});

describe("recipient lists", () => {
  it("dedupes and lowercases", () => {
    expect(
      normalizeAlertEmailRecipients({
        userIds: ["u1", "u1"],
        addresses: ["A@acme.com", "a@acme.com", " "],
      }),
    ).toEqual({ userIds: ["u1"], addresses: ["a@acme.com"] });
  });

  it("names the first problem", () => {
    expect(
      alertEmailRecipientsError({ userIds: ["u1"], addresses: ["a@acme.com"] }, ctx),
    ).toBeNull();
    expect(alertEmailRecipientsError({ userIds: ["u9"], addresses: [] }, ctx)).toMatch(/u9/);
    expect(alertEmailRecipientsError({ userIds: [], addresses: ["nope"] }, ctx)).toMatch(/nope/);
    expect(alertEmailRecipientsError({ userIds: [], addresses: ["x@gmail.com"] }, ctx)).toMatch(
      /outside the domains/,
    );
  });

  it("enforces the limits", () => {
    const many = Array.from({ length: 21 }, (_, i) => `p${i}@acme.com`);
    expect(alertEmailRecipientsError({ userIds: [], addresses: many }, ctx)).toMatch(/At most 20/);
  });

  it("describes a list for a row", () => {
    const members = [{ userId: "u1", name: "Alice", email: "alice@acme.com" }];
    expect(describeAlertEmailRecipients({ userIds: ["u1"], addresses: [] }, members)).toBe("Alice");
    expect(
      describeAlertEmailRecipients(
        { userIds: ["u1", "gone"], addresses: ["a@acme.com", "b@acme.com"] },
        members,
      ),
    ).toBe("Alice, a former member and 2 more");
  });
});

describe("settings", () => {
  it("validates and normalizes", () => {
    expect(alertEmailSettingsError({ externalPolicy: "any", allowedDomains: [] })).toBeNull();
    expect(
      alertEmailSettingsError({ externalPolicy: "bogus" as "any", allowedDomains: [] }),
    ).toMatch(/externalPolicy/);
    expect(
      alertEmailSettingsError({
        externalPolicy: "member-domains",
        allowedDomains: ["not a domain"],
      }),
    ).toMatch(/not a domain/);
    expect(
      normalizeAlertEmailSettings({
        externalPolicy: "weird" as "any",
        allowedDomains: ["@B.io", "b.io"],
      }),
    ).toEqual({ externalPolicy: "member-domains", allowedDomains: ["b.io"] });
  });
});

describe("email destinations", () => {
  it("key members by id and addresses case-insensitively", () => {
    expect(destinationKey({ kind: "email-member", userId: "u1" })).toBe("email-member:u1");
    expect(destinationKey({ kind: "email-address", address: "A@Acme.com" })).toBe(
      "email-address:a@acme.com",
    );
  });
});
