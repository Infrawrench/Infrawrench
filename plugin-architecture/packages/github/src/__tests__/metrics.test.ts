import { afterEach, describe, expect, it, vi } from "vitest";
import { copilotActiveUserSeries } from "../metrics.js";
import { ctxWith, makeHttp } from "./helpers.js";

describe("Copilot report downloads", () => {
  const LINK = "https://reports.githubusercontent.com/signed";
  const range = { startMs: Date.parse("2026-09-01"), endMs: Date.parse("2026-09-30") };
  const REPORT = JSON.stringify({ day: "2026-09-10", daily_active_users: 4 });
  const route = (url: URL) =>
    url.href === LINK ? { raw: REPORT } : { body: { download_links: [LINK] } };

  afterEach(() => vi.unstubAllGlobals());

  it("go through the host, carrying a custom CA, and never fetch", async () => {
    const fetchStub = vi.fn();
    vi.stubGlobal("fetch", fetchStub);
    const { http } = makeHttp(route);
    const request = vi.spyOn(http, "request");
    const [series] = await copilotActiveUserSeries({ ...ctxWith(http), caCert: "PEM" }, range);
    expect(series!.points.map((p) => p.value)).toEqual([4]);
    expect(request.mock.calls.at(-1)![0]).toMatchObject({ url: LINK, caCert: "PEM" });
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("carry no CA when none is set", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const { http } = makeHttp(route);
    const request = vi.spyOn(http, "request");
    await copilotActiveUserSeries(ctxWith(http), range);
    expect(request.mock.calls.at(-1)![0]).not.toHaveProperty("caCert");
  });
});
