import { describe, expect, it, vi } from "vitest";
import { QuotaAccessError } from "@infrawrench/plugin-base";
import { countDoObjects, fetchDoQuotas } from "../quotas.js";

/**
 * Recorded from DigitalOcean's published OpenAPI document — every value here
 * is a per-field `example` in `specification/resources/account/models/account.yml`,
 * so the fixture cannot drift from the documented shape without the doc
 * changing first.
 *
 * The two absences are the point of the fixture: there is no `volume_limit`
 * and no `reserved_ip_limit`. Both are things a reasonable implementation
 * would read, and both would come back `undefined` — a quota silently missing
 * rather than an error anybody notices.
 */
const ACCOUNT_FIXTURE = {
  account: {
    droplet_limit: 25,
    floating_ip_limit: 5,
    email: "sammy@digitalocean.com",
    name: "Sammy the Shark",
    uuid: "b6fr89dbf6d9156cace5f3c78dc9851d957381ef",
    email_verified: true,
    status: "active",
    status_message: " ",
    team: { uuid: "5df3e3004a17e242b7c20ca6c9fc25b701a47ece", name: "My Team" },
  },
};

/** The `meta` envelope every DO list endpoint carries. */
function listPage(total: number) {
  return { droplets: [], links: { pages: {} }, meta: { total } };
}

function ctxWith(handlers: Record<string, unknown>) {
  const fetch = vi.fn((path: string) => {
    if (path in handlers) return Promise.resolve(handlers[path]);
    throw new Error(`unexpected path ${path}`);
  });
  return { ctx: { fetch: fetch as never }, fetch };
}

describe("fetchDoQuotas", () => {
  it("reports droplets and reserved IPs from the account limits and the pagination totals", async () => {
    const { ctx } = ctxWith({
      "/account": ACCOUNT_FIXTURE,
      "/droplets?per_page=1": listPage(18),
      "/reserved_ips?per_page=1": listPage(2),
    });

    await expect(fetchDoQuotas(ctx)).resolves.toEqual([
      {
        id: "account/droplet_limit",
        service: "account",
        name: "Droplets",
        limit: 25,
        used: 18,
        unit: "droplets",
        adjustable: true,
        docsUrl: "https://docs.digitalocean.com/support/why-am-i-receiving-a-limit-error/",
      },
      {
        id: "account/floating_ip_limit",
        service: "account",
        name: "Reserved IPs",
        limit: 5,
        used: 2,
        unit: "addresses",
        adjustable: true,
        docsUrl: "https://docs.digitalocean.com/support/why-am-i-receiving-a-limit-error/",
      },
    ]);
  });

  // The id must survive DigitalOcean renaming the product again. It keys on
  // the API field name (`floating_ip_limit`) while the label uses the current
  // product name — a key derived from the label would start a fresh, empty
  // trend the next time marketing changes its mind.
  it("keys reserved IPs on the API field name, not the product name", async () => {
    const { ctx } = ctxWith({
      "/account": ACCOUNT_FIXTURE,
      "/droplets?per_page=1": listPage(1),
      "/reserved_ips?per_page=1": listPage(1),
    });
    const readings = await fetchDoQuotas(ctx);
    const ip = readings.find((r) => r.name === "Reserved IPs");
    expect(ip?.id).toBe("account/floating_ip_limit");
  });

  it("counts reserved IPs from /reserved_ips, never /floating_ips", async () => {
    const { ctx, fetch } = ctxWith({
      "/account": ACCOUNT_FIXTURE,
      "/droplets?per_page=1": listPage(1),
      "/reserved_ips?per_page=1": listPage(1),
    });
    await fetchDoQuotas(ctx);
    const paths = fetch.mock.calls.map((c) => c[0]);
    expect(paths).toContain("/reserved_ips?per_page=1");
    expect(paths).not.toContain("/floating_ips?per_page=1");
  });

  // A limit with no count would render as 0% used, which is a claim. Omitting
  // the row is not.
  it("omits a quota whose count could not be read", async () => {
    const { ctx } = ctxWith({
      "/account": ACCOUNT_FIXTURE,
      "/droplets?per_page=1": { droplets: [] },
      "/reserved_ips?per_page=1": listPage(2),
    });
    const readings = await fetchDoQuotas(ctx);
    expect(readings.map((r) => r.id)).toEqual(["account/floating_ip_limit"]);
  });

  // A zero limit is DigitalOcean saying the product is not enabled on this
  // account. Divided into a utilisation it is infinite, and infinite sorts
  // above 100% in every worst-first ordering.
  it("drops a zero limit rather than dividing by it", async () => {
    const { ctx } = ctxWith({
      "/account": { account: { ...ACCOUNT_FIXTURE.account, floating_ip_limit: 0 } },
      "/droplets?per_page=1": listPage(3),
    });
    const readings = await fetchDoQuotas(ctx);
    expect(readings.map((r) => r.id)).toEqual(["account/droplet_limit"]);
  });

  it("raises a fixable access error when the token cannot read the account", async () => {
    const { ctx } = ctxWith({ "/account": {} });
    await expect(fetchDoQuotas(ctx)).rejects.toBeInstanceOf(QuotaAccessError);
  });
});

describe("countDoObjects", () => {
  it("reads meta.total, not the returned page length", async () => {
    const { ctx } = ctxWith({ "/droplets?per_page=1": { droplets: [{}], meta: { total: 91 } } });
    await expect(countDoObjects(ctx, "/droplets")).resolves.toBe(91);
  });

  it("returns null rather than zero for an unrecognised envelope", async () => {
    const { ctx } = ctxWith({ "/droplets?per_page=1": { droplets: [] } });
    await expect(countDoObjects(ctx, "/droplets")).resolves.toBeNull();
  });
});
