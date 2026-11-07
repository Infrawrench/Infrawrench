import { hostClient } from "@infrawrench/plugin-base/effect";
import { describe, expect, it } from "vitest";
import { createResendApi } from "../api.js";
import { ResendClient, WEBHOOK_EVENTS, parseList } from "../client.js";
import { qualify, toIso } from "../mappers.js";
import { mapComponent, parseStatusFeed } from "../status-feed.js";
import type { Call } from "./helpers.js";
import { makeHttp } from "./helpers.js";

const ACC = "acc";

function client(route: (call: Call) => unknown, extra: Record<string, unknown> = {}) {
  const { http, calls } = makeHttp(route);
  const c = hostClient(new ResendClient({ apiKey: "re_KEY" }, { http, ...extra } as never));
  return { c, calls };
}

const DOMAIN = {
  id: "d1",
  name: "mail.acme.test",
  status: "partially_verified",
  region: "eu-west-1",
  created_at: "2026-09-01 10:00:00.123456+00",
  capabilities: { sending: "enabled", receiving: "disabled" },
  records: [
    {
      record: "DKIM",
      name: "resend._domainkey",
      type: "TXT",
      ttl: "Auto",
      status: "verified",
      value: "p=MIGf",
    },
    {
      record: "SPF",
      name: "send",
      type: "MX",
      ttl: "Auto",
      status: "pending",
      value: "feedback-smtp.eu-west-1.amazonses.com",
      priority: 10,
    },
    {
      record: "SPF",
      name: "send",
      type: "TXT",
      ttl: "Auto",
      status: "failed",
      value: "v=spf1 include:amazonses.com ~all",
    },
  ],
};

describe("api", () => {
  it("pages with an after cursor and sends Bearer auth", async () => {
    const { http, calls } = makeHttp((call) =>
      call.url.searchParams.get("after")
        ? { data: [{ id: "c" }], has_more: false }
        : { data: [{ id: "a" }, { id: "b" }], has_more: true },
    );
    const api = createResendApi({ apiKey: "re_K", http });
    const out = await api.getAll("/contacts", "data");
    expect(out.map((x) => x.id)).toEqual(["a", "b", "c"]);
    expect(calls[1]?.url.searchParams.get("after")).toBe("b");
    expect(calls[0]?.url.searchParams.get("limit")).toBe("100");
    expect(calls[0]?.headers["Authorization"]).toBe("Bearer re_K");
  });

  it("retries a 429 after retry-after, but not a quota 429", async () => {
    let n = 0;
    const waits: number[] = [];
    const { http } = makeHttp(() =>
      ++n === 1
        ? {
            status: 429,
            headers: { "retry-after": "2" },
            body: { name: "rate_limit_exceeded", message: "slow down" },
          }
        : { ok: true },
    );
    const sleep = async (ms: number) => {
      waits.push(ms);
    };
    await expect(createResendApi({ apiKey: "k", http, sleep }).get("/domains")).resolves.toEqual({
      ok: true,
    });
    expect(waits).toEqual([2000]);

    const quota = makeHttp(() => ({
      status: 429,
      body: { name: "monthly_quota_exceeded", message: "quota" },
    }));
    await expect(
      createResendApi({ apiKey: "k", http: quota.http, sleep }).get("/emails"),
    ).rejects.toMatchObject({ status: 429 });
    expect(quota.calls).toHaveLength(1);
  });

  it("maps errors with a numeric status and Resend's error name", async () => {
    const { c } = client(() => ({
      status: 401,
      body: {
        statusCode: 401,
        name: "restricted_api_key",
        message: "This API key is restricted to only send emails",
      },
    }));
    const err = await c.listResources("resend-account", ACC).catch((e: unknown) => e);
    expect((err as { status: number }).status).toBe(401);
    expect(String(err)).toMatch(/Full access/);
  });
});

describe("domains and DNS records", () => {
  it("re-reads each domain for its records and qualifies relative names", async () => {
    const { c, calls } = client((call) => {
      if (call.url.pathname === "/domains")
        return { data: [{ id: "d1", name: "mail.acme.test" }], has_more: false };
      if (call.url.pathname === "/domains/d1") return DOMAIN;
      throw new Error(call.url.pathname);
    });
    const [domain] = await c.listResources("resend-domain", ACC);
    expect(domain?.fields["recordsVerified"]).toBe(1);
    expect(domain?.fields["recordsTotal"]).toBe(3);
    expect(domain?.createdAt).toBe("2026-09-01T10:00:00.123Z");
    const records = await c.listResources("resend-dns-record", ACC);
    // Cached: no second round of domain reads.
    expect(calls.filter((x) => x.url.pathname === "/domains/d1")).toHaveLength(1);
    expect(records.map((r) => r.fields["name"])).toEqual([
      "resend._domainkey.mail.acme.test",
      "send.mail.acme.test",
      "send.mail.acme.test",
    ]);
    expect(records[1]).toMatchObject({
      parentResourceId: "acc:resend-domain:d1",
      fields: { type: "MX", priority: 10, content: "feedback-smtp.eu-west-1.amazonses.com" },
    });
    expect(new Set(records.map((r) => r.id)).size).toBe(3);
    expect(c.renderSidebarItem(records[2]!).status).toMatchObject({ status: "error" });
    expect(c.renderSidebarItem(domain!).status).toMatchObject({ status: "provisioning" });
  });

  it("qualifies record names", () => {
    expect(qualify("@", "a.test")).toBe("a.test");
    expect(qualify("", "a.test")).toBe("a.test");
    expect(qualify("send", "a.test")).toBe("send.a.test");
    expect(qualify("x.a.test.", "a.test")).toBe("x.a.test");
  });

  it("creates a domain with capabilities and region", async () => {
    const { c, calls } = client(() => ({
      id: "d2",
      name: "x.test",
      status: "not_started",
      records: [],
    }));
    await c.createResource("resend-domain", ACC, {
      name: "x.test",
      region: "sa-east-1",
      sending: "enabled",
      receiving: "enabled",
      openTracking: "true",
      clickTracking: "false",
      tls: "enforced",
    });
    expect(calls[0]?.body).toMatchObject({
      name: "x.test",
      region: "sa-east-1",
      open_tracking: true,
      click_tracking: false,
      tls: "enforced",
      capabilities: { sending: "enabled", receiving: "enabled" },
    });
  });

  it("keeps the other capability when only one changes", async () => {
    const { c, calls } = client((call) =>
      call.method === "GET"
        ? { ...DOMAIN, capabilities: { sending: "enabled", receiving: "enabled" } }
        : {},
    );
    await c.updateResource("resend-domain", "acc:resend-domain:d1", ACC, { sending: "disabled" });
    const patch = calls.find((x) => x.method === "PATCH");
    expect(patch?.body).toEqual({ capabilities: { sending: "disabled", receiving: "enabled" } });
  });
});

describe("API keys", () => {
  it("keeps the one-time token and scopes a sending key to a domain", async () => {
    const stored: Record<string, string> = {};
    const secrets = {
      getPlaintext: async (id: string, k: string) => stored[`${id}|${k}`] ?? null,
      setPlaintext: async (id: string, k: string, v: string) => {
        stored[`${id}|${k}`] = v;
      },
    };
    const { c, calls } = client(() => ({ id: "k1", token: "re_secret" }), { secrets });
    const created = await c.createResource("resend-api-key", ACC, {
      name: "ci",
      permission: "sending_access",
      domainId: "d1",
    });
    expect(calls[0]?.body).toEqual({ name: "ci", permission: "sending_access", domain_id: "d1" });
    expect(created.secretStates[0]).toMatchObject({ fieldKey: "token" });
    await expect(c.resolveOutput("resend-api-key", created.id, "token", ACC)).resolves.toBe(
      "re_secret",
    );
  });
});

describe("webhooks", () => {
  it("creates from the event picker and reads the signing secret back on demand", async () => {
    const { c, calls } = client((call) =>
      call.method === "POST"
        ? { id: "w1", signing_secret: "whsec_1" }
        : { id: "w1", endpoint: "https://x.test", signing_secret: "whsec_1" },
    );
    await c.createResource("resend-webhook", ACC, {
      endpoint: "https://x.test",
      events: JSON.stringify(["email.bounced", "email.complained"]),
    });
    expect(calls[0]?.body).toEqual({
      endpoint: "https://x.test",
      events: ["email.bounced", "email.complained"],
    });
    await expect(
      c.resolveOutput("resend-webhook", "acc:resend-webhook:w1", "signingSecret", ACC),
    ).resolves.toBe("whsec_1");
  });

  it("offers a replay action for failed deliveries and replays by event id", async () => {
    const { c, calls } = client((call) => {
      if (call.url.pathname === "/webhooks/w1/events") {
        return {
          data: [
            {
              id: "ev1",
              type: "email.bounced",
              status: "failed",
              created_at: "2026-10-01T00:00:00Z",
            },
          ],
          has_more: false,
        };
      }
      return {};
    });
    const base = {
      id: "acc:resend-webhook:w1",
      pluginId: "resend",
      resourceTypeId: "resend-webhook",
      accountId: ACC,
      displayName: "x",
      externalId: "w1",
      fields: { endpoint: "https://x.test", events: "email.bounced", status: "enabled" },
      resolvedOutputs: {},
      secretStates: [],
      createdAt: "",
      updatedAt: "",
    };
    const detail = c.renderDetail(await c.enrichDetail(base));
    const json = JSON.stringify(detail);
    expect(json).toContain("replay:ev1");
    await c.invokeAction("resend-webhook", base.id, "replay:ev1");
    expect(calls.at(-1)?.url.pathname).toBe("/webhooks/w1/events/ev1/replay");
  });

  it("enables and disables through PATCH status", async () => {
    const { c, calls } = client(() => ({}));
    await c.invokeAction("resend-webhook", "acc:resend-webhook:w1", "disable");
    expect(calls[0]).toMatchObject({ method: "PATCH", body: { status: "disabled" } });
  });

  it("lists the documented event types", () => {
    expect(WEBHOOK_EVENTS).toContain("email.delivery_delayed");
    expect(WEBHOOK_EVENTS).toHaveLength(19);
  });
});

describe("broadcasts", () => {
  it("schedules a broadcast with send=true and an ISO time", async () => {
    const { c, calls } = client((call) =>
      call.method === "POST" ? { id: "b1" } : { id: "b1", status: "scheduled" },
    );
    await c.createResource("resend-broadcast", ACC, {
      segmentId: "s1",
      from: "Acme <news@acme.test>",
      subject: "Hi",
      replyTo: "a@acme.test, b@acme.test",
      sendMode: "schedule",
      scheduledAt: "2026-11-01T09:00:00Z",
    });
    expect(calls[0]?.body).toMatchObject({
      segment_id: "s1",
      send: true,
      scheduled_at: "2026-11-01T09:00:00.000Z",
      reply_to: ["a@acme.test", "b@acme.test"],
    });
  });
});

describe("details the list does not return", () => {
  it("reads a broadcast's sender and content back for the detail page and edit form", async () => {
    const { c, calls } = client((call) =>
      call.url.pathname === "/broadcasts"
        ? { data: [{ id: "b1", name: "News", status: "draft" }], has_more: false }
        : {
            id: "b1",
            name: "News",
            status: "draft",
            subject: "Hello",
            from: "Acme <news@acme.test>",
            reply_to: ["help@acme.test"],
            preview_text: "Read on",
          },
    );
    const [row] = await c.listResources("resend-broadcast", ACC);
    expect(row?.fields["subject"]).toBe("");
    const detail = await c.enrichDetail(row!);
    expect(calls.at(-1)?.url.pathname).toBe("/broadcasts/b1");
    expect(detail.fields).toMatchObject({
      subject: "Hello",
      from: "Acme <news@acme.test>",
      replyTo: "help@acme.test",
      previewText: "Read on",
    });
    expect(JSON.stringify(c.renderDetail(detail))).toContain("Read on");
  });

  it("reads a template's sender, subject and unpublished state back", async () => {
    const { c, calls } = client((call) =>
      call.url.pathname === "/templates"
        ? { data: [{ id: "t1", name: "Welcome", status: "published" }], has_more: false }
        : {
            id: "t1",
            name: "Welcome",
            status: "published",
            from: "Acme <hi@acme.test>",
            subject: "Welcome",
            has_unpublished_versions: true,
          },
    );
    const [row] = await c.listResources("resend-template", ACC);
    expect(row?.fields["hasUnpublishedVersions"]).toBe(false);
    const detail = await c.enrichDetail(row!);
    expect(calls.at(-1)?.url.pathname).toBe("/templates/t1");
    expect(detail.fields).toMatchObject({
      from: "Acme <hi@acme.test>",
      subject: "Welcome",
      hasUnpublishedVersions: true,
    });
  });
});

describe("metrics and quotas", () => {
  it("charts daily metrics for a domain and converts fractional rates to percent", async () => {
    const { c, calls } = client(() => ({
      data: [
        { period: "2026-10-02", sent: 10, delivered: 9, delivery_rate: 0.9 },
        { period: "2026-10-01", sent: 4, delivered: 4, delivery_rate: 1 },
      ],
    }));
    const series = await c.fetchMetricSeries("resend-domain", "acc:resend-domain:d1", ACC, {
      startMs: Date.parse("2026-09-25T00:00:00Z"),
      endMs: Date.parse("2026-10-02T00:00:00Z"),
    });
    const q = calls[0]!.url.searchParams;
    expect(q.get("domain_id")).toBe("d1");
    expect(q.get("dimensions")).toBe("period");
    expect(q.get("granularity")).toBe("daily");
    const sent = series.find((s) => s.label === "Sent");
    expect(sent?.points.map((p) => p.value)).toEqual([4, 10]);
    expect(series.find((s) => s.label === "Delivery rate")?.points[1]?.value).toBe(90);
  });

  it("reports only limits Resend actually sets", async () => {
    const { c } = client(() => ({
      emails: { daily: { used: 5, limit: null }, monthly: { used: 900, limit: 3000 } },
      contacts: { used: 10, limit: 1000 },
      segments: { used: 2, limit: null },
      domains: { used: 1, limit: 1 },
    }));
    const quotas = await c.fetchQuotas(ACC);
    expect(quotas.map((q) => q.id)).toEqual(["emails/monthly", "contacts", "domains"]);
    expect(quotas[0]).toMatchObject({ used: 900, limit: 3000 });
  });
});

describe("logs", () => {
  it("shows API request logs oldest first", async () => {
    const { c } = client(() => ({
      data: [
        {
          id: "l2",
          created_at: "2026-10-02T00:00:00Z",
          endpoint: "/emails",
          method: "POST",
          response_status: 422,
        },
        {
          id: "l1",
          created_at: "2026-10-01T00:00:00Z",
          endpoint: "/domains",
          method: "GET",
          response_status: 200,
        },
      ],
      has_more: false,
    }));
    const out = await c.getLogs("resend-account", "acc:resend-account:account", ACC, {});
    expect(out.text.split("\n")[0]).toContain("GET /domains");
    expect(out.containers).toEqual(["API requests", "Sent emails", "Received emails"]);
  });
});

describe("complete lists", () => {
  const forever = (call: Call) => ({
    data: [{ id: `row-${call.url.searchParams.get("after") ?? "0"}`, endpoint: "/e" }],
    has_more: true,
  });

  it("throws at the cap instead of reading part of an inventory list as all of it", async () => {
    const { c, calls } = client(forever);
    await expect(c.listResources("resend-contact", ACC)).rejects.toThrow(
      "has more than Infrawrench reads",
    );
    expect(calls).toHaveLength(500);
  });

  it("asks for Resend's largest page, and reads 10,000 rows without complaint", async () => {
    let served = 0;
    const { c, calls } = client(() => {
      const data = Array.from({ length: 100 }, () => ({ id: `row-${served++}` }));
      return { data, has_more: served < 10_000 };
    });
    await expect(c.listResources("resend-suppression", ACC)).resolves.toHaveLength(10_000);
    expect(calls[0]?.url.searchParams.get("limit")).toBe("100");
  });

  it("refuses a page whose list is not an array, first or later", async () => {
    const first = client(() => ({ items: [], has_more: false }));
    await expect(first.c.listResources("resend-topic", ACC)).rejects.toThrow("is not a list");

    const later = client((call) =>
      call.url.searchParams.get("after")
        ? { items: [{ id: "b" }], has_more: false }
        : { data: [{ id: "a" }], has_more: true },
    );
    await expect(later.c.listResources("resend-topic", ACC)).rejects.toThrow("is not a list");
  });

  it("keeps the newest page of emails as a rolling window", async () => {
    const { c, calls } = client(forever);
    await expect(c.listResources("resend-email", ACC)).resolves.toHaveLength(1);
    expect(calls).toHaveLength(1);
  });

  it("does not read a failed domain as a domain with no records", async () => {
    const route = (call: Call) =>
      call.url.pathname === "/domains"
        ? { data: [{ id: "d1", name: "mail.acme.test" }], has_more: false }
        : { status: 500, body: { name: "application_error", message: "boom" } };
    await expect(client(route).c.listResources("resend-dns-record", ACC)).rejects.toThrow("boom");
    await expect(client(route).c.listResources("resend-domain", ACC)).rejects.toThrow("boom");
  });

  it("reads a domain deleted since the list as having no records", async () => {
    const { c } = client((call) =>
      call.url.pathname === "/domains"
        ? { data: [{ id: "d1", name: "mail.acme.test" }], has_more: false }
        : { status: 404, body: { name: "not_found", message: "gone" } },
    );
    await expect(c.listResources("resend-dns-record", ACC)).resolves.toEqual([]);
  });

  it("fails rather than read the details of more domains than it can fan out over", async () => {
    const data = Array.from({ length: 1001 }, (_, i) => ({ id: `d${i}`, name: `d${i}.test` }));
    const { c, calls } = client((call) => {
      if (call.url.pathname === "/domains") return { data, has_more: false };
      throw new Error(`unexpected ${call.url.pathname}`);
    });
    await expect(c.listResources("resend-domain", ACC)).rejects.toThrow(
      "has more than Infrawrench reads",
    );
    expect(calls).toHaveLength(1);
  });

  it("offers what it read in a picker when the list is longer than the picker reads", async () => {
    const { c, calls } = client(forever);
    const config = await c.getCreateConfig("resend-contact");
    expect(config.fields.find((f) => f.key === "segments")?.policies).toHaveLength(10);
    expect(calls).toHaveLength(10);
  });

  it("shows the log lines it read when there are more than it asked for", async () => {
    const { c, calls } = client(forever);
    const out = await c.getLogs("resend-account", "acc:resend-account:account", ACC, {
      tailLines: 200,
    });
    expect(calls).toHaveLength(2);
    expect(out.text).toContain("/e");
  });
});

describe("helpers and status", () => {
  it("parses lists and timestamps", () => {
    expect(parseList('["a","b"]')).toEqual(["a", "b"]);
    expect(parseList("a, b")).toEqual(["a", "b"]);
    expect(toIso("2023-04-26 20:21:26.347412+00")).toBe("2023-04-26T20:21:26.347Z");
  });

  it("keeps only unresolved incidents", () => {
    const body = JSON.stringify({
      page: { id: "p", name: "Resend", url: "https://resend-status.com/" },
      incidents: [
        {
          id: "1",
          name: "API errors",
          status: "investigating",
          impact: "minor",
          created_at: "2026-10-06T10:00:00Z",
          updated_at: "2026-10-06T10:00:00Z",
          incident_updates: [],
        },
        {
          id: "2",
          name: "Old",
          status: "resolved",
          impact: "minor",
          created_at: "2026-10-01T10:00:00Z",
          updated_at: "2026-10-01T11:00:00Z",
          resolved_at: "2026-10-01T11:00:00Z",
          incident_updates: [],
        },
      ],
    });
    expect(parseStatusFeed(body).map((i) => i.title)).toEqual(["API errors"]);
    expect(mapComponent("General API")).toMatchObject({ providerWide: true });
    expect(mapComponent("Website")).toBeNull();
  });
});
