import { hostClient } from "@infrawrench/plugin-base/effect";
import { describe, expect, it } from "vitest";
import { SendGridApiError } from "../api.js";
import { SendGridClient, parseScopes } from "../client.js";
import { domainDnsRecords, keyIdOf } from "../mappers.js";
import { parseStatusFeed } from "../status-feed.js";

function client(
  route: (url: URL, method: string) => { status?: number; body?: unknown },
  creds: Record<string, string> = {},
) {
  const calls: Array<{
    url: URL;
    method: string;
    headers: Record<string, string>;
    body?: string;
  }> = [];
  const http = {
    async request(req: {
      url: string;
      method: string;
      headers: Record<string, string>;
      body?: string;
    }) {
      const url = new URL(req.url);
      calls.push({
        url,
        method: req.method,
        headers: req.headers,
        ...(req.body !== undefined ? { body: req.body } : {}),
      });
      const r = route(url, req.method);
      return {
        status: r.status ?? 200,
        headers: {},
        body: r.body === undefined ? "" : JSON.stringify(r.body),
      };
    },
  };
  return {
    c: hostClient(new SendGridClient({ apiKey: "SG.kid.secret", ...creds }, { http } as never)),
    calls,
  };
}

describe("SendGrid client", () => {
  it("pages offset lists, sends Bearer and on-behalf-of, and uses the EU host", async () => {
    const { c, calls } = client(
      (url) => {
        const offset = Number(url.searchParams.get("offset"));
        return {
          body:
            offset === 0
              ? Array.from({ length: 100 }, (_, i) => ({ id: i, domain: `d${i}.com` }))
              : [{ id: 100, domain: "x.com" }],
        };
      },
      { region: "eu", onBehalfOf: "sub1" },
    );
    const list = await c.listResources("sendgrid-domain", "a");
    expect(list).toHaveLength(101);
    expect(calls[0]!.url.host).toBe("api.eu.sendgrid.com");
    expect(calls[0]!.headers["Authorization"]).toBe("Bearer SG.kid.secret");
    expect(calls[0]!.headers["on-behalf-of"]).toBe("sub1");
  });

  it("maps errors with status, and lists a missing scope as empty", async () => {
    const { c } = client(() => ({
      status: 403,
      body: { errors: [{ message: "access forbidden" }] },
    }));
    expect(await c.listResources("sendgrid-alert", "a")).toEqual([]);
    const err = await c.listResources("sendgrid-account", "a").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SendGridApiError);
    expect((err as SendGridApiError).status).toBe(403);
    expect((err as Error).message).toMatch(/access forbidden/);
  });

  it("asks for each subuser's region, on the list and on the detail read", async () => {
    const { c, calls } = client((url) => {
      if (url.pathname === "/v3/subusers") {
        return {
          body:
            url.searchParams.get("include_region") === "true"
              ? [{ id: 1, username: "sub1", email: "a@example.com", disabled: false, region: "eu" }]
              : [{ id: 1, username: "sub1", email: "a@example.com", disabled: false }],
        };
      }
      return { body: [] };
    });
    const [listed] = await c.listResources("sendgrid-subuser", "a");
    expect(listed!.fields["region"]).toBe("eu");
    const detail = await c.getResource("sendgrid-subuser", "a:sendgrid-subuser:sub1", "a");
    expect(detail.fields["region"]).toBe("eu");
    const reads = calls.filter((x) => x.url.pathname === "/v3/subusers");
    expect(reads.map((x) => x.url.searchParams.get("include_region"))).toEqual(["true", "true"]);
  });

  describe("editing an event webhook", () => {
    const hook = { id: "wh1", url: "https://example.com/events", enabled: true, bounce: true };
    const route = (url: URL, method: string) =>
      method === "PATCH"
        ? { body: {} }
        : url.pathname.endsWith("/all")
          ? { body: {} }
          : { body: hook };
    const patches = (calls: Array<{ method: string; url: URL; body?: string }>) =>
      calls
        .filter((x) => x.method === "PATCH")
        .map((x) => ({ path: x.url.pathname, body: JSON.parse(x.body ?? "{}") as object }));

    it("keeps the current url when the edit does not change it", async () => {
      const { c, calls } = client(route);
      await c.updateResource("sendgrid-event-webhook", "a:sendgrid-event-webhook:wh1", "a", {
        friendlyName: "Prod",
        click: "true",
      });
      expect(patches(calls)).toEqual([
        {
          path: "/v3/user/webhooks/event/settings/wh1",
          body: { click: true, friendly_name: "Prod", url: hook.url },
        },
      ]);
    });

    it("sends a changed url as typed, without reading the old one first", async () => {
      const { c, calls } = client(route);
      await c.updateResource("sendgrid-event-webhook", "a:sendgrid-event-webhook:wh1", "a", {
        url: " https://example.com/new ",
      });
      expect(patches(calls)[0]!.body).toEqual({ url: "https://example.com/new" });
      expect(calls[0]!.method).toBe("PATCH");
    });

    it("writes nothing when the current url cannot be read", async () => {
      const { c, calls } = client((_, method) =>
        method === "PATCH" ? { body: {} } : { status: 500, body: { errors: [] } },
      );
      await expect(
        c.updateResource("sendgrid-event-webhook", "a:sendgrid-event-webhook:wh1", "a", {
          enabled: "false",
        }),
      ).rejects.toThrow(/500/);
      expect(patches(calls)).toEqual([]);
    });

    it("refuses a blank url", async () => {
      const { c, calls } = client(route);
      await expect(
        c.updateResource("sendgrid-event-webhook", "a:sendgrid-event-webhook:wh1", "a", {
          url: "  ",
        }),
      ).rejects.toThrow(/URL/);
      const { c: noUrl, calls: noUrlCalls } = client((_, m) =>
        m === "PATCH" ? { body: {} } : { body: { id: "wh1" } },
      );
      await expect(
        noUrl.updateResource("sendgrid-event-webhook", "a:sendgrid-event-webhook:wh1", "a", {
          enabled: "false",
        }),
      ).rejects.toThrow(/URL/);
      expect([...patches(calls), ...patches(noUrlCalls)]).toEqual([]);
    });

    it("toggles signing alone without touching the webhook's settings", async () => {
      const { c, calls } = client(route);
      await c.updateResource("sendgrid-event-webhook", "a:sendgrid-event-webhook:wh1", "a", {
        signed: "true",
      });
      expect(patches(calls)).toEqual([
        { path: "/v3/user/webhooks/event/settings/signed/wh1", body: { enabled: true } },
      ]);
    });
  });

  describe("detail pages read what only the list documents", () => {
    const WEBHOOK = "/v3/user/webhooks/event/settings/wh1";
    const DOMAIN = "/v3/whitelabel/domains/5";
    const IP = "/v3/ips/1.2.3.4";

    it("dates an event webhook from the list", async () => {
      const { c } = client((url) =>
        url.pathname === WEBHOOK
          ? { body: { id: "wh1", url: "https://example.com/e" } }
          : {
              body: {
                webhooks: [
                  { id: "other", created_date: "2020-01-01T00:00:00Z" },
                  {
                    id: "wh1",
                    created_date: "2021-01-01T00:00:00Z",
                    updated_date: "2022-01-01T00:00:00Z",
                  },
                ],
              },
            },
      );
      const r = await c.getResource("sendgrid-event-webhook", `a:t:wh1`, "a");
      expect(r.fields["createdAt"]).toBe("2021-01-01T00:00:00Z");
      expect(r.fields["updatedAt"]).toBe("2022-01-01T00:00:00Z");
      expect(r.fields["url"]).toBe("https://example.com/e");
    });

    it("reads an IP's assignment date from the list, matching the exact address", async () => {
      const { c, calls } = client((url) =>
        url.pathname === IP
          ? { body: { ip: "1.2.3.4", pools: ["p1"], warmup: false } }
          : {
              body: [
                { ip: "1.2.3.40", assigned_at: 1000 },
                { ip: "1.2.3.4", assigned_at: 1600000000, pools: ["stale"] },
              ],
            },
      );
      const r = await c.getResource("sendgrid-ip", "a:t:1.2.3.4", "a");
      expect(r.fields["assignedAt"]).toBe(new Date(1600000000_000).toISOString());
      expect(r.fields["pools"]).toBe("p1");
      expect(calls[1]!.url.pathname).toBe("/v3/ips");
      expect(calls[1]!.url.searchParams.get("ip")).toBe("1.2.3.4");
    });

    it("reads a domain's subusers and last validation from the list", async () => {
      const { c, calls } = client((url) =>
        url.pathname === DOMAIN
          ? { body: { id: 5, domain: "example.com", valid: true, dns: {} } }
          : {
              body: [
                { id: 4, domain: "example.com", subusers: [{ username: "wrong" }] },
                {
                  id: 5,
                  domain: "example.com",
                  valid: false,
                  subusers: [{ user_id: 1, username: "sub1" }],
                  last_validation_attempt_at: 1600000000,
                },
              ],
            },
      );
      const r = await c.getResource("sendgrid-domain", "a:t:5", "a");
      expect(r.fields["subusers"]).toBe("sub1");
      expect(r.fields["lastValidationAt"]).toBe(new Date(1600000000_000).toISOString());
      expect(r.fields["valid"]).toBe(true);
      expect(calls[1]!.url.pathname).toBe("/v3/whitelabel/domains");
      expect(calls[1]!.url.searchParams.get("domain")).toBe("example.com");
    });

    it("skips the list when the single read already has the fields", async () => {
      const { c, calls } = client((url) => {
        if (url.pathname === WEBHOOK) {
          return { body: { id: "wh1", created_date: "2021", updated_date: "2022" } };
        }
        if (url.pathname === IP) return { body: { ip: "1.2.3.4", assigned_at: null } };
        if (url.pathname === DOMAIN) {
          return { body: { id: 5, subusers: [], last_validation_attempt_at: 1 } };
        }
        throw new Error(`unexpected ${url.pathname}`);
      });
      await c.getResource("sendgrid-event-webhook", "a:t:wh1", "a");
      await c.getResource("sendgrid-ip", "a:t:1.2.3.4", "a");
      await c.getResource("sendgrid-domain", "a:t:5", "a");
      expect(calls).toHaveLength(3);
    });

    it("still opens the page when the list read fails", async () => {
      const { c } = client((url) => {
        if (url.pathname === WEBHOOK) return { body: { id: "wh1", url: "https://e.example" } };
        if (url.pathname === IP) return { body: { ip: "1.2.3.4" } };
        if (url.pathname === DOMAIN) return { body: { id: 5, domain: "example.com" } };
        return { status: 500, body: { errors: [{ message: "down" }] } };
      });
      const hook = await c.getResource("sendgrid-event-webhook", "a:t:wh1", "a");
      expect(hook.fields["url"]).toBe("https://e.example");
      expect((await c.getResource("sendgrid-ip", "a:t:1.2.3.4", "a")).fields["ip"]).toBe("1.2.3.4");
      expect((await c.getResource("sendgrid-domain", "a:t:5", "a")).fields["domain"]).toBe(
        "example.com",
      );
    });
  });

  it("synthesises DNS records and reads the key id", () => {
    const recs = domainDnsRecords("a", {
      id: 5,
      domain: "example.com",
      dns: {
        mail_cname: {
          valid: true,
          type: "cname",
          host: "em1.example.com",
          data: "u1.wl.sendgrid.net",
        },
        dkim1: {
          valid: false,
          type: "cname",
          host: "s1._domainkey.example.com",
          data: "s1.domainkey.u1.wl.sendgrid.net",
        },
      },
    });
    expect(recs.map((r) => [r.externalId, r.fields["type"], r.fields["valid"]])).toEqual([
      ["domain/5/mail_cname", "CNAME", true],
      ["domain/5/dkim1", "CNAME", false],
    ]);
    expect(keyIdOf("SG.abc.def")).toBe("abc");
    expect(parseScopes('["mail.send","mail.send"]')).toEqual(["mail.send"]);
  });

  it("keeps only SendGrid incidents from Twilio's status page", () => {
    const body = JSON.stringify({
      incidents: [
        {
          id: "1",
          name: "SMS delays",
          status: "investigating",
          components: [{ name: "SMS Long Code" }],
        },
        { id: "2", name: "Delays", status: "identified", components: [{ name: "SMTP" }] },
      ],
    });
    const out = parseStatusFeed(body);
    expect(out.map((i) => i.externalId)).toEqual(["2"]);
    expect(out[0]!.providerWide).toBe(true);
  });
});
