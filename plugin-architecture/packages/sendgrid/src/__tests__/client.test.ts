import { describe, expect, it } from "vitest";
import { SendGridApiError } from "../api.js";
import { SendGridClient, parseScopes } from "../client.js";
import { domainDnsRecords, keyIdOf } from "../mappers.js";
import { parseStatusFeed } from "../status-feed.js";

function client(
  route: (url: URL, method: string) => { status?: number; body?: unknown },
  creds: Record<string, string> = {},
) {
  const calls: Array<{ url: URL; method: string; headers: Record<string, string> }> = [];
  const http = {
    async request(req: { url: string; method: string; headers: Record<string, string> }) {
      const url = new URL(req.url);
      calls.push({ url, method: req.method, headers: req.headers });
      const r = route(url, req.method);
      return {
        status: r.status ?? 200,
        headers: {},
        body: r.body === undefined ? "" : JSON.stringify(r.body),
      };
    },
  };
  return { c: new SendGridClient({ apiKey: "SG.kid.secret", ...creds }, { http } as never), calls };
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
