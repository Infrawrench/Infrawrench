import { hostClient, runPluginEffect } from "@infrawrench/plugin-base/effect";
import { describe, expect, it, vi } from "vitest";
import { SendGridApiError } from "../api.js";
import { SendGridClient, parseScopes } from "../client.js";
import { plugin } from "../plugin.js";
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

  describe("a list that cannot say it has every row throws", () => {
    const row = (i: number) => ({
      id: i,
      username: `u${i}`,
      domain: `d${i}.com`,
      ip: `10.0.0.${i}`,
    });
    const fullPage = (url: URL) => {
      const offset = Number(url.searchParams.get("offset"));
      return Array.from({ length: 100 }, (_, i) => row(offset + i));
    };

    it.each([
      ["sendgrid-domain", "/v3/whitelabel/domains"],
      ["sendgrid-reverse-dns", "/v3/whitelabel/ips"],
      ["sendgrid-ip", "/v3/ips"],
      ["sendgrid-subuser", "/v3/subusers"],
    ])("%s stops at 50,000 rows", async (type, path) => {
      const { c, calls } = client((url) => ({ body: fullPage(url) }));
      await expect(c.listResources(type, "a")).rejects.toThrow("has more than Infrawrench reads");
      expect(calls).toHaveLength(500);
      expect(calls[0]!.url.pathname).toBe(path);
    });

    it("reads an offset list the old cap would have cut at 5,000 rows", async () => {
      const { c, calls } = client((url) => {
        const offset = Number(url.searchParams.get("offset"));
        return { body: offset < 12_000 ? fullPage(url) : [row(offset)] };
      });
      expect(await c.listResources("sendgrid-domain", "a")).toHaveLength(12_001);
      expect(calls).toHaveLength(121);
    });

    it("rejects an offset page that is not a list, first or later, and an empty answer", async () => {
      const wrapped = client(() => ({ body: { errors: [] } })).c;
      await expect(wrapped.listResources("sendgrid-domain", "a")).rejects.toThrow("is not a list");
      const later = client((url) =>
        url.searchParams.get("offset") === "0" ? { body: fullPage(url) } : { body: { items: [] } },
      ).c;
      await expect(later.listResources("sendgrid-domain", "a")).rejects.toThrow("is not a list");
      const empty = client(() => ({})).c;
      await expect(empty.listResources("sendgrid-domain", "a")).rejects.toThrow("is not a list");
    });

    it.each([
      ["sendgrid-api-key", "/v3/api_keys"],
      ["sendgrid-link-branding", "/v3/whitelabel/links"],
      ["sendgrid-ip-pool", "/v3/ips/pools"],
      ["sendgrid-event-webhook", "/v3/user/webhooks/event/settings/all"],
      ["sendgrid-inbound-parse", "/v3/user/webhooks/parse/settings"],
      ["sendgrid-template", "/v3/templates"],
      ["sendgrid-unsubscribe-group", "/v3/asm/groups"],
      ["sendgrid-verified-sender", "/v3/verified_senders"],
      ["sendgrid-alert", "/v3/alerts"],
    ])("%s rejects a page that is not a list, not reading it as empty", async (type, path) => {
      const renamed = client(() => ({ body: { renamed: [] } }));
      await expect(renamed.c.listResources(type, "a")).rejects.toThrow("is not a list");
      expect(renamed.calls[0]!.url.pathname).toBe(path);
      const empty = client(() => ({}));
      await expect(empty.c.listResources(type, "a")).rejects.toThrow("is not a list");
    });

    it("rejects DNS records when one of the lists behind them is not a list", async () => {
      const { c } = client((url) =>
        url.pathname === "/v3/whitelabel/links" ? { body: { renamed: [] } } : { body: [] },
      );
      await expect(c.listResources("sendgrid-dns-record", "a")).rejects.toThrow("is not a list");
    });

    it("lists empty lists as empty", async () => {
      const bodies: Record<string, unknown> = {
        "/v3/api_keys": { result: [] },
        "/v3/user/webhooks/event/settings/all": { max_allowed: 5, webhooks: [] },
        "/v3/user/webhooks/parse/settings": { result: [] },
        "/v3/templates": { result: [], _metadata: { count: 0 } },
        "/v3/verified_senders": { results: [] },
      };
      const { c } = client((url) => ({ body: bodies[url.pathname] ?? [] }));
      for (const type of [
        "sendgrid-api-key",
        "sendgrid-domain",
        "sendgrid-link-branding",
        "sendgrid-reverse-dns",
        "sendgrid-dns-record",
        "sendgrid-ip",
        "sendgrid-ip-pool",
        "sendgrid-subuser",
        "sendgrid-event-webhook",
        "sendgrid-inbound-parse",
        "sendgrid-template",
        "sendgrid-unsubscribe-group",
        "sendgrid-verified-sender",
        "sendgrid-alert",
      ]) {
        expect(await c.listResources(type, "a")).toEqual([]);
      }
    });

    it("rejects branded links when the one page it can ask for is full", async () => {
      const page = (n: number) =>
        Array.from({ length: n }, (_, i) => ({ id: i, domain: "example.com", subdomain: `l${i}` }));
      const full = client(() => ({ body: page(500) })).c;
      await expect(full.listResources("sendgrid-link-branding", "a")).rejects.toThrow(
        "has more than Infrawrench reads",
      );
      const fits = client(() => ({ body: page(499) })).c;
      expect(await fits.listResources("sendgrid-link-branding", "a")).toHaveLength(499);
    });

    describe("templates", () => {
      const NEXT = "https://api.sendgrid.com/v3/templates?page_token=";

      it("reads past the old cap of 25 pages, and throws at 250", async () => {
        const reads = (pages: number) =>
          client((url) => {
            const at = Number(url.searchParams.get("page_token") ?? 0);
            return {
              body: {
                result: [{ id: `t${at}`, name: "x" }],
                _metadata: at + 1 < pages ? { next: `${NEXT}${at + 1}` } : {},
              },
            };
          });
        expect(await reads(30).c.listResources("sendgrid-template", "a")).toHaveLength(30);
        const endless = reads(10_000);
        await expect(endless.c.listResources("sendgrid-template", "a")).rejects.toThrow(
          "has more than Infrawrench reads",
        );
        expect(endless.calls).toHaveLength(250);
      });

      it("rejects a later page that is not a list", async () => {
        const { c } = client((url) =>
          url.searchParams.get("page_token")
            ? { body: { renamed: [] } }
            : { body: { result: [{ id: "t" }], _metadata: { next: `${NEXT}2` } } },
        );
        await expect(c.listResources("sendgrid-template", "a")).rejects.toThrow("is not a list");
      });

      it.each([
        ["with no token", "https://api.sendgrid.com/v3/templates"],
        ["that repeats the token", `${NEXT}same`],
        ["that cannot be parsed", "not a url"],
      ])("rejects a next link %s while count says more are left", async (_name, next) => {
        const { c } = client(() => ({
          body: { result: [{ id: "t" }], _metadata: { next, count: 99 } },
        }));
        await expect(c.listResources("sendgrid-template", "a")).rejects.toThrow(
          "has more than Infrawrench reads",
        );
      });

      it("ends on a repeated next link once count says every row was read", async () => {
        const { c } = client((url) => ({
          body: {
            result: [{ id: `t${url.searchParams.get("page_token") ?? "first"}` }],
            _metadata: { next: `${NEXT}same`, count: 2 },
          },
        }));
        expect(await c.listResources("sendgrid-template", "a")).toHaveLength(2);
      });

      it("takes only the token from a next link, never its host", async () => {
        const { c, calls } = client((url) =>
          url.searchParams.get("page_token")
            ? { body: { result: [{ id: "t2" }] } }
            : {
                body: {
                  result: [{ id: "t1" }],
                  _metadata: { next: "https://evil.example/v3/templates?page_token=2" },
                },
              },
        );
        expect(await c.listResources("sendgrid-template", "a")).toHaveLength(2);
        expect(calls.map((x) => x.url.host)).toEqual(["api.sendgrid.com", "api.sendgrid.com"]);
      });
    });

    describe("verified senders", () => {
      const page = (from: number) =>
        Array.from({ length: 100 }, (_, i) => ({ id: from + i + 1, from_email: "a@example.com" }));

      it("reads past the old cap of 5,000 rows, and throws at 50,000", async () => {
        const reads = (rows: number) =>
          client((url) => {
            const after = Number(url.searchParams.get("lastSeenID") ?? 0);
            return { body: { results: after < rows ? page(after) : [] } };
          });
        expect(await reads(6000).c.listResources("sendgrid-verified-sender", "a")).toHaveLength(
          6000,
        );
        const endless = reads(1_000_000);
        await expect(endless.c.listResources("sendgrid-verified-sender", "a")).rejects.toThrow(
          "has more than Infrawrench reads",
        );
        expect(endless.calls).toHaveLength(500);
      });

      it("rejects a full page it cannot read past", async () => {
        const stuck = client(() => ({ body: { results: page(0) } })).c;
        await expect(stuck.listResources("sendgrid-verified-sender", "a")).rejects.toThrow(
          "has more than Infrawrench reads",
        );
      });

      it("rejects a later page that is not a list", async () => {
        const { c } = client((url) =>
          url.searchParams.get("lastSeenID") ? { body: {} } : { body: { results: page(0) } },
        );
        await expect(c.listResources("sendgrid-verified-sender", "a")).rejects.toThrow(
          "is not a list",
        );
      });
    });

    it("still lists a missing scope as empty", async () => {
      const { c } = client(() => ({ status: 403, body: { errors: [{ message: "no" }] } }));
      for (const type of ["sendgrid-domain", "sendgrid-template", "sendgrid-verified-sender"]) {
        expect(await c.listResources(type, "a")).toEqual([]);
      }
    });

    it("gives a subuser picker what it read at its cap rather than failing", async () => {
      const seen: string[] = [];
      const http = {
        async request(req: { url: string }) {
          seen.push(req.url);
          const offset = Number(new URL(req.url).searchParams.get("offset"));
          const rows = Array.from({ length: 100 }, (_, i) => ({ username: `u${offset + i}` }));
          return { status: 200, headers: {}, body: JSON.stringify(rows) };
        },
      };
      const options = await runPluginEffect(
        plugin.listCredentialOptions!("onBehalfOf", { apiKey: "SG.a.b" }, { http } as never),
      );
      expect(options).toHaveLength(5000);
      expect(seen).toHaveLength(50);
    });
  });

  it("sends every call through the host's transport, with no CA of its own", async () => {
    const stub = vi.fn(() => {
      throw new Error("fetch must not be called");
    });
    vi.stubGlobal("fetch", stub);
    try {
      const request = vi.fn(async (_req: object) => ({ status: 200, headers: {}, body: "[]" }));
      const c = hostClient(
        new SendGridClient({ apiKey: "SG.a.b" }, { http: { request } } as never),
      );
      await c.listResources("sendgrid-domain", "a");
      expect(request).toHaveBeenCalledOnce();
      expect(request.mock.calls[0]![0]).not.toHaveProperty("caCert");
      expect(stub).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
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
