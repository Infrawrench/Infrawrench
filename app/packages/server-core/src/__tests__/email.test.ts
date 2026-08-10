import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The Mailgun transport. Everything here is about the wire format, because
 * that is what a provider swap breaks and what no other test covers: the
 * region-aware URL, basic auth with the literal `api` username, and the
 * multipart body whose Content-Type must be left to `fetch` so the boundary
 * survives.
 *
 * The fan-out contract matters just as much as the request: `sendEmails` must
 * never throw (it runs on the poller's tick) and must report what landed, since
 * `classifyDelivery` decides whether the digest retries from those counts.
 */
import { isEmailConfigured, normalizeEmailAddress, sendEmails } from "../email";

const ENV_KEYS = ["MAILGUN_API_KEY", "MAILGUN_DOMAIN", "MAILGUN_API_BASE", "EMAIL_FROM"] as const;

let saved: Record<string, string | undefined> = {};
let fetchMock: ReturnType<typeof vi.fn>;

/** The single request `fetch` was called with, decoded into something assertable. */
async function lastRequest(): Promise<{
  url: string;
  auth: string | undefined;
  contentType: string | undefined;
  fields: Record<string, string>;
}> {
  const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  const headers = (init.headers ?? {}) as Record<string, string>;
  const fields: Record<string, string> = {};
  for (const [k, v] of init.body as FormData) fields[k] = String(v);
  return {
    url,
    auth: headers["Authorization"],
    contentType: headers["Content-Type"] ?? headers["content-type"],
    fields,
  };
}

function ok() {
  return { ok: true, status: 200, text: async () => "{}" } as unknown as Response;
}

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env["MAILGUN_API_KEY"] = "key-secret";
  process.env["MAILGUN_DOMAIN"] = "mg.example.com";
  process.env["EMAIL_FROM"] = "Infrawrench <digest@mg.example.com>";
  delete process.env["MAILGUN_API_BASE"];
  fetchMock = vi.fn(async () => ok());
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const message = (to = "someone@example.com") => ({
  to,
  subject: "Weekly digest",
  text: "plain",
  html: "<p>rich</p>",
});

describe("isEmailConfigured", () => {
  it("needs the key, the domain and the sender — any one missing disables mail", () => {
    expect(isEmailConfigured()).toBe(true);
    for (const k of ["MAILGUN_API_KEY", "MAILGUN_DOMAIN", "EMAIL_FROM"] as const) {
      const held = process.env[k];
      delete process.env[k];
      expect(isEmailConfigured()).toBe(false);
      process.env[k] = held;
    }
  });

  it("does not require the region override — US is the default", () => {
    expect(isEmailConfigured()).toBe(true);
  });
});

describe("sendEmails — the Mailgun request", () => {
  it("posts to the US messages endpoint for the configured domain", async () => {
    await sendEmails([message()], "test");
    const { url } = await lastRequest();
    expect(url).toBe("https://api.mailgun.net/v3/mg.example.com/messages");
  });

  it("honours an EU account's base host, and tolerates a trailing slash", async () => {
    process.env["MAILGUN_API_BASE"] = "https://api.eu.mailgun.net/";
    await sendEmails([message()], "test");
    const { url } = await lastRequest();
    expect(url).toBe("https://api.eu.mailgun.net/v3/mg.example.com/messages");
  });

  it("authenticates as the literal user `api` with the key as the password", async () => {
    await sendEmails([message()], "test");
    const { auth } = await lastRequest();
    expect(auth).toBe(`Basic ${Buffer.from("api:key-secret").toString("base64")}`);
  });

  it("leaves Content-Type to fetch so the multipart boundary survives", async () => {
    // Setting it by hand is the classic way to break a FormData POST: the
    // header would carry no boundary and Mailgun could not parse the body.
    await sendEmails([message()], "test");
    const { contentType } = await lastRequest();
    expect(contentType).toBeUndefined();
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.body).toBeInstanceOf(FormData);
  });

  it("sends the sender, recipient, subject and both body parts", async () => {
    await sendEmails([message("dev@example.com")], "test");
    const { fields } = await lastRequest();
    expect(fields).toMatchObject({
      from: "Infrawrench <digest@mg.example.com>",
      to: "dev@example.com",
      subject: "Weekly digest",
      text: "plain",
      html: "<p>rich</p>",
    });
  });

  it("hangs attachments off the same multipart form, with their filenames", async () => {
    // What an invoice ships as: the document travels with the message rather
    // than as a link that has to keep resolving years later.
    await sendEmails(
      [
        {
          ...message(),
          attachments: [
            {
              filename: "INV-2026-0001.csv",
              content: "invoice_number\nINV-2026-0001\n",
              contentType: "text/csv; charset=utf-8",
            },
          ],
        },
      ],
      "test",
    );
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const files = (init.body as FormData).getAll("attachment");
    expect(files).toHaveLength(1);
    const file = files[0] as File;
    // The name the recipient's mail client shows; without it Mailgun says `blob`.
    expect(file.name).toBe("INV-2026-0001.csv");
    expect(file.type).toBe("text/csv; charset=utf-8");
    expect(await file.text()).toContain("INV-2026-0001");
  });

  it("omits html entirely for a text-only message", async () => {
    await sendEmails([{ to: "a@example.com", subject: "s", text: "t" }], "test");
    const { fields } = await lastRequest();
    expect(fields["text"]).toBe("t");
    expect(fields).not.toHaveProperty("html");
  });

  it("carries a trace key as a Mailgun custom variable, not a header", async () => {
    await sendEmails([{ ...message(), traceKey: "digest:org:2026-07-20:scheduled:a@b.c" }], "test");
    const { fields } = await lastRequest();
    expect(fields["v:infrawrench-key"]).toBe("digest:org:2026-07-20:scheduled:a@b.c");
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.headers).not.toHaveProperty("Idempotency-Key");
  });

  it("truncates an over-long trace key rather than letting the API reject it", async () => {
    await sendEmails([{ ...message(), traceKey: "x".repeat(400) }], "test");
    const { fields } = await lastRequest();
    expect(fields["v:infrawrench-key"]).toHaveLength(256);
  });
});

describe("sendEmails — fan-out", () => {
  it("sends one request per address so the list is never disclosed", async () => {
    await sendEmails([message("a@example.com"), message("b@example.com")], "test");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const recipients = await Promise.all(
      fetchMock.mock.calls.map(async ([, init]) => {
        const fields: Record<string, string> = {};
        for (const [k, v] of (init as RequestInit).body as FormData) fields[k] = String(v);
        return fields["to"];
      }),
    );
    expect(recipients.sort()).toEqual(["a@example.com", "b@example.com"]);
  });

  it("counts a partial failure rather than throwing — the poller must not fail", async () => {
    fetchMock.mockResolvedValueOnce(ok()).mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: async () => '{"message":"not a valid address"}',
    } as unknown as Response);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await sendEmails([message("a@example.com"), message("bad")], "test");

    expect(result).toEqual({ attempted: 2, succeeded: 1, failed: 1 });
    // The provider's body says which field was wrong; the status alone does not.
    expect(String(spy.mock.calls[0]?.[1])).toContain("not a valid address");
    spy.mockRestore();
  });

  it("survives a rejected request (DNS, timeout) with a zero-success result", async () => {
    fetchMock.mockRejectedValue(new Error("getaddrinfo ENOTFOUND"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    // succeeded === 0 is exactly what makes the digest's attempt retryable.
    await expect(sendEmails([message()], "test")).resolves.toEqual({
      attempted: 1,
      succeeded: 0,
      failed: 1,
    });
    spy.mockRestore();
  });

  it("is a logged no-op when the deployment has no mail provider", async () => {
    delete process.env["MAILGUN_DOMAIN"];
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await sendEmails([message()], "weekly digest");

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toEqual({ attempted: 0, succeeded: 0, failed: 0 });
    // The warning is the whole point: recipients configured but no provider
    // must not be silent.
    expect(String(spy.mock.calls[0]?.[0])).toContain("MAILGUN_DOMAIN");
    spy.mockRestore();
  });

  it("does not call out at all for an empty recipient list", async () => {
    expect(await sendEmails([], "test")).toEqual({ attempted: 0, succeeded: 0, failed: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("normalizeEmailAddress", () => {
  it("trims and lowercases", () => {
    expect(normalizeEmailAddress("  Dev@Example.COM ")).toBe("dev@example.com");
  });

  it("rejects what is obviously not an address", () => {
    for (const bad of ["", "   ", "nope", "a@b", "a b@c.com", "a@b,c.com"]) {
      expect(() => normalizeEmailAddress(bad)).toThrow();
    }
  });

  it("accepts plus-addressing and subdomains", () => {
    expect(normalizeEmailAddress("dev+digest@mg.example.co.uk")).toBe(
      "dev+digest@mg.example.co.uk",
    );
  });
});
