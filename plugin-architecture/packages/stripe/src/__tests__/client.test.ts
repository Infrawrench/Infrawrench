import { describe, expect, it } from "vitest";
import { STRIPE_API_VERSION, encodeForm, formatMoney, fromMinor, listV1, toMinor } from "../api.js";
import { feeRows, serviceFromFeeDescription } from "../balance.js";
import { StripeClient, parseEventList, summariseSubscriptions } from "../client.js";
import { plugin } from "../plugin.js";
import { policyTemplate } from "../preflight.js";
import { mapComponent, parseStatusFeed } from "../status-feed.js";
import { stripeTerraformExport } from "../terraform.js";
import type { Call } from "./helpers.js";
import { makeHttp } from "./helpers.js";

const ACC = "acc";

function client(route: (call: Call) => unknown, extra: Record<string, unknown> = {}) {
  const { http, calls } = makeHttp(route);
  const c = new StripeClient({ apiKey: "rk_test_KEY" }, { http, ...extra } as never);
  return { c, calls };
}

describe("api", () => {
  it("form-encodes nested objects and arrays the way Stripe v1 expects", () => {
    const body = encodeForm({
      url: "https://x.test/hook",
      enabled_events: ["invoice.paid", "charge.failed"],
      recurring: { interval: "month", meter: undefined },
      description: null,
    });
    const params = new URLSearchParams(body);
    expect(params.get("enabled_events[0]")).toBe("invoice.paid");
    expect(params.get("enabled_events[1]")).toBe("charge.failed");
    expect(params.get("recurring[interval]")).toBe("month");
    expect(params.has("recurring[meter]")).toBe(false);
    expect(params.get("description")).toBe("");
  });

  it("knows zero- and three-decimal currencies", () => {
    expect(fromMinor(1999, "usd")).toBe(19.99);
    expect(fromMinor(500, "JPY")).toBe(500);
    expect(fromMinor(1500, "kwd")).toBe(1.5);
    expect(toMinor(19.99, "usd")).toBe(1999);
    expect(formatMoney(1234, "eur")).toBe("12.34 EUR");
  });

  it("pages v1 lists with starting_after and stops at has_more=false", async () => {
    const { http, calls } = makeHttp((call) => {
      const after = call.url.searchParams.get("starting_after");
      if (!after) return { data: [{ id: "a" }, { id: "b" }], has_more: true };
      return { data: [{ id: "c" }], has_more: false };
    });
    const out = await listV1<{ id: string }>({ apiKey: "k", http }, "/v1/products");
    expect(out.map((x) => x.id)).toEqual(["a", "b", "c"]);
    expect(calls[1]?.url.searchParams.get("starting_after")).toBe("b");
    expect(calls[0]?.url.searchParams.get("limit")).toBe("100");
  });

  it("sends Bearer auth and pins the API version", async () => {
    const { c, calls } = client(() => ({ data: [], has_more: false }));
    await c.listResources("stripe-webhook-endpoint", ACC);
    expect(calls[0]?.headers["Authorization"]).toBe("Bearer rk_test_KEY");
    expect(calls[0]?.headers["Stripe-Version"]).toBe(STRIPE_API_VERSION);
  });

  it("maps Stripe errors to errors carrying a numeric status", async () => {
    const { c } = client(() => ({
      status: 403,
      body: {
        error: {
          type: "invalid_request_error",
          message: "The provided key does not have the required permissions",
        },
      },
    }));
    const err = await c.listResources("stripe-webhook-endpoint", ACC).catch((e: unknown) => e);
    expect((err as { status: number }).status).toBe(403);
    expect(String(err)).toMatch(/required permissions/);
  });

  it("refuses publishable keys", () => {
    expect(() => new StripeClient({ apiKey: "pk_test_x" })).toThrow(/publishable/);
  });
});

describe("listing", () => {
  it("lists the account root with its balance", async () => {
    const { c } = client((call) => {
      if (call.url.pathname === "/v1/account") {
        return {
          id: "acct_1",
          email: "ops@acme.test",
          country: "US",
          default_currency: "usd",
          charges_enabled: true,
          payouts_enabled: true,
          business_profile: { name: "Acme" },
          requirements: {
            currently_due: ["external_account"],
            past_due: [],
            current_deadline: 1_900_000_000,
          },
        };
      }
      if (call.url.pathname === "/v1/balance") {
        return {
          available: [{ amount: 12345, currency: "usd" }],
          pending: [{ amount: 500, currency: "jpy" }],
        };
      }
      throw new Error(`unexpected ${call.url.pathname}`);
    });
    const [acct] = await c.listResources("stripe-account", ACC);
    expect(acct?.id).toBe("acc:stripe-account:acct_1");
    expect(acct?.displayName).toBe("Acme");
    expect(acct?.fields["availableBalance"]).toBe("123.45 USD");
    expect(acct?.fields["pendingBalance"]).toBe("500 JPY");
    expect(acct?.fields["requirementsDue"]).toBe(1);
    expect(acct?.fields["mode"]).toBe("test");
    expect(String(acct?.fields["requirementsDeadline"])).toMatch(/^2030-/);
    const sidebar = c.renderSidebarItem(acct!);
    expect(sidebar.status).toMatchObject({ status: "degraded" });
  });

  it("lists no connected accounts on a non-platform account instead of failing", async () => {
    const { c } = client(() => ({
      status: 400,
      body: { error: { message: "This application is not a Connect platform." } },
    }));
    await expect(c.listResources("stripe-connected-account", ACC)).resolves.toEqual([]);
  });

  it("still fails a connected-account listing on a bad key", async () => {
    const { c } = client(() => ({ status: 401, body: { error: { message: "Invalid API Key" } } }));
    await expect(c.listResources("stripe-connected-account", ACC)).rejects.toMatchObject({
      status: 401,
    });
  });

  it("lists v2 event destinations by following next_page_url and asks for the URL", async () => {
    const { c, calls } = client((call) => {
      if (call.url.searchParams.get("page") === "p2") {
        return {
          data: [{ id: "ed_2", name: "two", type: "amazon_eventbridge", status: "enabled" }],
          next_page_url: null,
        };
      }
      return {
        data: [
          {
            id: "ed_1",
            name: "one",
            type: "webhook_endpoint",
            event_payload: "thin",
            enabled_events: ["v1.billing.meter.error_report_triggered"],
            status: "disabled",
            status_details: { disabled: { reason: "user" } },
            webhook_endpoint: { url: "https://x.test/h" },
          },
        ],
        next_page_url: "/v2/core/event_destinations?page=p2",
      };
    });
    const out = await c.listResources("stripe-event-destination", ACC);
    expect(out.map((r) => r.externalId)).toEqual(["ed_1", "ed_2"]);
    expect(calls[0]?.url.searchParams.get("include[0]")).toBe("webhook_endpoint.url");
    expect(out[0]?.fields["url"]).toBe("https://x.test/h");
    expect(c.renderSidebarItem(out[0]!).status).toMatchObject({ status: "degraded" });
  });

  it("parents prices under their product and describes metered amounts", async () => {
    const { c } = client(() => ({
      data: [
        {
          id: "price_1",
          product: "prod_1",
          currency: "usd",
          unit_amount_decimal: "0.25",
          billing_scheme: "per_unit",
          type: "recurring",
          recurring: {
            interval: "month",
            interval_count: 1,
            usage_type: "metered",
            meter: "mtr_1",
          },
        },
      ],
      has_more: false,
    }));
    const [price] = await c.listResources("stripe-price", ACC);
    expect(price?.parentResourceId).toBe("acc:stripe-product:prod_1");
    expect(price?.fields["meterId"]).toBe("mtr_1");
    expect(price?.fields["amount"]).toBe("0.0025 USD per unit / month");
  });
});

describe("webhook endpoints", () => {
  it("creates with the picked events and keeps the one-time signing secret", async () => {
    const stored: Record<string, string> = {};
    const secrets = {
      getPlaintext: async (id: string, key: string) => stored[`${id}|${key}`] ?? null,
      setPlaintext: async (id: string, key: string, value: string) => {
        stored[`${id}|${key}`] = value;
      },
    };
    const { c, calls } = client(
      () => ({
        id: "we_1",
        url: "https://x.test/h",
        enabled_events: ["invoice.paid", "charge.failed"],
        status: "enabled",
        secret: "whsec_abc",
      }),
      { secrets },
    );
    const created = (await c.createResource("stripe-webhook-endpoint", ACC, {
      url: "https://x.test/h",
      enabledEvents: JSON.stringify(["invoice.paid", "charge.failed"]),
      connect: "false",
      apiVersion: "",
    })) as { id: string; secretStates: unknown[] };
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    expect(calls[0]?.form.get("enabled_events[1]")).toBe("charge.failed");
    expect(calls[0]?.form.has("connect")).toBe(false);
    expect(created.secretStates).toEqual([
      { fieldKey: "signingSecret", resolution: { kind: "plaintext", value: "whsec_abc" } },
    ]);
    await expect(
      c.resolveOutput("stripe-webhook-endpoint", created.id, "signingSecret", ACC),
    ).resolves.toBe("whsec_abc");
  });

  it("explains a missing secret for endpoints made elsewhere", async () => {
    const { c } = client(() => ({}), { secrets: { getPlaintext: async () => null } });
    await expect(
      c.resolveOutput(
        "stripe-webhook-endpoint",
        "acc:stripe-webhook-endpoint:we_9",
        "signingSecret",
        ACC,
      ),
    ).rejects.toThrow(/Dashboard/);
  });

  it("edits events from a comma list and maps status to disabled", async () => {
    const { c, calls } = client(() => ({
      id: "we_1",
      status: "disabled",
      enabled_events: ["a.b"],
    }));
    await c.updateResource("stripe-webhook-endpoint", "acc:stripe-webhook-endpoint:we_1", ACC, {
      enabledEvents: "invoice.paid, charge.failed",
      status: "disabled",
    });
    expect(calls[0]?.url.pathname).toBe("/v1/webhook_endpoints/we_1");
    expect(calls[0]?.form.get("enabled_events[0]")).toBe("invoice.paid");
    expect(calls[0]?.form.get("disabled")).toBe("true");
  });

  it("parses picker JSON and comma lists alike", () => {
    expect(parseEventList('["a.b","c.d"]')).toEqual(["a.b", "c.d"]);
    expect(parseEventList("a.b, c.d\ne.f")).toEqual(["a.b", "c.d", "e.f"]);
    expect(parseEventList("")).toEqual([]);
  });
});

describe("event destinations", () => {
  it("creates a thin webhook destination as JSON and asks for the signing secret", async () => {
    const { c, calls } = client(() => ({
      id: "ed_1",
      name: "billing",
      type: "webhook_endpoint",
      event_payload: "thin",
      webhook_endpoint: { url: "https://x.test/h", signing_secret: "whsec_v2" },
    }));
    const created = (await c.createResource("stripe-event-destination", ACC, {
      name: "billing",
      type: "webhook_endpoint",
      eventPayload: "thin",
      thinEvents: JSON.stringify(["v1.billing.meter.error_report_triggered"]),
      eventsFrom: "@self",
      url: "https://x.test/h",
    })) as { secretStates: Array<{ resolution: { value: string } }> };
    expect(calls[0]?.url.pathname).toBe("/v2/core/event_destinations");
    expect(calls[0]?.json).toMatchObject({
      type: "webhook_endpoint",
      event_payload: "thin",
      enabled_events: ["v1.billing.meter.error_report_triggered"],
      events_from: ["@self"],
      webhook_endpoint: { url: "https://x.test/h" },
      include: ["webhook_endpoint.signing_secret", "webhook_endpoint.url"],
    });
    expect(created.secretStates[0]?.resolution.value).toBe("whsec_v2");
  });

  it("validates the AWS account for EventBridge", async () => {
    const { c } = client(() => ({}));
    await expect(
      c.createResource("stripe-event-destination", ACC, {
        name: "eb",
        type: "amazon_eventbridge",
        eventPayload: "snapshot",
        snapshotEvents: '["*"]',
        awsAccountId: "12",
      }),
    ).rejects.toThrow(/12-digit/);
  });

  it("pings through the v2 action route", async () => {
    const { c, calls } = client(() => ({ id: "evt_1" }));
    await c.invokeAction(
      "stripe-event-destination",
      "acc:stripe-event-destination:ed_1",
      "ping",
      ACC,
    );
    expect(calls[0]?.url.pathname).toBe("/v2/core/event_destinations/ed_1/ping");
    expect(calls[0]?.method).toBe("POST");
  });
});

describe("prices and products", () => {
  it("creates a metered price with a sub-cent amount as a decimal", async () => {
    const { c, calls } = client(() => ({ id: "price_9", product: "prod_1", currency: "usd" }));
    await c.createResource(
      "stripe-price",
      ACC,
      {
        currency: "usd",
        amount: "0.0025",
        type: "recurring",
        interval: "month",
        intervalCount: "1",
        usageType: "metered",
        meterId: "mtr_1",
      },
      "acc:stripe-product:prod_1",
    );
    const form = calls[0]!.form;
    expect(form.get("product")).toBe("prod_1");
    expect(form.get("unit_amount_decimal")).toBe("0.25");
    expect(form.has("unit_amount")).toBe(false);
    expect(form.get("recurring[usage_type]")).toBe("metered");
    expect(form.get("recurring[meter]")).toBe("mtr_1");
  });

  it("creates whole-cent prices as unit_amount", async () => {
    const { c, calls } = client(() => ({ id: "price_9" }));
    await c.createResource("stripe-price", ACC, {
      productId: "prod_1",
      currency: "usd",
      amount: "19.99",
      type: "one_time",
    });
    expect(calls[0]?.form.get("unit_amount")).toBe("1999");
    expect(calls[0]?.form.has("recurring[interval]")).toBe(false);
  });

  it("explains why a product with prices cannot be deleted", async () => {
    const { c } = client(() => ({
      status: 400,
      body: { error: { message: "This product cannot be deleted" } },
    }));
    await expect(
      c.deleteResource("stripe-product", "acc:stripe-product:prod_1", ACC),
    ).rejects.toThrow(/Archive/);
  });
});

describe("fees as cost", () => {
  it("files processing fees, fee tax, refunds and Stripe fee transactions", () => {
    const day = Date.parse("2026-09-01T12:00:00Z") / 1000;
    const rows = feeRows([
      {
        type: "charge",
        reporting_category: "charge",
        currency: "usd",
        created: day,
        amount: 10000,
        fee_details: [
          { type: "stripe_fee", amount: 320 },
          { type: "tax", amount: 30 },
          { type: "application_fee", amount: 500 },
        ],
      },
      {
        type: "refund",
        reporting_category: "refund",
        currency: "usd",
        created: day,
        amount: -10000,
        fee_details: [{ type: "stripe_fee", amount: -20 }],
      },
      {
        type: "stripe_fee",
        currency: "usd",
        created: day,
        amount: -700,
        description: "Billing - Usage Fee (2026-08-01 - 2026-08-31)",
      },
      { type: "stripe_fx_fee", currency: "eur", created: day, amount: -100 },
    ]);
    const find = (service: string, chargeType?: string) =>
      rows.find((r) => r.service === service && r.chargeType === chargeType);
    expect(find("Payments")?.amount).toBe(3.2);
    expect(find("Payments", "tax")?.amount).toBe(0.3);
    expect(find("Payments", "refund")?.amount).toBe(-0.2);
    expect(find("Billing")?.amount).toBe(7);
    expect(find("Currency conversion")).toMatchObject({ amount: 1, currency: "EUR" });
    expect(rows.some((r) => r.tags?.["feeType"] === "application_fee")).toBe(false);
    expect(rows.every((r) => r.date === "2026-09-01")).toBe(true);
  });

  it("names Stripe fee products from their descriptions", () => {
    expect(serviceFromFeeDescription("Radar for Fraud Teams: 1,204 screened")).toBe(
      "Radar for Fraud Teams",
    );
    expect(serviceFromFeeDescription("Connect (2026-09-01 - 2026-09-30): Active Accounts")).toBe(
      "Connect",
    );
    expect(serviceFromFeeDescription("")).toBe("Stripe fees");
  });

  it("pages balance transactions per day", async () => {
    const { c, calls } = client(() => ({ data: [], has_more: false }));
    await c.fetchCostData(ACC, { fromDate: "2026-01-01", toDate: "2026-01-03" });
    expect(calls).toHaveLength(3);
    const gte = calls.map((x) => Number(x.url.searchParams.get("created[gte]"))).sort();
    expect(gte[0]).toBe(Date.parse("2026-01-01T00:00:00Z") / 1000);
    expect(
      Number(calls[0]!.url.searchParams.get("created[lt]")) -
        Number(calls[0]!.url.searchParams.get("created[gte]")),
    ).toBe(86400);
  });
});

describe("subscriptions overview", () => {
  it("normalises licensed items to monthly revenue and skips metered ones", () => {
    const out = summariseSubscriptions(
      [
        {
          status: "active",
          items: {
            data: [
              {
                quantity: 3,
                price: {
                  currency: "usd",
                  unit_amount: 1000,
                  recurring: { interval: "month", usage_type: "licensed" },
                },
              },
              { price: { currency: "usd", unit_amount: 12000, recurring: { interval: "year" } } },
              {
                price: {
                  currency: "usd",
                  unit_amount: 1,
                  recurring: { interval: "month", usage_type: "metered" },
                },
              },
            ],
          },
        },
        { status: "canceled", cancel_at_period_end: false, items: { data: [] } },
        { status: "trialing", cancel_at_period_end: true, items: { data: [] } },
      ],
      false,
    );
    expect(out.byStatus).toEqual({ active: 1, canceled: 1, trialing: 1 });
    expect(out.mrrMinor["USD"]).toBe(4000);
    expect(out.cancelingAtPeriodEnd).toBe(1);
  });
});

describe("meter metrics", () => {
  it("finds customers through the meter's prices and charts their daily usage", async () => {
    const { c, calls } = client((call) => {
      if (call.url.pathname === "/v1/prices") {
        return {
          data: [
            { id: "price_1", recurring: { meter: "mtr_1" } },
            { id: "price_2", recurring: { meter: "mtr_x" } },
          ],
          has_more: false,
        };
      }
      if (call.url.pathname === "/v1/subscriptions") {
        expect(call.url.searchParams.get("price")).toBe("price_1");
        return {
          data: [{ id: "sub_1", customer: { id: "cus_1", name: "Acme" } }],
          has_more: false,
        };
      }
      if (call.url.pathname === "/v1/billing/meters/mtr_1/event_summaries") {
        expect(call.url.searchParams.get("customer")).toBe("cus_1");
        expect(call.url.searchParams.get("value_grouping_window")).toBe("day");
        expect(Number(call.url.searchParams.get("start_time")) % 86400).toBe(0);
        return {
          data: [{ id: "s1", start_time: 1_700_006_400, aggregated_value: 42 }],
          has_more: false,
        };
      }
      throw new Error(call.url.pathname);
    });
    const series = await c.fetchMetricSeries("stripe-meter", "acc:stripe-meter:mtr_1", ACC, {
      startMs: Date.parse("2026-09-01T05:00:00Z"),
      endMs: Date.parse("2026-09-10T05:00:00Z"),
    });
    expect(series).toEqual([
      {
        label: "Usage: Acme",
        unit: "units",
        points: [{ timestamp: 1_700_006_400_000, value: 42 }],
      },
    ]);
    expect(calls.some((x) => x.url.searchParams.get("price") === "price_2")).toBe(false);
  });
});

describe("logs", () => {
  it("lists failed deliveries oldest first", async () => {
    const { c, calls } = client(() => ({
      data: [
        {
          id: "evt_2",
          type: "invoice.paid",
          created: 1_800_000_100,
          pending_webhooks: 1,
          data: { object: { id: "in_2" } },
        },
        {
          id: "evt_1",
          type: "invoice.paid",
          created: 1_800_000_000,
          pending_webhooks: 2,
          data: { object: { id: "in_1" } },
        },
      ],
      has_more: false,
    }));
    const out = await c.getLogs("stripe-account", "acc:stripe-account:acct_1", ACC, {
      container: "Failed webhook deliveries",
      tailLines: 10,
    });
    expect(calls[0]?.url.searchParams.get("delivery_success")).toBe("false");
    expect(out.text.split("\n")[0]).toContain("evt_1");
    expect(out.activeContainer).toBe("Failed webhook deliveries");
  });
});

describe("preflight", () => {
  it("reports a restricted key's missing permission and keeps going", async () => {
    const { c } = client((call) => {
      if (call.url.pathname === "/v1/account") return { id: "acct_1" };
      if (call.url.pathname === "/v1/payouts")
        return { status: 403, body: { error: { message: "needs rak_payout_read" } } };
      if (call.url.pathname === "/v1/sigma/scheduled_query_runs")
        return { status: 404, body: { error: { message: "Unrecognized request URL" } } };
      return { data: [], has_more: false };
    });
    const result = await c.verifyCredentials();
    expect(result.identity).toBe("acct_1");
    expect(result.checks.find((x) => x.capabilityId === "payouts")).toMatchObject({
      status: "missing",
    });
    expect(result.checks.find((x) => x.capabilityId === "sigma")).toMatchObject({
      status: "unknown",
    });
    expect(result.checks.find((x) => x.capabilityId === "webhooks")).toMatchObject({
      status: "ok",
    });
  });

  it("templates the permissions to tick", () => {
    const t = policyTemplate(["webhooks", "products"]);
    expect(t.document.split("\n")).toEqual([
      "Webhook Endpoints: Write",
      "Products: Write",
      "Prices: Write",
    ]);
  });
});

describe("status feed", () => {
  it("treats the API component as provider-wide and ignores third-party acquirers", () => {
    expect(mapComponent("Stripe API")).toMatchObject({ providerWide: true });
    expect(mapComponent("Acquirers and payment methods")).toBeNull();
    expect(mapComponent("Revenue and finance automation")?.resourceTypes).toContain("stripe-meter");
  });

  it("parses an unresolved Statuspage incident", () => {
    const body = JSON.stringify({
      page: { id: "d5zv7xbys5v3", name: "Stripe", url: "https://www.stripestatus.com" },
      incidents: [
        {
          id: "inc1",
          name: "Elevated API errors",
          status: "investigating",
          impact: "major",
          created_at: "2026-10-06T10:00:00Z",
          updated_at: "2026-10-06T10:05:00Z",
          shortlink: "https://stspg.io/x",
          components: [{ name: "Stripe API" }],
          incident_updates: [],
        },
      ],
    });
    const [incident] = parseStatusFeed(body);
    expect(incident?.title).toBe("Elevated API errors");
  });
});

describe("terraform", () => {
  it("exports a recurring metered price with a recurring block", () => {
    const out = stripeTerraformExport.mapResource({
      id: "acc:stripe-price:price_1",
      pluginId: "stripe",
      resourceTypeId: "stripe-price",
      accountId: ACC,
      displayName: "Per request",
      externalId: "price_1",
      fields: {
        currency: "USD",
        unitAmount: 2,
        billingScheme: "per_unit",
        productId: "prod_1",
        interval: "month",
        intervalCount: 1,
        usageType: "metered",
        meterId: "mtr_1",
        taxBehavior: "unspecified",
        active: true,
      },
      resolvedOutputs: {},
      secretStates: [],
      createdAt: "",
      updatedAt: "",
    });
    expect(out?.resource.type).toBe("stripe_price");
    expect(out?.resource.importId).toBe("price_1");
    expect(out?.resource.attributes["currency"]).toEqual({ kind: "string", value: "usd" });
    expect(out?.resource.attributes["recurring"]).toMatchObject({ kind: "block" });
    expect(out?.resource.attributes["tax_behavior"]).toBeUndefined();
  });

  it("declares the official provider", () => {
    expect(plugin.terraformExport?.provider.source).toBe("stripe/stripe");
  });
});
