import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchStatusFeedBody } from "../status/fetch-feed";

const FEED = "https://status.example.com/api/v2/incidents.json";
const PROXY = "https://egress.example.com";

/** What the proxy returns for an upstream answer. */
function proxyReply(status: number, body: string): Response {
  return new Response(
    JSON.stringify({
      response: {
        status,
        statusText: "",
        url: FEED,
        headers: {},
        bodyBase64: Buffer.from(body).toString("base64"),
        redirected: false,
      },
    }),
    { headers: { "content-type": "application/json" } },
  );
}

describe("fetchStatusFeedBody", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("WORKFLOW_FETCH_PROXY_URL", PROXY);
    vi.stubEnv("WORKFLOW_FETCH_PROXY_TOKEN", "token");
  });

  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("goes through the egress proxy with a User-Agent", async () => {
    fetchMock.mockResolvedValueOnce(proxyReply(200, '{"incidents":[]}'));
    await expect(fetchStatusFeedBody(FEED)).resolves.toBe('{"incidents":[]}');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${PROXY}/fetch`);
    const sent = JSON.parse(String(init?.body)) as { url: string; headers: Record<string, string> };
    expect(sent.url).toBe(FEED);
    expect(sent.headers["user-agent"]).toMatch(/^Infrawrench-StatusFeeds\//);
  });

  it("refuses an empty 2xx, the shape of a bot check, rather than parsing it", async () => {
    fetchMock.mockResolvedValueOnce(proxyReply(202, ""));
    await expect(fetchStatusFeedBody(FEED)).rejects.toThrow(/HTTP 202 with an empty body/);
  });

  it("fetches directly, skipping the proxy, for a feed the edge cannot reach", async () => {
    fetchMock.mockResolvedValueOnce(new Response('{"service_alerts":[]}'));
    await expect(fetchStatusFeedBody(FEED, { direct: true })).resolves.toBe(
      '{"service_alerts":[]}',
    );
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(FEED);
    expect(new Headers(init?.headers).get("user-agent")).toMatch(/^Infrawrench-StatusFeeds\//);
  });
});
