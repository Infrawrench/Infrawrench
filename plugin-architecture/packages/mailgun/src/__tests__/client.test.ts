import { describe, expect, it } from "vitest";
import { MailgunApiError, encodeParams } from "../api.js";
import { MailgunClient, domainForm, resolveRegions } from "../client.js";
import { groupWebhooks, mapDnsRecords } from "../mappers.js";
import { rfc2822, seriesFromItems } from "../metrics.js";
import { parseStatusFeed } from "../status-feed.js";

interface Call {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

function client(
  route: (url: URL, method: string, body?: string) => { status?: number; body?: unknown },
  region = "both",
) {
  const calls: Call[] = [];
  const http = {
    async request(req: {
      url: string;
      method: string;
      headers: Record<string, string>;
      body?: string | Uint8Array;
    }) {
      const url = new URL(req.url);
      const body = typeof req.body === "string" ? req.body : undefined;
      calls.push({
        url,
        method: req.method,
        headers: req.headers,
        ...(body !== undefined ? { body } : {}),
      });
      const r = route(url, req.method, body);
      return {
        status: r.status ?? 200,
        headers: {},
        body: r.body === undefined ? "" : JSON.stringify(r.body),
      };
    },
  };
  return { c: new MailgunClient({ apiKey: "key-1", region }, { http } as never), calls };
}

const DETAIL = {
  domain: { name: "mg.example.com", state: "unverified", web_scheme: "https" },
  sending_dns_records: [
    {
      record_type: "TXT",
      name: "mg.example.com",
      value: "v=spf1 include:mailgun.org ~all",
      valid: "valid",
      cached: [],
    },
    {
      record_type: "TXT",
      name: "pic._domainkey.mg.example.com",
      value: "k=rsa; p=MIG",
      valid: "unknown",
      cached: [],
    },
    {
      record_type: "CNAME",
      name: "email.mg.example.com",
      value: "mailgun.org",
      valid: "invalid",
      cached: [],
    },
  ],
  receiving_dns_records: [
    { record_type: "MX", priority: "10", value: "mxa.mailgun.org", valid: "unknown", cached: [] },
  ],
};

describe("Mailgun client", () => {
  it("lists domains in both regions with Basic auth and builds DNS records", async () => {
    const { c, calls } = client((url) => {
      if (url.pathname === "/v4/domains") {
        const name = url.host === "api.eu.mailgun.net" ? "eu.example.com" : "mg.example.com";
        return { body: { total_count: 1, items: [{ name, state: "active" }] } };
      }
      if (url.pathname.startsWith("/v4/domains/")) return { body: DETAIL };
      if (url.pathname.endsWith("/tracking"))
        return { body: { tracking: { open: { active: true }, click: { active: false } } } };
      return { status: 404, body: { message: "not found" } };
    });
    const domains = await c.listResources("mailgun-domain", "a");
    expect(domains.map((d) => d.externalId).sort()).toEqual([
      "eu/mg.example.com",
      "us/mg.example.com",
    ]);
    expect(domains[0]!.fields["trackOpens"]).toBe(true);
    expect(calls[0]!.headers["Authorization"]).toBe(`Basic ${btoa("api:key-1")}`);
    const records = await c.listResources("mailgun-dns-record", "a");
    expect(records).toHaveLength(8);
    // The domain list is cached between the two listers.
    expect(calls.filter((x) => x.url.pathname === "/v4/domains")).toHaveLength(2);
  });

  it("maps record purposes, MX names and priorities", () => {
    const recs = mapDnsRecords("a", { region: "eu", detail: DETAIL });
    expect(recs.map((r) => [r.fields["type"], r.fields["purpose"], r.fields["name"]])).toEqual([
      ["TXT", "SPF", "mg.example.com"],
      ["TXT", "DKIM", "pic._domainkey.mg.example.com"],
      ["CNAME", "Tracking (CNAME)", "email.mg.example.com"],
      ["MX", "Receiving (MX)", "mg.example.com"],
    ]);
    expect(recs[3]!.fields["priority"]).toBe(10);
    expect(recs[0]!.parentResourceId).toBe("a:mailgun-domain:eu/mg.example.com");
  });

  it("regroups v3 webhooks by URL and writes them with repeated event_types", async () => {
    const grouped = groupWebhooks({
      delivered: { urls: ["https://a", "https://b"] },
      opened: { urls: ["https://a"] },
      clicked: null,
    });
    expect([...(grouped.get("https://a") ?? [])]).toEqual(["delivered", "opened"]);
    const { c, calls } = client(() => ({ body: { webhooks: {} } }), "us");
    await c.createResource("mailgun-webhook", "a", {
      domain: "us/mg.example.com",
      url: "https://x",
      delivered: "true",
      clicked: "true",
    });
    const post = calls.at(-1)!;
    expect(post.url.pathname).toBe("/v4/domains/mg.example.com/webhooks");
    expect(new URLSearchParams(post.body).getAll("event_types")).toEqual(["delivered", "clicked"]);
  });

  it("follows paging.next and stops on an empty page", async () => {
    const { c } = client((url) => {
      if (url.pathname === "/v3/lists/pages" && !url.searchParams.get("page")) {
        return {
          body: {
            items: [{ address: "a@x", members_count: 2 }],
            paging: { next: "https://api.mailgun.net/v3/lists/pages?page=next&limit=100" },
          },
        };
      }
      return {
        body: { items: [], paging: { next: "https://api.mailgun.net/v3/lists/pages?page=next2" } },
      };
    }, "us");
    const lists = await c.listResources("mailgun-mailing-list", "a");
    expect(lists.map((l) => l.externalId)).toEqual(["us/a@x"]);
  });

  it("maps errors with status; a missing custom limit is no quota", async () => {
    const { c } = client(() => ({ status: 401, body: { message: "Invalid private key" } }), "us");
    const err = await c.listResources("mailgun-domain", "a").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MailgunApiError);
    expect((err as MailgunApiError).status).toBe(401);
    const { c: c2 } = client(() => ({ status: 404, body: { message: "not set" } }), "us");
    expect(await c2.fetchQuotas("a")).toEqual([]);
    const { c: c3 } = client(() => ({ body: { limit: 1000, current: 900, period: "1m" } }), "us");
    expect(await c3.fetchQuotas("a")).toMatchObject([{ limit: 1000, used: 900 }]);
  });

  it("helpers", () => {
    expect(resolveRegions("eu")).toEqual(["eu"]);
    expect(resolveRegions("")).toEqual(["us", "eu"]);
    expect(encodeParams({ a: ["x", "y"], b: undefined, c: true })).toBe("a=x&a=y&c=true");
    expect(domainForm({ spamAction: "block", messageTtl: "" })).toEqual({ spam_action: "block" });
    expect(rfc2822(Date.UTC(2026, 9, 7))).toBe("Wed, 07 Oct 2026 00:00:00 +0000");
    const series = seriesFromItems([
      {
        dimensions: [{ dimension: "time", value: "Wed, 07 Oct 2026 00:00:00 +0000" }],
        metrics: { delivered_count: 3 },
      },
      {
        dimensions: [{ dimension: "time", value: "Wed, 07 Oct 2026 00:00:00 +0000" }],
        metrics: { delivered_count: 2 },
      },
    ]);
    expect(series.find((s) => s.label === "Delivered")?.points).toEqual([
      { timestamp: Date.UTC(2026, 9, 7), value: 5 },
    ]);
    expect(
      parseStatusFeed(
        JSON.stringify({
          incidents: [
            {
              id: "1",
              name: "Delays",
              status: "investigating",
              components: [{ name: "Outbound Delivery" }],
            },
          ],
        }),
      )[0]?.providerWide,
    ).toBe(true);
  });
});
