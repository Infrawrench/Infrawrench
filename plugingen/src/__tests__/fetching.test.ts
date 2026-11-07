import { afterEach, describe, expect, it, vi } from "vitest";
import { PluginGenError } from "../errors.js";
import { createFetcher } from "../fetching.js";

const URL_ = "https://vendor.test/doc.json";

function stubFetch(...responses: (Response | Error)[]) {
  const mock = vi.fn(async (_url: string, _init?: RequestInit) => {
    const next = responses.shift();
    if (!next) throw new Error("no more responses");
    if (next instanceof Error) throw next;
    return next;
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

async function kindOf(run: Promise<string>): Promise<string> {
  try {
    await run;
  } catch (error) {
    if (error instanceof PluginGenError) return error.kind;
    throw error;
  }
  return "resolved";
}

const instantly = { sleep: () => Promise.resolve() };

afterEach(() => vi.unstubAllGlobals());

describe("createFetcher", () => {
  it("returns the body, with a generic User-Agent and a timeout signal", async () => {
    const mock = stubFetch(new Response("{}"));
    await expect(createFetcher(instantly)(URL_)).resolves.toBe("{}");
    const init = mock.mock.calls[0]?.[1];
    const agent = new Headers(init?.headers).get("user-agent") ?? "";
    expect(agent).toMatch(/^plugingen/);
    expect(agent).not.toContain("@");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("retries a server error and then succeeds", async () => {
    const mock = stubFetch(new Response("", { status: 503 }), new Response("ok"));
    await expect(createFetcher(instantly)(URL_)).resolves.toBe("ok");
    expect(mock).toHaveBeenCalledTimes(2);
  });

  it("retries a rate limit, waiting as long as it asks", async () => {
    stubFetch(
      new Response("", { status: 429, headers: { "retry-after": "7" } }),
      new Response("ok"),
    );
    const sleep = vi.fn(() => Promise.resolve());
    await createFetcher({ sleep })(URL_);
    const waited: unknown = sleep.mock.lastCall?.at(0);
    expect(waited).toBeGreaterThanOrEqual(7000);
  });

  it("does not retry a 404, and calls it unavailable rather than transient", async () => {
    const mock = stubFetch(new Response("", { status: 404 }));
    await expect(kindOf(createFetcher(instantly)(URL_))).resolves.toBe("unavailable");
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it("calls running out of retries a network failure", async () => {
    const mock = stubFetch(
      new TypeError("fetch failed"),
      new Response("", { status: 502 }),
      new Error("reset"),
    );
    await expect(kindOf(createFetcher(instantly)(URL_))).resolves.toBe("network");
    expect(mock).toHaveBeenCalledTimes(3);
  });

  it("gives up on a document over the limit", async () => {
    stubFetch(new Response("0123456789"));
    await expect(kindOf(createFetcher({ ...instantly, maxBytes: 4 })(URL_))).resolves.toBe("parse");
  });

  it("times out an attempt whose body never arrives", async () => {
    vi.stubGlobal("fetch", (_url: string, init?: RequestInit) => {
      const body = new ReadableStream({
        start(controller) {
          init?.signal?.addEventListener("abort", () => controller.error(init.signal?.reason));
        },
      });
      return Promise.resolve(new Response(body));
    });
    const fetcher = createFetcher({ ...instantly, timeoutMs: 5, attempts: 1 });
    await expect(kindOf(fetcher(URL_))).resolves.toBe("network");
  });
});
