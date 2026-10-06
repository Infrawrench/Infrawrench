import { describe, expect, it } from "vitest";
import { evaluatePostureRule } from "@infrawrench/plugin-base";
import { PostmarkApiError } from "../api.js";
import { PostmarkClient, parseAddresses, serverBody } from "../client.js";
import { requiredRecords } from "../mappers.js";
import { seriesFromDays } from "../metrics.js";
import { DomainResourceType } from "../resource-types.js";
import { parseStatusFeed } from "../status-feed.js";

interface Call {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
}

type Route = (url: URL, method: string, body?: unknown) => { status?: number; body?: unknown };

function client(route: Route, credentials: Record<string, string> = { accountToken: "acct" }) {
  const calls: Call[] = [];
  const http = {
    async request(req: {
      url: string;
      method: string;
      headers: Record<string, string>;
      body?: string | Uint8Array;
    }) {
      const url = new URL(req.url);
      const body = typeof req.body === "string" ? JSON.parse(req.body) : undefined;
      calls.push({ url, method: req.method, headers: req.headers, body });
      const reply = route(url, req.method, body);
      return {
        status: reply.status ?? 200,
        headers: {},
        body: reply.body === undefined ? "" : JSON.stringify(reply.body),
      };
    },
  };
  return { c: new PostmarkClient(credentials, { http } as never), calls };
}

const SERVERS = {
  TotalCount: 1,
  Servers: [
    { ID: 7, Name: "Production", ApiTokens: ["srv-7"], DeliveryType: "Live", TrackOpens: true },
  ],
};

describe("credentials", () => {
  it("needs one of the two tokens", () => {
    expect(() => new PostmarkClient({})).toThrow(/account API token/);
    expect(() => new PostmarkClient({ serverToken: "s" })).not.toThrow();
  });
});

describe("servers and server-scoped listings", () => {
  it("lists servers with the account token and uses each server's own token for streams", async () => {
    const { c, calls } = client((url) => {
      if (url.pathname === "/servers") return { body: SERVERS };
      if (url.pathname === "/message-streams") {
        return {
          body: {
            MessageStreams: [
              {
                ID: "outbound",
                Name: "Default Transactional Stream",
                MessageStreamType: "Transactional",
              },
              {
                ID: "news",
                Name: "News",
                MessageStreamType: "Broadcasts",
                ArchivedAt: "2026-09-01T00:00:00Z",
              },
            ],
          },
        };
      }
      return { status: 404, body: { ErrorCode: 404, Message: "nope" } };
    });
    const servers = await c.listResources("postmark-server", "a");
    expect(servers[0]!.externalId).toBe("7");
    expect(servers[0]!.fields["trackOpens"]).toBe(true);

    const streams = await c.listResources("postmark-message-stream", "a");
    expect(streams.map((s) => s.externalId)).toEqual(["7/outbound", "7/news"]);
    expect(streams[1]!.parentResourceId).toBe("a:postmark-server:7");
    expect(streams[1]!.fields["archived"]).toBe(true);

    const serverCall = calls.find((x) => x.url.pathname === "/servers")!;
    expect(serverCall.headers["X-Postmark-Account-Token"]).toBe("acct");
    expect(serverCall.url.searchParams.get("count")).toBe("500");
    const streamCall = calls.find((x) => x.url.pathname === "/message-streams")!;
    expect(streamCall.headers["X-Postmark-Server-Token"]).toBe("srv-7");
    expect(streamCall.url.searchParams.get("IncludeArchivedStreams")).toBe("true");
    // The server list is cached across listers.
    expect(calls.filter((x) => x.url.pathname === "/servers")).toHaveLength(1);
  });

  it("pages count/offset lists until TotalCount", async () => {
    const page = (offset: number) =>
      Array.from({ length: offset === 0 ? 500 : 3 }, (_, i) => ({
        TemplateId: offset + i,
        Name: `t${offset + i}`,
      }));
    const { c, calls } = client((url) => {
      if (url.pathname === "/servers") return { body: SERVERS };
      if (url.pathname === "/templates") {
        const offset = Number(url.searchParams.get("offset"));
        return { body: { TotalCount: 503, Templates: page(offset) } };
      }
      return { status: 404 };
    });
    const templates = await c.listResources("postmark-template", "a");
    expect(templates).toHaveLength(503);
    expect(
      calls
        .filter((x) => x.url.pathname === "/templates")
        .map((x) => x.url.searchParams.get("offset")),
    ).toEqual(["0", "500"]);
  });

  it("works with only a server token, and lists no account-level objects", async () => {
    const { c, calls } = client(
      (url) => {
        if (url.pathname === "/server")
          return { body: { ID: 9, Name: "Solo", ApiTokens: ["ignored"] } };
        if (url.pathname === "/webhooks")
          return {
            body: {
              Webhooks: [
                {
                  ID: 3,
                  Url: "https://x",
                  MessageStream: "outbound",
                  Triggers: { Bounce: { Enabled: true } },
                },
              ],
            },
          };
        return { status: 404 };
      },
      { serverToken: "srv-only" },
    );
    const hooks = await c.listResources("postmark-webhook", "a");
    expect(hooks[0]!.externalId).toBe("9/3");
    expect(hooks[0]!.fields["bounce"]).toBe(true);
    expect(hooks[0]!.fields["delivery"]).toBe(false);
    expect(calls.every((x) => x.headers["X-Postmark-Server-Token"] === "srv-only")).toBe(true);
    expect(await c.listResources("postmark-domain", "a")).toEqual([]);
    expect(await c.listResources("postmark-sender-signature", "a")).toEqual([]);
  });

  it("skips a server whose token is refused rather than failing the sync", async () => {
    const { c } = client((url) => {
      if (url.pathname === "/servers") {
        return {
          body: {
            TotalCount: 2,
            Servers: [
              { ID: 1, Name: "a", ApiTokens: ["t1"] },
              { ID: 2, Name: "b", ApiTokens: ["t2"] },
            ],
          },
        };
      }
      return { body: { TotalCount: 1, InboundRules: [{ ID: 5, Rule: "spam.example" }] } };
    });
    const { c: c2 } = client((url) =>
      url.pathname === "/servers"
        ? { body: SERVERS }
        : { status: 401, body: { ErrorCode: 10, Message: "no" } },
    );
    expect(await c2.listResources("postmark-inbound-rule", "a")).toEqual([]);
    const rules = await c.listResources("postmark-inbound-rule", "a");
    expect(rules.map((r) => r.externalId).sort()).toEqual(["1/5", "2/5"]);
  });
});

describe("domains and required DNS records", () => {
  const DOMAIN = {
    ID: 36735,
    Name: "example.com",
    DKIMVerified: false,
    DKIMHost: "jan2013pm._domainkey.example.com",
    DKIMTextValue: "k=rsa; p=MIGf",
    DKIMPendingHost: "20131031155228pm._domainkey.example.com",
    DKIMPendingTextValue: "k=rsa; p=NEW",
    ReturnPathDomain: "pm-bounces.example.com",
    ReturnPathDomainVerified: true,
    ReturnPathDomainCNAMEValue: "pm.mtasv.net",
  };

  it("synthesises DKIM, pending DKIM and Return-Path records", async () => {
    expect(requiredRecords(DOMAIN).map((r) => `${r.type} ${r.name} ${r.content}`)).toEqual([
      "TXT jan2013pm._domainkey.example.com k=rsa; p=MIGf",
      "TXT 20131031155228pm._domainkey.example.com k=rsa; p=NEW",
      "CNAME pm-bounces.example.com pm.mtasv.net",
    ]);
    const { c } = client((url) => {
      if (url.pathname === "/domains")
        return { body: { TotalCount: 1, Domains: [{ ID: 36735, Name: "example.com" }] } };
      if (url.pathname === "/domains/36735") return { body: DOMAIN };
      return { status: 404 };
    });
    const records = await c.listResources("postmark-dns-record", "a");
    expect(records).toHaveLength(3);
    expect(records[2]!).toMatchObject({
      externalId: "36735/return-path",
      parentResourceId: "a:postmark-domain:36735",
      fields: { type: "CNAME", verified: true, domainName: "example.com" },
    });
    const domains = await c.listResources("postmark-domain", "a");
    expect(
      evaluatePostureRule(DomainResourceType.postureChecks?.[0], domains[0]!.fields),
    ).toBeTruthy();
  });

  it("verify DKIM reports a record Postmark has not seen yet", async () => {
    const { c, calls } = client((url) => {
      if (url.pathname === "/domains/1/verifyDkim") return { body: { ID: 1, DKIMVerified: false } };
      return { status: 404 };
    });
    await expect(
      c.invokeAction("postmark-domain", "a:postmark-domain:1", "verify-dkim", "a"),
    ).rejects.toThrow(/DKIM TXT record/);
    expect(calls[0]!.method).toBe("PUT");
  });
});

describe("errors", () => {
  it("carries the HTTP status and Postmark's ErrorCode", async () => {
    const { c } = client(() => ({
      status: 401,
      body: { ErrorCode: 10, Message: "Bad or missing API token" },
    }));
    const err = await c.listResources("postmark-server", "a").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PostmarkApiError);
    expect((err as PostmarkApiError).status).toBe(401);
    expect((err as PostmarkApiError).code).toBe(10);
    expect((err as Error).message).toMatch(/Bad or missing API token/);
  });
});

describe("edits", () => {
  it("webhook edits merge with the current triggers and keep the auth password", async () => {
    const { c, calls } = client((url, method) => {
      if (url.pathname === "/servers") return { body: SERVERS };
      if (url.pathname === "/webhooks/3" && method === "GET") {
        return {
          body: {
            ID: 3,
            Url: "https://x",
            MessageStream: "outbound",
            HttpAuth: { Username: "u", Password: "secret" },
            Triggers: {
              Delivery: { Enabled: true },
              Bounce: { Enabled: true, IncludeContent: true },
            },
          },
        };
      }
      if (url.pathname === "/webhooks/3" && method === "PUT")
        return { body: { ID: 3, Url: "https://x" } };
      return { status: 404 };
    });
    await c.updateResource("postmark-webhook", "a:postmark-webhook:7/3", "a", {
      click: "true",
      httpAuthUsername: "u2",
    });
    const put = calls.find((x) => x.method === "PUT")!;
    expect(put.headers["X-Postmark-Server-Token"]).toBe("srv-7");
    expect(put.body).toMatchObject({
      Triggers: {
        Delivery: { Enabled: true },
        Bounce: { Enabled: true, IncludeContent: true },
        Click: { Enabled: true },
        Open: { Enabled: false },
      },
      HttpAuth: { Username: "u2", Password: "secret" },
    });
  });

  it("maps server edits to Postmark's fields", () => {
    expect(
      serverBody({
        trackOpens: "false",
        trackLinks: "HtmlOnly",
        inboundSpamThreshold: "5",
        name: " A ",
      }),
    ).toEqual({
      TrackOpens: false,
      TrackLinks: "HtmlOnly",
      InboundSpamThreshold: 5,
      Name: "A",
    });
    expect(() => serverBody({ inboundSpamThreshold: "-1" })).toThrow(/spam threshold/);
  });

  it("deleting a message stream archives it", async () => {
    const { c, calls } = client((url) => {
      if (url.pathname === "/servers") return { body: SERVERS };
      return { body: { ID: "news" } };
    });
    await c.deleteResource("postmark-message-stream", "a:postmark-message-stream:7/news", "a");
    expect(calls.at(-1)!.url.pathname).toBe("/message-streams/news/archive");
    expect(calls.at(-1)!.method).toBe("POST");
  });
});

describe("suppressions", () => {
  it("batches pasted addresses 50 at a time and reports failures", async () => {
    const emails = Array.from({ length: 60 }, (_, i) => `u${i}@example.com`).join("\n");
    const { c, calls } = client((url, _m, body) => {
      if (url.pathname === "/servers") return { body: SERVERS };
      const list = (body as { Suppressions: Array<{ EmailAddress: string }> }).Suppressions;
      return {
        body: {
          Suppressions: list.map((s) => ({ EmailAddress: s.EmailAddress, Status: "Suppressed" })),
        },
      };
    });
    await c.executeNoSqlCommand(
      "postmark-message-stream",
      "a:postmark-message-stream:7/outbound",
      "a",
      "add-suppressions",
      [JSON.stringify({ emails })],
    );
    const posts = calls.filter((x) => x.url.pathname === "/message-streams/outbound/suppressions");
    expect(posts.map((p) => (p.body as { Suppressions: unknown[] }).Suppressions.length)).toEqual([
      50, 10,
    ]);
    expect(parseAddresses("a@x.com, a@x.com\nnot-an-email b@y.org")).toEqual([
      "a@x.com",
      "b@y.org",
    ]);
  });
});

describe("metrics and status", () => {
  it("sums day rows into series", () => {
    const s = seriesFromDays(
      [
        { Date: "2026-10-02", SoftBounce: 1, Transient: 2 },
        { Date: "2026-10-01", SoftBounce: 3 },
      ],
      { label: "Soft bounces", fields: ["SoftBounce", "Transient"], unit: "emails" },
    );
    expect(s?.points.map((p) => p.value)).toEqual([3, 3]);
    expect(s?.points[0]!.timestamp).toBe(Date.parse("2026-10-01T00:00:00Z"));
  });

  it("parses Sorry notices into provider-wide incidents", () => {
    const body = JSON.stringify({
      notices: [
        { id: 1, type: "planned", state: "scheduled", timeline_state: "future", subject: "Later" },
        {
          id: 2,
          type: "unplanned",
          state: "identified",
          timeline_state: "present",
          subject: "Sending delays",
          began_at: "2026-10-06T10:00:00Z",
          latest_update: { content: "<p>Looking</p>" },
        },
        {
          id: 3,
          type: "planned",
          state: "underway",
          timeline_state: "present",
          subject: "DB work",
        },
        {
          id: 4,
          type: "unplanned",
          state: "resolved",
          timeline_state: "past_recent",
          subject: "Old",
          ended_at: "2026-10-05T00:00:00Z",
        },
        {
          id: 5,
          type: "unplanned",
          state: "resolved",
          timeline_state: "past_distant",
          subject: "Ancient",
        },
      ],
    });
    const incidents = parseStatusFeed(body);
    expect(incidents.map((i) => [i.externalId, i.state, i.impact])).toEqual([
      ["2", "identified", "major"],
      ["3", "monitoring", "maintenance"],
      ["4", "resolved", "major"],
    ]);
    expect(incidents[0]!.providerWide).toBe(true);
    expect(incidents[2]!.resolvedAt).toBe("2026-10-05T00:00:00Z");
    expect(() => parseStatusFeed("{}")).toThrow();
  });
});
