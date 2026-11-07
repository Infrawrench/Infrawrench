import { hostClient } from "@infrawrench/plugin-base/effect";
import { describe, expect, it } from "vitest";
import { CreditAccessError, evaluateOrphanRule } from "@infrawrench/plugin-base";
import { TwilioClient, usageTriggerForm } from "../client.js";
import { PhoneNumberResourceType } from "../resource-types.js";
import { KEY, MAIN, SUB, makeHttp, page } from "./helpers.js";
import type { Reply } from "./helpers.js";

const ACCOUNT = "acct-1";

function client(
  route: (url: URL, method: string, form?: URLSearchParams) => Reply,
  apiKey = false,
) {
  const { http, calls } = makeHttp(route);
  const credentials: Record<string, string> = apiKey
    ? { accountSid: MAIN, apiKeySid: KEY, apiKeySecret: "s" }
    : { accountSid: MAIN, authToken: "t" };
  return { c: hostClient(new TwilioClient(credentials, { http } as never)), calls };
}

describe("credentials", () => {
  it("prefers an API key and validates SIDs", () => {
    const both = hostClient(
      new TwilioClient({
        accountSid: MAIN,
        apiKeySid: KEY,
        apiKeySecret: "s",
        authToken: "t",
      }),
    );
    expect(both.context.authMode).toBe("api-key");
    expect(() => hostClient(new TwilioClient({ accountSid: "nope", authToken: "t" }))).toThrow(
      /AC/,
    );
    expect(() => hostClient(new TwilioClient({ accountSid: MAIN }))).toThrow(/auth token/);
    expect(() => hostClient(new TwilioClient({ accountSid: MAIN, apiKeySid: KEY }))).toThrow(
      /secret/,
    );
  });
});

describe("a list answered with something else", () => {
  it("refuses a page with no list, rather than prune every trigger", async () => {
    const { c } = client(() => ({ body: { message: "maintenance" } }));
    await expect(c.listResources("usage-trigger", ACCOUNT)).rejects.toThrow(
      'it has no "usage_triggers", only an object with message',
    );
  });

  it("refuses it on a later page too", async () => {
    const { c } = client((url) =>
      url.searchParams.get("Page") === "1"
        ? { body: { message: "maintenance" } }
        : { body: { usage_triggers: [{ sid: "UT1" }], next_page_uri: "/next?Page=1" } },
    );
    await expect(c.listResources("usage-trigger", ACCOUNT)).rejects.toThrow("is not a list");
  });

  it("does not read a bad page of a service's numbers as a service with none", async () => {
    const { c } = client((url) =>
      url.pathname.endsWith("/PhoneNumbers")
        ? { body: { oops: true } }
        : { body: { services: [{ sid: "MG1" }], meta: {} } },
    );
    await expect(c.listResources("messaging-service", ACCOUNT)).rejects.toThrow(
      'it has no "phone_numbers"',
    );
  });
});

describe("a next link off Twilio's hosts", () => {
  it.each([
    ["another host", "https://evil.example/x.json"],
    ["a host glued onto Twilio's", ".evil.example/x.json"],
    ["plain http", "http://api.twilio.com/x.json"],
  ])("is refused on the classic API, with no request sent: %s", async (_name, link) => {
    const { c, calls } = client(() => ({
      body: { usage_triggers: [{ sid: "UT1" }], next_page_uri: link },
    }));
    await expect(c.listResources("usage-trigger", ACCOUNT)).rejects.toThrow(
      "Refusing to send the account's credentials there",
    );
    expect(calls).toHaveLength(1);
  });

  it("is refused on the v1 APIs too", async () => {
    const { c, calls } = client(() => ({
      body: { services: [{ sid: "VA1" }], meta: { next_page_url: "https://evil.example/x" } },
    }));
    await expect(c.listResources("verify-service", ACCOUNT)).rejects.toThrow(
      "the next page of /v2/Services is on https://evil.example, not https://verify.twilio.com",
    );
    expect(calls).toHaveLength(1);
  });

  it("is still followed when it stays on the host it came from", async () => {
    const { c, calls } = client((url) =>
      url.searchParams.get("Page") === "1"
        ? { body: { services: [{ sid: "VA2" }], meta: { next_page_url: null } } }
        : {
            body: {
              services: [{ sid: "VA1" }],
              meta: { next_page_url: "https://verify.twilio.com/v2/Services?Page=1" },
            },
          },
    );
    await expect(c.listResources("verify-service", ACCOUNT)).resolves.toHaveLength(2);
    expect(calls).toHaveLength(2);
  });
});

describe("a list past its cap", () => {
  it("refuses a list that goes on past 50 pages, rather than prune the rest", async () => {
    const { c, calls } = client(() => ({
      body: { usage_triggers: [{ sid: "UT1" }], next_page_uri: "/next.json?Page=1" },
    }));
    await expect(c.listResources("usage-trigger", ACCOUNT)).rejects.toThrow(
      "stopped at 50 pages (50 items)",
    );
    expect(calls).toHaveLength(50);
  });

  it("refuses more subaccounts than it can list numbers for, rather than drop their numbers", async () => {
    const subaccounts = Array.from({ length: 1001 }, (_, i) => ({
      sid: `AC${String(i + 1).padStart(32, "0")}`,
      status: "active",
    }));
    const { c } = client((url) =>
      url.pathname === "/2010-04-01/Accounts.json"
        ? { body: page("accounts", subaccounts) }
        : url.pathname === "/v1/Services"
          ? { body: { services: [], meta: {} } }
          : { body: page("incoming_phone_numbers", []) },
    );
    await expect(c.listResources("phone-number", ACCOUNT)).rejects.toThrow(
      "/2010-04-01/Accounts.json has more than Infrawrench reads. It stopped at 1000 items",
    );
  });

  it("reads numbers for more than the 100 subaccounts it used to stop at", async () => {
    const subaccounts = Array.from({ length: 150 }, (_, i) => ({
      sid: `AC${String(i + 1).padStart(32, "0")}`,
      status: "active",
    }));
    const { c, calls } = client((url) =>
      url.pathname === "/2010-04-01/Accounts.json"
        ? { body: page("accounts", subaccounts) }
        : url.pathname.endsWith("/IncomingPhoneNumbers.json")
          ? { body: page("incoming_phone_numbers", []) }
          : { body: { services: [], meta: {} } },
    );
    await c.listResources("phone-number", ACCOUNT);
    const listed = calls.filter((call) => call.url.pathname.endsWith("IncomingPhoneNumbers.json"));
    expect(listed).toHaveLength(151);
  });
});

describe("phone numbers", () => {
  const numbersRoute = (url: URL): Reply => {
    if (url.pathname === "/2010-04-01/Accounts.json") {
      return {
        body: page("accounts", [
          { sid: MAIN, friendly_name: "Main", status: "active" },
          { sid: SUB, friendly_name: "Acme", status: "active", owner_account_sid: MAIN },
        ]),
      };
    }
    if (url.hostname === "messaging.twilio.com" && url.pathname === "/v1/Services") {
      return {
        body: {
          services: [{ sid: "MG1", friendly_name: "Alerts" }],
          meta: { next_page_url: null },
        },
      };
    }
    if (url.pathname === "/v1/Services/MG1/PhoneNumbers") {
      return { body: { phone_numbers: [{ sid: "PN1" }], meta: { next_page_url: null } } };
    }
    if (url.pathname === `/2010-04-01/Accounts/${MAIN}/IncomingPhoneNumbers.json`) {
      return {
        body: page("incoming_phone_numbers", [
          {
            sid: "PN1",
            account_sid: MAIN,
            phone_number: "+14155550100",
            type: "local",
            capabilities: { voice: true, sms: true },
          },
          {
            sid: "PN2",
            account_sid: MAIN,
            phone_number: "+18005550100",
            type: "tollfree",
            capabilities: { voice: true },
            voice_url: "",
          },
        ]),
      };
    }
    if (url.pathname === `/2010-04-01/Accounts/${SUB}/IncomingPhoneNumbers.json`) {
      return {
        body: page("incoming_phone_numbers", [
          {
            sid: "PN3",
            account_sid: SUB,
            phone_number: "+447700900123",
            type: "mobile",
            sms_url: "https://x",
          },
        ]),
      };
    }
    if (url.hostname === "pricing.twilio.com") {
      const iso = url.pathname.split("/").pop();
      return {
        body: {
          iso_country: iso,
          price_unit: "USD",
          phone_number_prices: [
            { number_type: "local", current_price: "1.15" },
            { number_type: "toll free", current_price: "2.15" },
            { number_type: "mobile", current_price: "1.50" },
          ],
        },
      };
    }
    return { status: 404, body: { message: "unexpected" } };
  };

  it("lists main and subaccount numbers with price, service and orphan status", async () => {
    const { c } = client(numbersRoute);
    const list = await c.listResources("phone-number", ACCOUNT);
    expect(list.map((r) => r.externalId).sort()).toEqual(["PN1", "PN2", "PN3"]);
    const pn1 = list.find((r) => r.externalId === "PN1")!;
    expect(pn1.fields).toMatchObject({
      monthlyPrice: 1.15,
      isoCountry: "US",
      messagingServiceSid: "MG1",
      capabilities: "Voice, SMS",
    });
    const pn2 = list.find((r) => r.externalId === "PN2")!;
    expect(pn2.fields["monthlyPrice"]).toBe(2.15);
    expect(evaluateOrphanRule(PhoneNumberResourceType.orphanRule, pn2.fields)).toMatch(/billed/);
    expect(evaluateOrphanRule(PhoneNumberResourceType.orphanRule, pn1.fields)).toBeNull();
    const pn3 = list.find((r) => r.externalId === "PN3")!;
    expect(pn3.fields).toMatchObject({
      subaccountSid: SUB,
      subaccountName: "Acme",
      isoCountry: "GB",
    });
  });

  it("only lists main-account numbers with an API key", async () => {
    const { c, calls } = client(numbersRoute, true);
    const list = await c.listResources("phone-number", ACCOUNT);
    expect(list).toHaveLength(2);
    expect(calls.some((x) => x.url.pathname.includes(SUB))).toBe(false);
  });

  it("releases a number under the account that owns it", async () => {
    const { c, calls } = client((url, method) =>
      method === "DELETE" ? { status: 204 } : numbersRoute(url),
    );
    await c.deleteResource("phone-number", `${ACCOUNT}:phone-number:PN3`, ACCOUNT);
    const del = calls.find((x) => x.method === "DELETE");
    expect(del?.url.pathname).toBe(`/2010-04-01/Accounts/${SUB}/IncomingPhoneNumbers/PN3.json`);
  });
});

describe("usage triggers", () => {
  it("offers a category picker from this month's usage, common budgets first", async () => {
    const { c } = client((url) =>
      url.pathname.endsWith("/Usage/Records/ThisMonth.json")
        ? {
            body: page("usage_records", [
              { category: "sms", description: "SMS", price: "3", price_unit: "usd" },
              {
                category: "verify-push",
                description: "Verify Push",
                price: "0",
                price_unit: "usd",
              },
            ]),
          }
        : { status: 404 },
    );
    const cfg = await c.getCreateConfig("usage-trigger");
    const category = cfg.fields.find((f) => f.key === "usageCategory")!;
    expect(category.defaultValue).toBe("totalprice");
    const ids = category.options!.map((o) => o.id);
    expect(ids[0]).toBe("totalprice");
    expect(ids).toContain("verify-push");
    expect(ids.filter((i) => i === "sms")).toHaveLength(1);
  });

  it("creates a monthly budget trigger as a form post", async () => {
    const { c, calls } = client((url, method, form) =>
      method === "POST"
        ? {
            body: {
              sid: "UT1",
              usage_category: form?.get("UsageCategory"),
              trigger_by: form?.get("TriggerBy"),
              trigger_value: form?.get("TriggerValue"),
              recurring: form?.get("Recurring"),
              callback_url: form?.get("CallbackUrl"),
              current_value: "50",
            },
          }
        : { status: 404 },
    );
    const r = await c.createResource("usage-trigger", ACCOUNT, {
      usageCategory: "totalprice",
      triggerBy: "price",
      triggerValue: "100",
      recurring: "monthly",
      callbackUrl: "https://hooks.example.com/t",
    });
    const post = calls[0]!;
    expect(post.url.pathname).toBe(`/2010-04-01/Accounts/${MAIN}/Usage/Triggers.json`);
    expect(post.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    expect(post.form?.get("TriggerValue")).toBe("100");
    expect(r.fields).toMatchObject({ triggerValue: 100, currentValue: 50, recurring: "monthly" });
    await expect(
      c.createResource("usage-trigger", ACCOUNT, { triggerValue: "5", callbackUrl: "ftp://x" }),
    ).rejects.toThrow(/https/);
  });

  it("edits only the fields Twilio allows", () => {
    expect(
      usageTriggerForm({ friendlyName: "Budget", callbackUrl: "https://x", triggerValue: "9" }),
    ).toEqual({ FriendlyName: "Budget", CallbackUrl: "https://x" });
  });
});

describe("subaccounts and balance", () => {
  it("closes a subaccount on delete and suspends via action", async () => {
    const { c, calls } = client((_url, _m, form) => ({
      body: { sid: SUB, friendly_name: "Acme", status: form?.get("Status") ?? "active" },
    }));
    await c.deleteResource("subaccount", `${ACCOUNT}:subaccount:${SUB}`, ACCOUNT);
    await c.invokeAction("subaccount", `${ACCOUNT}:subaccount:${SUB}`, "suspend", ACCOUNT);
    expect(calls.map((x) => x.form?.get("Status"))).toEqual(["closed", "suspended"]);
  });

  it("reports the balance as a credit pot, and a permission gap as CreditAccessError", async () => {
    const ok = client(() => ({ body: { balance: "42.50", currency: "USD" } }));
    expect(await ok.c.fetchCreditBalance(ACCOUNT)).toEqual([
      { key: "USD", label: "Account balance (USD)", remaining: 42.5, currency: "USD" },
    ]);
    const denied = client(() => ({ status: 403, body: { message: "no", code: 20003 } }), true);
    await expect(denied.c.fetchCreditBalance(ACCOUNT)).rejects.toBeInstanceOf(CreditAccessError);
  });

  it("refuses to delete the API key the connection signs in with", async () => {
    const { c } = client(() => ({ status: 204 }), true);
    await expect(c.deleteResource("api-key", `${ACCOUNT}:api-key:${KEY}`, ACCOUNT)).rejects.toThrow(
      /signs in with/,
    );
  });
});

describe("metrics", () => {
  it("charts daily volume from usage records", async () => {
    const { c } = client((url) => {
      const category = url.searchParams.get("Category");
      const rec = (date: string, count: string, usage: string, price: string) => ({
        category,
        start_date: date,
        count,
        usage,
        price,
        price_unit: "usd",
      });
      return {
        body: page("usage_records", [
          rec("2026-09-01", "10", "20", "1.5"),
          rec("2026-09-02", "5", "7", "0.5"),
        ]),
      };
    });
    const series = await c.fetchMetricSeries("account", `${ACCOUNT}:account:${MAIN}`, ACCOUNT, {
      startMs: Date.parse("2026-09-01T00:00:00Z"),
      endMs: Date.parse("2026-09-02T23:00:00Z"),
    });
    expect(series.map((s) => s.label)).toEqual([
      "SMS sent",
      "SMS received",
      "MMS messages",
      "Calls",
      "Call minutes",
      "Spend",
    ]);
    expect(series.find((s) => s.label === "Spend")).toMatchObject({ unit: "USD" });
    expect(series.find((s) => s.label === "Call minutes")?.points[0]?.value).toBe(20);
  });
});
