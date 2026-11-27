import Stripe from "stripe";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { signGitUsernameCheckoutToken } from "@infrawrench/client-core";
import { buildTestApi } from "@/http/testing";

/**
 * Paying for a short username on git.infrawrench.com, the app's half: the
 * route the forge sends the browser to opens a Checkout session for the hold
 * its token names, and a settled payment claims the name once, whether the
 * webhook or the browser's return reports it, or is refunded when the name
 * is gone. Stripe is a fake throughout, except its webhook signature check,
 * which is the library's own over a locally signed test payload.
 *
 * What the database does with a payment (the unique index per session, the
 * rows of a claim) is the forge's db suite, `short-usernames.test.ts`.
 */

const KEY = "test-job-token-key-of-at-least-32-characters";
const WEBHOOK_SECRET = "whsec_test_secret";
const realStripe = new Stripe("sk_test_not_a_real_key");

const sessionsCreate = vi.fn();
const sessionsRetrieve = vi.fn();
const refundsCreate = vi.fn();
const priceId = vi.fn<() => Promise<string | null>>();
const subscriptionsRetrieve = vi.fn();
const fakeStripe = {
  webhooks: realStripe.webhooks,
  checkout: {
    sessions: {
      create: (...a: unknown[]) => sessionsCreate(...a),
      retrieve: (...a: unknown[]) => sessionsRetrieve(...a),
    },
  },
  refunds: { create: (...a: unknown[]) => refundsCreate(...a) },
  subscriptions: { retrieve: (...a: unknown[]) => subscriptionsRetrieve(...a) },
};

// Whole, never spread from the real module: nothing here may reach Stripe.
vi.mock("@/services/stripe", () => ({
  getStripe: () => fakeStripe,
  getStripeWebhookSecret: () => WEBHOOK_SECRET,
  getStripeGitShortUsernamePriceId: () => priceId(),
}));

const queuePaidCheckout = vi.fn();
vi.mock("@/services/revnu-checkout", () => ({
  queuePaidCheckout: (...a: unknown[]) => queuePaidCheckout(...a),
}));

const logAudit = vi.fn();
vi.mock("@/services/audit", () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));

const billingWrites = vi.fn();
vi.mock("@/db/client", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({ limit: () => Promise.resolve([{ email: "ada@example.test" }]) }),
      }),
    }),
    update: () => ({
      set: () => ({
        where: () => {
          billingWrites();
          return Promise.resolve();
        },
      }),
    }),
  },
}));

const recordCapacity = vi.fn();
vi.mock("@infrawrench/server-core/billing/capacity-slots", () => ({
  recordCapacitySlotPurchase: (...a: unknown[]) => recordCapacity(...a),
  refundCapacitySlots: () => Promise.resolve(0),
}));

/** The shared tables, as far as these routes read and write them. */
interface Hold {
  id: string;
  userId: string;
  slug: string;
  returnPath: string;
  stripeCheckoutSessionId: string | null;
  workspaceOrganizationId: string | null;
}
const holds = new Map<string, Hold>();
const purchases = new Map<string, { status: string; kind: string; slug: string }>();
const claimed = new Map<string, string>();
/** Names someone else has by the time a payment settles. */
const taken = new Set<string>();
const attach = vi.fn();
const complete = vi.fn();

vi.mock("@infrawrench/server-core/git/short-usernames", () => ({
  gitUsernameHoldFor: async (id: string, userId: string) => {
    const hold = holds.get(id);
    return hold && hold.userId === userId ? hold : null;
  },
  attachGitUsernameCheckout: async (id: string, sessionId: string, expiresAt: Date) => {
    attach(id, sessionId, expiresAt);
    const hold = holds.get(id);
    if (hold) hold.stripeCheckoutSessionId = sessionId;
    return hold !== undefined;
  },
  completeGitUsernamePurchase: async (payment: {
    userId: string;
    slug: string;
    holdId: string | null;
    stripeCheckoutSessionId: string;
  }) => {
    complete(payment);
    const existing = purchases.get(payment.stripeCheckoutSessionId);
    const base = {
      slug: payment.slug,
      connectedOrganizationId: null,
      namespaceId: null,
      returnPath: null,
    };
    if (existing) return { ...base, status: existing.status, first: false };
    const hold = payment.holdId ? holds.get(payment.holdId) : undefined;
    const status = taken.has(payment.slug) ? "refund_due" : "claimed";
    purchases.set(payment.stripeCheckoutSessionId, { status, kind: "claim", slug: payment.slug });
    if (status === "claimed") {
      claimed.set(payment.userId, payment.slug);
      if (hold) holds.delete(hold.id);
    }
    return {
      ...base,
      status,
      first: true,
      namespaceId: status === "claimed" ? "ns-1" : null,
      connectedOrganizationId:
        status === "claimed" ? (hold?.workspaceOrganizationId ?? null) : null,
      returnPath: hold?.returnPath ?? null,
    };
  },
  markGitUsernamePurchaseRefunded: async (sessionId: string) => {
    const purchase = purchases.get(sessionId);
    if (purchase?.status === "refund_due") purchase.status = "refunded";
  },
  gitUsernamePurchaseBySession: async (sessionId: string) => purchases.get(sessionId) ?? null,
}));

const { gitUsernameCheckoutDomain } = await import("@/http/domains/git-username-checkout/index");
const { stripeWebhookDomain } = await import("@/http/domains/stripe-webhook/index");
const checkout = buildTestApi(gitUsernameCheckoutDomain, { permissions: [] });
const webhook = buildTestApi(stripeWebhookDomain, { basePath: "/api/v1/webhooks/stripe" });

const FORGE = "https://git.example.test";

function hold(overrides: Partial<Hold> = {}): Hold {
  const row: Hold = {
    id: "hold-1",
    userId: "user-ada",
    slug: "ada",
    returnPath: "/onboarding/username?returnTo=%2Facme%2Finfra",
    stripeCheckoutSessionId: null,
    workspaceOrganizationId: null,
    ...overrides,
  };
  holds.set(row.id, row);
  return row;
}

const tokenFor = (row: Hold, now?: number) =>
  signGitUsernameCheckoutToken(KEY, { holdId: row.id, userId: row.userId }, now);

const open = (token?: string) =>
  checkout.request(
    `/api/git-username-checkout${token === undefined ? "" : `?token=${encodeURIComponent(token)}`}`,
  );

/** A Checkout session as Stripe sends it once the card has been charged. */
function paidSession(row: Hold, overrides: Record<string, unknown> = {}) {
  return {
    id: "cs_test_username_1",
    object: "checkout.session",
    mode: "payment",
    payment_status: "paid",
    status: "complete",
    payment_intent: "pi_test_1",
    amount_total: 5000,
    currency: "usd",
    client_reference_id: row.userId,
    metadata: {
      kind: "git_short_username",
      userId: row.userId,
      username: row.slug,
      holdId: row.id,
    },
    ...overrides,
  };
}

/** A delivery signed as Stripe signs one, so the library's own check passes. */
function deliver(object: Record<string, unknown>, options: { secret?: string } = {}) {
  const payload = JSON.stringify({
    id: "evt_test_1",
    object: "event",
    type: "checkout.session.completed",
    created: 1_800_000_000,
    data: { object },
  });
  const signature = realStripe.webhooks.generateTestHeaderString({
    payload,
    secret: options.secret ?? WEBHOOK_SECRET,
  });
  return webhook.request("", {
    method: "POST",
    body: payload,
    headers: { "stripe-signature": signature },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  holds.clear();
  purchases.clear();
  claimed.clear();
  taken.clear();
  process.env["GIT_JOB_TOKEN_KEY"] = KEY;
  process.env["STRIPE_SECRET_KEY"] = "sk_test_not_a_real_key";
  priceId.mockResolvedValue("price_test_short");
  process.env["GIT_BASE_URL"] = FORGE;
  process.env["APP_URL"] = "https://app.example.test";
  sessionsCreate.mockResolvedValue({
    id: "cs_test_username_1",
    url: "https://checkout.stripe.test/c/pay/cs_test_username_1",
  });
  refundsCreate.mockResolvedValue({ id: "re_test_1" });
  queuePaidCheckout.mockResolvedValue(undefined);
});

describe("GET /api/git-username-checkout", () => {
  it("opens a one-time payment for the hold the token names, and keeps the hold until it closes", async () => {
    const row = hold();
    const before = Math.floor(Date.now() / 1000);
    const res = await open(await tokenFor(row));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(
      "https://checkout.stripe.test/c/pay/cs_test_username_1",
    );
    const metadata = {
      kind: "git_short_username",
      userId: "user-ada",
      username: "ada",
      holdId: "hold-1",
    };
    const [params] = sessionsCreate.mock.calls[0]!;
    expect(params).toMatchObject({
      mode: "payment",
      line_items: [{ price: "price_test_short", quantity: 1 }],
      customer_email: "ada@example.test",
      client_reference_id: "user-ada",
      metadata,
      payment_intent_data: { metadata },
      success_url:
        "https://app.example.test/api/git-username-checkout/return?session_id={CHECKOUT_SESSION_ID}",
      cancel_url: `${FORGE}/onboarding/username?returnTo=%2Facme%2Finfra&checkout=cancelled`,
    });
    // Stripe's minimum is 30 minutes; the hold outlasts the session.
    expect(params.expires_at).toBeGreaterThanOrEqual(before + 30 * 60);
    const [holdId, sessionId, until] = attach.mock.calls[0]!;
    expect([holdId, sessionId]).toEqual(["hold-1", "cs_test_username_1"]);
    expect((until as Date).getTime()).toBeGreaterThan(params.expires_at * 1000);
  });

  it("says payments are unavailable when the account has no price for it", async () => {
    priceId.mockResolvedValue(null);
    const res = await open(await tokenFor(hold({ returnPath: "/settings" })));
    expect(res.headers.get("location")).toBe(`${FORGE}/settings?checkout=unavailable`);
    expect(sessionsCreate).not.toHaveBeenCalled();
  });

  it("opens the same page when the link is followed twice", async () => {
    const row = hold({ stripeCheckoutSessionId: "cs_test_open" });
    sessionsRetrieve.mockResolvedValue({
      status: "open",
      url: "https://checkout.stripe.test/open",
    });
    const res = await open(await tokenFor(row));
    expect(res.headers.get("location")).toBe("https://checkout.stripe.test/open");
    expect(sessionsCreate).not.toHaveBeenCalled();
  });

  it("sends the browser back to the forge, and never to Stripe, without a good token or a live hold", async () => {
    const back = `${FORGE}/onboarding/username?checkout=expired`;
    const row = hold();
    const good = await tokenFor(row);
    for (const token of [
      undefined,
      "nonsense",
      // Signed with another key, for another person, and long ago.
      await signGitUsernameCheckoutToken("x".repeat(40), { holdId: row.id, userId: row.userId }),
      await signGitUsernameCheckoutToken(KEY, { holdId: row.id, userId: "user-eve" }),
      await tokenFor(row, Date.now() - 60 * 60 * 1000),
    ]) {
      const res = await open(token);
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe(back);
    }
    // The hold lapsed, or was replaced, before the link was followed.
    holds.clear();
    expect((await open(good)).headers.get("location")).toBe(back);
    expect(sessionsCreate).not.toHaveBeenCalled();
  });

  it("says payments are unavailable when Stripe is not set up", async () => {
    delete process.env["STRIPE_SECRET_KEY"];
    const res = await open(await tokenFor(hold()));
    expect(res.headers.get("location")).toBe(`${FORGE}/onboarding/username?checkout=unavailable`);
    expect(sessionsCreate).not.toHaveBeenCalled();
  });
});

describe("a username payment settling", () => {
  it("refuses a delivery whose signature does not verify", async () => {
    const res = await deliver(paidSession(hold()), { secret: "whsec_someone_else" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid signature" });
    expect(complete).not.toHaveBeenCalled();
    expect(claimed.size).toBe(0);
  });

  it("claims the username from a verified delivery, once however often Stripe sends it", async () => {
    const row = hold({ workspaceOrganizationId: "org-acme" });
    const session = paidSession(row);
    expect((await deliver(session)).status).toBe(200);
    expect(complete).toHaveBeenCalledWith({
      userId: "user-ada",
      slug: "ada",
      holdId: "hold-1",
      stripeCheckoutSessionId: "cs_test_username_1",
      stripePaymentIntentId: "pi_test_1",
      amountPaidCents: 5000,
      currency: "usd",
    });
    expect(claimed.get("user-ada")).toBe("ada");
    expect(purchases.get("cs_test_username_1")).toMatchObject({ status: "claimed" });
    expect(logAudit).toHaveBeenCalledTimes(1);
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: "org-acme", action: "git.workspace.connect" }),
    );

    expect((await deliver(session)).status).toBe(200);
    expect(purchases.size).toBe(1);
    expect(logAudit).toHaveBeenCalledTimes(1);
    expect(refundsCreate).not.toHaveBeenCalled();
  });

  it("is a person's purchase: no organisation's subscription, seats or revenue report is touched", async () => {
    expect((await deliver(paidSession(hold()))).status).toBe(200);
    expect(billingWrites).not.toHaveBeenCalled();
    expect(subscriptionsRetrieve).not.toHaveBeenCalled();
    expect(recordCapacity).not.toHaveBeenCalled();
    expect(queuePaidCheckout).not.toHaveBeenCalled();
  });

  it("leaves an organisation's checkout as it was", async () => {
    subscriptionsRetrieve.mockResolvedValue({
      items: { data: [{ quantity: 2 }] },
      current_period_start: 1_700_000_000,
      current_period_end: 1_702_000_000,
    });
    const res = await deliver({
      id: "cs_test_sub",
      mode: "subscription",
      payment_status: "paid",
      customer: "cus_1",
      subscription: "sub_1",
      metadata: { organizationId: "org-1" },
    });
    expect(res.status).toBe(200);
    expect(billingWrites).toHaveBeenCalledTimes(1);
    expect(queuePaidCheckout).toHaveBeenCalledTimes(1);
    expect(complete).not.toHaveBeenCalled();
  });

  it("waits for the money: an unpaid session claims nothing", async () => {
    expect((await deliver(paidSession(hold(), { payment_status: "unpaid" }))).status).toBe(200);
    expect(complete).not.toHaveBeenCalled();
  });

  it("refunds the payment when the username is gone, once", async () => {
    const row = hold();
    taken.add("ada");
    const session = paidSession(row);
    expect((await deliver(session)).status).toBe(200);
    expect(claimed.size).toBe(0);
    expect(refundsCreate).toHaveBeenCalledTimes(1);
    expect(refundsCreate).toHaveBeenCalledWith(
      expect.objectContaining({ payment_intent: "pi_test_1" }),
      { idempotencyKey: "git-username-refund-cs_test_username_1" },
    );
    expect(purchases.get("cs_test_username_1")).toMatchObject({ status: "refunded" });

    // Delivered again: already refunded, nothing more is asked of Stripe.
    expect((await deliver(session)).status).toBe(200);
    expect(refundsCreate).toHaveBeenCalledTimes(1);
  });

  it("asks Stripe to deliver again when the refund fails, and refunds then", async () => {
    const row = hold();
    taken.add("ada");
    refundsCreate.mockRejectedValueOnce(new Error("stripe is down"));
    const session = paidSession(row);
    expect((await deliver(session)).status).toBe(500);
    expect(purchases.get("cs_test_username_1")).toMatchObject({ status: "refund_due" });

    expect((await deliver(session)).status).toBe(200);
    expect(refundsCreate).toHaveBeenCalledTimes(2);
    // The same key both times: Stripe makes them one refund.
    expect(refundsCreate.mock.calls[0]![1]).toEqual(refundsCreate.mock.calls[1]![1]);
    expect(purchases.get("cs_test_username_1")).toMatchObject({ status: "refunded" });
  });
});

describe("GET /api/git-username-checkout/return", () => {
  const back = (sessionId?: string) =>
    checkout.request(
      `/api/git-username-checkout/return${sessionId === undefined ? "" : `?session_id=${sessionId}`}`,
    );

  it("claims the username if the webhook has not, and goes back to the page the person left", async () => {
    const row = hold();
    sessionsRetrieve.mockResolvedValue(paidSession(row));
    const res = await back("cs_test_username_1");
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(
      `${FORGE}/onboarding/username?returnTo=%2Facme%2Finfra&checkout=return`,
    );
    expect(claimed.get("user-ada")).toBe("ada");
  });

  it("does nothing more when the webhook got there first", async () => {
    const row = hold();
    const session = paidSession(row);
    expect((await deliver(session)).status).toBe(200);
    sessionsRetrieve.mockResolvedValue(session);
    const res = await back("cs_test_username_1");
    expect(res.headers.get("location")).toBe(`${FORGE}/onboarding/username?checkout=return`);
    expect(purchases.size).toBe(1);
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it("refunds on the way back too, and still returns the person to the forge", async () => {
    const row = hold({ returnPath: "/settings" });
    taken.add("ada");
    sessionsRetrieve.mockResolvedValue(paidSession(row));
    const res = await back("cs_test_username_1");
    expect(res.headers.get("location")).toBe(`${FORGE}/settings?checkout=return`);
    expect(refundsCreate).toHaveBeenCalledTimes(1);
  });

  it("settles nothing for a session that is not a username payment, or not paid", async () => {
    sessionsRetrieve.mockResolvedValue({
      id: "cs_test_capacity",
      mode: "payment",
      payment_status: "paid",
      metadata: { kind: "capacity_slot", organizationId: "org-1" },
    });
    expect((await back("cs_test_capacity")).headers.get("location")).toBe(
      `${FORGE}/onboarding/username?checkout=expired`,
    );
    sessionsRetrieve.mockResolvedValue(paidSession(hold(), { payment_status: "unpaid" }));
    expect((await back("cs_test_username_1")).headers.get("location")).toBe(
      `${FORGE}/onboarding/username?checkout=cancelled`,
    );
    sessionsRetrieve.mockRejectedValue(new Error("No such checkout.session"));
    expect((await back("cs_nope")).status).toBe(303);
    expect((await back()).status).toBe(303);
    expect(complete).not.toHaveBeenCalled();
  });
});
