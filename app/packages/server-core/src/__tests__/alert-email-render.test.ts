import { beforeAll, describe, expect, it, vi } from "vitest";

// `alerts/email.ts` imports the database client; the token functions never
// touch it, so an inert stub keeps this test I/O-free.
vi.mock("../db/client", () => ({ db: {} }));

import {
  alertEmailSubject,
  mrkdwnToHtml,
  mrkdwnToText,
  renderAlertEmail,
} from "../alerts/email-render";
import { signUnsubscribeToken, verifyUnsubscribeToken } from "../alerts/email";

beforeAll(() => {
  process.env["ENCRYPTION_MASTER_KEY"] = Buffer.alloc(32, 7).toString("base64");
});

describe("mrkdwn translation", () => {
  it("strips Slack markers for the text part", () => {
    expect(mrkdwnToText("*Budget* hit `prod_db` &amp; more <https://x.io|here>")).toBe(
      "Budget hit prod_db & more here (https://x.io)",
    );
  });

  it("leaves underscores alone", () => {
    expect(mrkdwnToText("my_cost_centre_ spend")).toBe("my_cost_centre_ spend");
  });

  it("escapes everything it does not rebuild", () => {
    const html = mrkdwnToHtml('*bold* <script>alert("x")</script> `a<b`');
    expect(html).toContain("<strong>bold</strong>");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("a&lt;b</code>");
  });

  it("rebuilds links with an escaped href", () => {
    expect(mrkdwnToHtml("see <https://x.io/a?b=1&c=2|the report>")).toContain(
      '<a href="https://x.io/a?b=1&amp;c=2" style="color:#2563eb;">the report</a>',
    );
  });
});

describe("renderAlertEmail", () => {
  const content = {
    orgName: "Acme",
    severity: "critical" as const,
    triggerLabel: "Budgets",
    title: 'Budget "Prod" at 100%',
    body: "infrawrench budget *Prod*: spend $1,000 has reached 100%",
    context: "2026-10 · spend",
    url: "https://app.example.com/org/o1/budgets/b1",
  };
  const footer = {
    recipient: "finance@acme.com",
    reason: 'you are on the recipient list of the budget "Prod"',
    manageUrl: "https://app.example.com/org/o1/settings/paging",
    unsubscribeUrl: "https://app.example.com/api/alert-email/unsubscribe?t=abc",
  };

  it("builds a bounded, prefixed subject", () => {
    expect(alertEmailSubject(content)).toBe('[Acme] Critical: Budget "Prod" at 100%');
    expect(alertEmailSubject({ ...content, title: "x".repeat(300) }).length).toBeLessThanOrEqual(
      200,
    );
  });

  it("carries the link, the reason and the unsubscribe link in both parts", () => {
    const out = renderAlertEmail(content, footer);
    for (const part of [out.text, out.html]) {
      expect(part).toContain("https://app.example.com/org/o1/budgets/b1");
      expect(part).toContain("finance@acme.com");
      expect(part).toContain("unsubscribe?t=abc");
      expect(part).toContain("settings/paging");
    }
    expect(out.text).not.toContain("*Prod*");
    expect(out.html).toContain("<strong>Prod</strong>");
  });

  it("drops the links it has no URL for", () => {
    const out = renderAlertEmail(
      { ...content, url: null },
      { ...footer, manageUrl: null, unsubscribeUrl: null },
    );
    expect(out.text).not.toContain("View in Infrawrench");
    expect(out.html).not.toContain("Unsubscribe");
  });
});

describe("unsubscribe tokens", () => {
  it("round-trips the org and the lowercased address", () => {
    const token = signUnsubscribeToken("org_1", "Finance@Acme.com");
    expect(verifyUnsubscribeToken(token)).toEqual({
      organizationId: "org_1",
      email: "finance@acme.com",
    });
  });

  it("rejects a tampered or truncated token", () => {
    const token = signUnsubscribeToken("org_1", "finance@acme.com");
    const forged = `${Buffer.from("org_2\nfinance@acme.com").toString("base64url")}.${token.split(".")[1]}`;
    expect(verifyUnsubscribeToken(forged)).toBeNull();
    expect(verifyUnsubscribeToken(token.slice(0, -2))).toBeNull();
    expect(verifyUnsubscribeToken("")).toBeNull();
    expect(verifyUnsubscribeToken(undefined)).toBeNull();
  });
});
