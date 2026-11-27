import Stripe from "stripe";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  signGitUsernameCheckoutToken,
  signGitWorkspaceCheckoutToken,
} from "@infrawrench/client-core";
import { buildTestApi } from "@/http/testing";

/**
 * Setting up a workspace from git.infrawrench.com, the app's half: the route
 * the forge sends the browser to opens the Pro plan's Checkout session for
 * the person and the name its token carries, and a completed payment creates
 * the organization once, whether the webhook or the browser's return reports
 * it. Nothing is written before that, so a closed payment page leaves
 * nothing. Stripe is a fake throughout, except its webhook signature check,
 * which is the library's own over a locally signed test payload.
 *
 * What creating the organization writes (roles, the owner, the dashboard,
 * the subscription row, the namespace's connection) is the forge's db suite,
 * `workspace-checkout.test.ts`.
 */

const KEY = "test-job-token-key-of-at-least-32-characters";
const WEBHOOK_SECRET = "whsec_test_secret";
const realStripe = new Stripe("sk_test_not_a_real_key");

const customersCreate = vi.fn();
const sessionsCreate = vi.fn();
const sessionsRetrieve = vi.fn();
const subscriptionsRetrieve = vi.fn();
const fakeStripe = {
  webhooks: realStripe.webhooks,
  customers: { create: (...a: unknown[]) => customersCreate(...a) },
  checkout: {
    sessions: {
      create: (...a: unknown[]) => sessionsCreate(...a),
      retrieve: (...a: unknown[]) => sessionsRetrieve(...a),
    },
  },
  subscriptions: { retrieve: (...a: unknown[]) => subscriptionsRetrieve(...a) },
};

// Whole, never spread from the real module: nothing here may reach Stripe.
vi.mock("@/services/stripe", () => ({
  getStripe: () => fakeStripe,
  getStripeWebhookSecret: () => WEBHOOK_SECRET,
  getStripePriceId: () => {
    const id = process.env["STRIPE_PRICE_ID"];
    if (!id) throw new Error("STRIPE_PRICE_ID environment variable is required");
    return id;
  },
  getStripeChatPriceId: () => "price_test_chat",
  getStripeCiPriceIds: () => ["price_test_ci_vcpu"],
  getStripeGitStoragePriceId: () => "price_test_git_storage",
  getStripeCapacitySlotPriceId: () => null,
  getStripeGitShortUsernamePriceId: async () => null,
}));

const queuePaidCheckout = vi.fn();
const saveCheckoutHandoff = vi.fn();
vi.mock("@/services/revnu-checkout", () => ({
  queuePaidCheckout: (...a: unknown[]) => queuePaidCheckout(...a),
  saveCheckoutHandoff: (...a: unknown[]) => saveCheckoutHandoff(...a),
}));

const logAudit = vi.fn();
vi.mock("@/services/audit", () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));

/** Every write the routes make themselves: only the subscription's, once there is a row for it. */
const subscriptionWrites = vi.fn();
const otherWrites = vi.fn();
vi.mock("@/db/client", () => ({
  db: {
    update: () => ({
      set: (values: unknown) => ({
        where: () => {
          subscriptionWrites(values);
          return Promise.resolve();
        },
      }),
    }),
    insert: () => {
      otherWrites();
      return { values: () => Promise.resolve() };
    },
    select: () => ({ from: () => ({ where: () => Promise.resolve([]) }) }),
  },
}));

vi.mock("@infrawrench/server-core/billing/capacity-slots", () => ({
  CAPACITY_SLOT_PRICE_USD: 200,
  CAPACITY_SLOT_TERM_MONTHS: 12,
  activeCapacitySeats: async () => 0,
  listCapacitySlots: async () => [],
  recordCapacitySlotPurchase: async () => ({ granted: false, expiresAt: new Date() }),
  refundCapacitySlots: async () => 0,
}));

vi.mock("@infrawrench/server-core/git/short-usernames", () => ({
  gitUsernameHoldFor: async () => null,
  attachGitUsernameCheckout: async () => false,
  completeGitUsernamePurchase: async () => {
    throw new Error("not a username payment");
  },
  markGitUsernamePurchaseRefunded: async () => {},
  gitUsernamePurchaseBySession: async () => null,
}));

/** The shared tables, as far as these routes read and write them. */
const people = new Map<string, { email: string }>();
const organizations = new Map<string, { name: string; owner: string; stripeCustomerId: string }>();
/** People who have a username on the forge that runs nowhere yet. */
const unconnected = new Map<string, { id: string; slug: string }>();
const provision = vi.fn();

vi.mock("@infrawrench/server-core/git/workspace-checkout", () => ({
  gitWorkspaceOfferFor: async (userId: string) => {
    const person = people.get(userId);
    if (!person) return { status: "no_user" };
    const member = [...organizations.values()].some((org) => org.owner === userId);
    return member ? { status: "has_organization" } : { status: "ok", email: person.email };
  },
  provisionGitWorkspace: async (payment: {
    organizationId: string;
    name: string;
    userId: string;
    stripeCustomerId: string;
  }) => {
    provision(payment);
    if (!people.has(payment.userId)) return { status: "refused", reason: "no_user" };
    const existing = organizations.get(payment.organizationId);
    if (existing && existing.owner !== payment.userId) {
      return { status: "refused", reason: "taken" };
    }
    if (!existing) {
      organizations.set(payment.organizationId, {
        name: payment.name,
        owner: payment.userId,
        stripeCustomerId: payment.stripeCustomerId,
      });
    }
    const namespace = unconnected.get(payment.userId) ?? null;
    unconnected.delete(payment.userId);
    return {
      status: "provisioned",
      first: !existing,
      organizationId: payment.organizationId,
      connectedNamespace: namespace,
    };
  },
}));

const { gitWorkspaceCheckoutDomain } = await import("@/http/domains/git-workspace-checkout/index");
const { stripeWebhookDomain } = await import("@/http/domains/stripe-webhook/index");
const checkout = buildTestApi(gitWorkspaceCheckoutDomain, { permissions: [] });
const webhook = buildTestApi(stripeWebhookDomain, { basePath: "/api/v1/webhooks/stripe" });

const FORGE = "https://git.example.test";
const ORG = "5f0d4a52-8f3c-4b53-9d0e-0b1f8a2c7e11";
const ADA = "user-ada";
const RETURN_PATH = "/onboarding/username?username=ada-lovelace&returnTo=%2Fnew";
const CLAIMS = {
  organizationId: ORG,
  userId: ADA,
  name: "Ada's workspace",
  returnPath: RETURN_PATH,
};
const SESSION_URL = "https://checkout.stripe.test/c/pay/cs_test_workspace_1";

const tokenFor = (over: Partial<typeof CLAIMS> = {}, now?: number) =>
  signGitWorkspaceCheckoutToken(KEY, { ...CLAIMS, ...over }, now);

const open = (token?: string) =>
  checkout.request(
    `/api/git-workspace-checkout${token === undefined ? "" : `?token=${encodeURIComponent(token)}`}`,
  );

const comeBack = (sessionId?: string) =>
  checkout.request(
    `/api/git-workspace-checkout/return${sessionId === undefined ? "" : `?session_id=${sessionId}`}`,
  );

const METADATA = {
  kind: "git_workspace",
  organizationId: ORG,
  userId: ADA,
  organizationName: "Ada's workspace",
  returnPath: RETURN_PATH,
};

/** A workspace's Checkout session as Stripe sends it once the first invoice is paid. */
function paidSession(overrides: Record<string, unknown> = {}) {
  return {
    id: "cs_test_workspace_1",
    object: "checkout.session",
    mode: "subscription",
    status: "complete",
    payment_status: "paid",
    customer: "cus_test_ada",
    subscription: "sub_test_ada",
    amount_total: 2000,
    currency: "usd",
    metadata: METADATA,
    ...overrides,
  };
}

/** A delivery signed as Stripe signs one, so the library's own check passes. */
function deliver(
  object: Record<string, unknown>,
  options: { secret?: string; type?: string } = {},
) {
  const payload = JSON.stringify({
    id: "evt_test_1",
    object: "event",
    type: options.type ?? "checkout.session.completed",
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
  people.clear();
  organizations.clear();
  unconnected.clear();
  people.set(ADA, { email: "ada@example.test" });
  process.env["GIT_JOB_TOKEN_KEY"] = KEY;
  process.env["STRIPE_SECRET_KEY"] = "sk_test_not_a_real_key";
  process.env["STRIPE_PRICE_ID"] = "price_test_pro";
  process.env["GIT_BASE_URL"] = FORGE;
  process.env["APP_URL"] = "https://app.example.test";
  customersCreate.mockResolvedValue({ id: "cus_test_ada" });
  sessionsCreate.mockResolvedValue({ id: "cs_test_workspace_1", url: SESSION_URL });
  subscriptionsRetrieve.mockResolvedValue({
    id: "sub_test_ada",
    current_period_start: 1_800_000_000,
    current_period_end: 1_802_592_000,
    items: { data: [{ quantity: 1 }, { quantity: null }] },
  });
  queuePaidCheckout.mockResolvedValue(undefined);
  logAudit.mockResolvedValue(true);
});

describe("GET /api/git-workspace-checkout", () => {
  it("opens the Pro plan's subscription checkout, one seat, for the person and name the token carries", async () => {
    const res = await open(await tokenFor());
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(SESSION_URL);

    // The organization does not exist yet: its customer is named by the id it will have.
    expect(customersCreate).toHaveBeenCalledWith(
      { email: "ada@example.test", metadata: { organizationId: ORG } },
      { idempotencyKey: `git-workspace-customer-${ORG}` },
    );
    const [params, options] = sessionsCreate.mock.calls[0]!;
    expect(params).toEqual({
      customer: "cus_test_ada",
      mode: "subscription",
      // The billing page's own line items: the Pro seat and every metered price.
      line_items: [
        {
          price: "price_test_pro",
          quantity: 1,
          adjustable_quantity: { enabled: true, minimum: 1 },
        },
        { price: "price_test_chat" },
        { price: "price_test_ci_vcpu" },
        { price: "price_test_git_storage" },
      ],
      metadata: METADATA,
      success_url:
        "https://app.example.test/api/git-workspace-checkout/return?session_id={CHECKOUT_SESSION_ID}",
      cancel_url: `${FORGE}${RETURN_PATH}&workspace=cancelled`,
    });
    expect(options).toEqual({ idempotencyKey: `git-workspace-checkout-${ORG}` });
  });

  it("writes nothing: someone who closes the payment page leaves no organization behind", async () => {
    await open(await tokenFor());
    expect(provision).not.toHaveBeenCalled();
    expect(subscriptionWrites).not.toHaveBeenCalled();
    expect(otherWrites).not.toHaveBeenCalled();
    expect(saveCheckoutHandoff).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalled();
    expect(organizations.size).toBe(0);
  });

  it("opens the same payment when the link is followed twice", async () => {
    const token = await tokenFor();
    await open(token);
    await open(token);
    // Stripe answers a repeated key with the first answer: one customer, one session.
    expect(customersCreate.mock.calls.map(([, options]) => options)).toEqual([
      { idempotencyKey: `git-workspace-customer-${ORG}` },
      { idempotencyKey: `git-workspace-customer-${ORG}` },
    ]);
    expect(sessionsCreate.mock.calls.map(([, options]) => options)).toEqual([
      { idempotencyKey: `git-workspace-checkout-${ORG}` },
      { idempotencyKey: `git-workspace-checkout-${ORG}` },
    ]);
    expect(sessionsCreate.mock.calls[1]![0]).toEqual(sessionsCreate.mock.calls[0]![0]);
  });

  it("never offers a second organization to someone who is in one", async () => {
    organizations.set("org-existing", { name: "Acme", owner: ADA, stripeCustomerId: "cus_x" });
    const res = await open(await tokenFor());
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`${FORGE}${RETURN_PATH}&workspace=return`);
    expect(customersCreate).not.toHaveBeenCalled();
    expect(sessionsCreate).not.toHaveBeenCalled();
  });

  it("sends the browser back to the forge, and never to Stripe, without a good token", async () => {
    const back = `${FORGE}/settings/organisations?workspace=expired`;
    for (const token of [
      undefined,
      "nonsense",
      // Signed with another key, long ago, and a token for something else.
      await signGitWorkspaceCheckoutToken("x".repeat(40), CLAIMS),
      await tokenFor({}, Date.now() - 60 * 60 * 1000),
      await signGitUsernameCheckoutToken(KEY, { holdId: "hold-1", userId: ADA }),
    ]) {
      const res = await open(token);
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe(back);
    }
    // A token for an account that is gone.
    const res = await open(await tokenFor({ userId: "user-gone" }));
    expect(res.headers.get("location")).toBe(`${FORGE}${RETURN_PATH}&workspace=expired`);
    expect(customersCreate).not.toHaveBeenCalled();
    expect(sessionsCreate).not.toHaveBeenCalled();
  });

  it("says payments are unavailable when Stripe or the Pro price is not set up", async () => {
    const back = `${FORGE}/settings/organisations?workspace=unavailable`;
    delete process.env["STRIPE_PRICE_ID"];
    expect((await open(await tokenFor())).headers.get("location")).toBe(back);
    process.env["STRIPE_PRICE_ID"] = "price_test_pro";
    delete process.env["STRIPE_SECRET_KEY"];
    expect((await open(await tokenFor())).headers.get("location")).toBe(back);
    expect(sessionsCreate).not.toHaveBeenCalled();
  });

  it("goes back to the forge when Stripe opens no page", async () => {
    sessionsCreate.mockResolvedValue({ id: "cs_test_workspace_1", url: null });
    const res = await open(await tokenFor());
    expect(res.headers.get("location")).toBe(`${FORGE}${RETURN_PATH}&workspace=unavailable`);
  });
});

describe("a workspace payment settling", () => {
  it("refuses a delivery whose signature does not verify", async () => {
    const res = await deliver(paidSession(), { secret: "whsec_someone_else" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid signature" });
    expect(provision).not.toHaveBeenCalled();
    expect(organizations.size).toBe(0);
  });

  it("creates the organization from a verified delivery, once however often Stripe sends it", async () => {
    expect((await deliver(paidSession())).status).toBe(200);
    expect(provision).toHaveBeenCalledWith({
      organizationId: ORG,
      name: "Ada's workspace",
      userId: ADA,
      stripeCustomerId: "cus_test_ada",
    });
    expect([...organizations]).toEqual([
      [ORG, { name: "Ada's workspace", owner: ADA, stripeCustomerId: "cus_test_ada" }],
    ]);
    // On its plan: the subscription Stripe made, on the row its customer finds.
    expect(subscriptionWrites).toHaveBeenCalledTimes(1);
    expect(subscriptionWrites).toHaveBeenCalledWith(
      expect.objectContaining({
        stripeSubscriptionId: "sub_test_ada",
        status: "active",
        seatCount: 1,
      }),
    );
    expect(logAudit).toHaveBeenCalledTimes(1);
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: ORG,
        userId: ADA,
        action: "organization.create",
        entityId: ORG,
      }),
    );
    // A subscription like any other to the purchase report.
    expect(queuePaidCheckout).toHaveBeenCalledTimes(1);

    expect((await deliver(paidSession())).status).toBe(200);
    expect((await deliver(paidSession())).status).toBe(200);
    expect(organizations.size).toBe(1);
    // The redeliveries found it there: no second audit row.
    expect(logAudit).toHaveBeenCalledTimes(1);
  });

  it("creates it from the browser's return when the webhook has not arrived, and the webhook then finds it done", async () => {
    sessionsRetrieve.mockResolvedValue(paidSession());
    const res = await comeBack("cs_test_workspace_1");
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`${FORGE}${RETURN_PATH}&workspace=return`);
    expect(sessionsRetrieve).toHaveBeenCalledWith("cs_test_workspace_1");
    expect(organizations.get(ORG)?.owner).toBe(ADA);
    // Already on its plan when the forge page loads.
    expect(subscriptionWrites).toHaveBeenCalledWith(
      expect.objectContaining({ stripeSubscriptionId: "sub_test_ada", status: "active" }),
    );
    expect(logAudit).toHaveBeenCalledTimes(1);

    expect((await deliver(paidSession())).status).toBe(200);
    expect((await comeBack("cs_test_workspace_1")).headers.get("location")).toBe(
      `${FORGE}${RETURN_PATH}&workspace=return`,
    );
    expect(organizations.size).toBe(1);
    expect(logAudit).toHaveBeenCalledTimes(1);
  });

  it("notes the connection when the person already had a username that ran nowhere", async () => {
    unconnected.set(ADA, { id: "ns-ada", slug: "ada-lovelace" });
    await deliver(
      paidSession({ metadata: { ...METADATA, returnPath: "/settings/organisations" } }),
    );
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: ORG,
        action: "git.workspace.connect",
        entityType: "git_namespace",
        entityId: "ns-ada",
        metadata: { slug: "ada-lovelace" },
      }),
    );
  });

  it("creates nothing for a session that was left open: the browser goes back as cancelled", async () => {
    sessionsRetrieve.mockResolvedValue(
      paidSession({ status: "open", payment_status: "unpaid", subscription: null }),
    );
    const res = await comeBack("cs_test_workspace_1");
    expect(res.headers.get("location")).toBe(`${FORGE}${RETURN_PATH}&workspace=cancelled`);
    expect(provision).not.toHaveBeenCalled();
    expect(subscriptionWrites).not.toHaveBeenCalled();
    expect(organizations.size).toBe(0);
  });

  it("waits for a delayed payment method to settle", async () => {
    const pending = paidSession({ payment_status: "unpaid" });
    expect((await deliver(pending)).status).toBe(200);
    expect(provision).not.toHaveBeenCalled();
    expect(subscriptionWrites).not.toHaveBeenCalled();
    expect(queuePaidCheckout).not.toHaveBeenCalled();

    await deliver(paidSession(), { type: "checkout.session.async_payment_succeeded" });
    expect(organizations.size).toBe(1);
    expect(subscriptionWrites).toHaveBeenCalledTimes(1);
  });

  it("creates nothing, and says so, when the account that paid is gone", async () => {
    people.clear();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await deliver(paidSession())).status).toBe(200);
    expect(organizations.size).toBe(0);
    expect(subscriptionWrites).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(expect.stringContaining("cs_test_workspace_1"));

    sessionsRetrieve.mockResolvedValue(paidSession());
    expect((await comeBack("cs_test_workspace_1")).headers.get("location")).toBe(
      `${FORGE}${RETURN_PATH}&workspace=failed`,
    );
    error.mockRestore();
  });

  it("leaves an ordinary subscription checkout to the billing page's path", async () => {
    await deliver(paidSession({ metadata: { organizationId: "org-acme" } }));
    expect(provision).not.toHaveBeenCalled();
    expect(subscriptionWrites).toHaveBeenCalledTimes(1);
  });

  it("answers a return that names no workspace session with the forge, and creates nothing", async () => {
    const back = `${FORGE}/settings/organisations?workspace=expired`;
    sessionsRetrieve.mockRejectedValue(new Error("No such checkout.session"));
    expect((await comeBack("cs_test_unknown")).headers.get("location")).toBe(back);
    // Someone else's kind of session: a billing-page subscription, a username payment.
    sessionsRetrieve.mockResolvedValue(paidSession({ metadata: { organizationId: "org-acme" } }));
    expect((await comeBack("cs_test_other")).headers.get("location")).toBe(back);
    sessionsRetrieve.mockResolvedValue(
      paidSession({ mode: "payment", metadata: { kind: "git_short_username" } }),
    );
    expect((await comeBack("cs_test_username")).headers.get("location")).toBe(back);
    expect((await comeBack()).headers.get("location")).toBe(
      `${FORGE}/settings/organisations?workspace=cancelled`,
    );
    expect(provision).not.toHaveBeenCalled();
  });

  it("never follows a return path that leaves the forge", async () => {
    for (const returnPath of [
      "//evil.example/x",
      "https://evil.example/x",
      "/\\evil.example/x",
      // A URL parser drops the tab, which would leave `//evil.example/x`.
      "/\t/evil.example/x",
      "/\n/evil.example/x",
    ]) {
      sessionsRetrieve.mockResolvedValue(paidSession({ metadata: { ...METADATA, returnPath } }));
      const location = (await comeBack("cs_test_workspace_1")).headers.get("location")!;
      expect(location).toBe(`${FORGE}/settings/organisations?workspace=return`);
    }
  });
});
