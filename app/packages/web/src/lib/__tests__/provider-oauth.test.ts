import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("gt-react", () => ({ t: (s: string) => s }));

const apiPost = vi.fn();
const apiGet = vi.fn();
const apiPut = vi.fn();
vi.mock("../api", () => ({
  apiPost: (...args: unknown[]) => apiPost(...args),
  apiGet: (...args: unknown[]) => apiGet(...args),
  apiPut: (...args: unknown[]) => apiPut(...args),
}));

import { connectProviderOAuth, reconnectProviderAccount } from "../provider-oauth";

type Listener = (event: { origin: string; data: unknown }) => void;

let listeners: Listener[];
let popup: { closed: boolean; close: ReturnType<typeof vi.fn>; location: { href: string } };
let openSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  listeners = [];
  popup = { closed: false, close: vi.fn(), location: { href: "about:blank" } };
  openSpy = vi.fn(() => popup);
  vi.stubGlobal("window", {
    location: { origin: "https://app.example.test" },
    screenX: 0,
    screenY: 0,
    outerWidth: 1200,
    outerHeight: 900,
    open: openSpy,
    addEventListener: (_: string, fn: Listener) => listeners.push(fn),
    removeEventListener: (_: string, fn: Listener) => {
      listeners = listeners.filter((l) => l !== fn);
    },
  });
  vi.stubGlobal("BroadcastChannel", undefined);
  apiPost.mockReset().mockResolvedValue({ url: "https://provider.example.test/authorize" });
  apiGet.mockReset();
  apiPut.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function post(origin: string, data: unknown) {
  for (const l of [...listeners]) l({ origin, data });
}

describe("connectProviderOAuth", () => {
  it("opens the popup before asking the server, then points it at the consent", async () => {
    const pending = connectProviderOAuth("org-1", "acme", {});
    expect(openSpy).toHaveBeenCalledTimes(1);
    expect(apiPost).toHaveBeenCalledWith("/api/org/org-1/provider-oauth/acme/authorize", {
      returnTo: "web",
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(popup.location.href).toBe("https://provider.example.test/authorize");

    post("https://evil.example.test", {
      type: "infrawrench:provider-oauth",
      ok: true,
      pluginId: "acme",
      credentials: { apiToken: "stolen" },
    });
    post("https://app.example.test", {
      type: "infrawrench:provider-oauth",
      ok: true,
      pluginId: "acme",
      credentials: { apiToken: "at_1", __oauth: "sealed" },
      accountName: "Acme Corp",
    });
    await expect(pending).resolves.toEqual({
      credentials: { apiToken: "at_1", __oauth: "sealed" },
      accountName: "Acme Corp",
    });
    expect(popup.close).toHaveBeenCalled();
    expect(listeners).toHaveLength(0);
  });

  it("rejects with the provider's error", async () => {
    const pending = connectProviderOAuth("org-1", "acme", { accountId: "acc-1" });
    expect(apiPost.mock.calls[0]![1]).toEqual({ returnTo: "web", accountId: "acc-1" });
    post("https://app.example.test", {
      type: "infrawrench:provider-oauth",
      ok: false,
      pluginId: "acme",
      error: "access_denied",
    });
    await expect(pending).rejects.toThrow("access_denied");
  });

  it("rejects when the browser blocks the popup", async () => {
    openSpy.mockReturnValueOnce(null);
    await expect(connectProviderOAuth("org-1", "acme", {})).rejects.toThrow(/blocked/);
    expect(apiPost).not.toHaveBeenCalled();
  });

  it("treats a closed popup as a cancel", async () => {
    const pending = connectProviderOAuth("org-1", "acme", {});
    const caught = pending.catch((e: unknown) => e);
    popup.closed = true;
    await vi.advanceTimersByTimeAsync(3000);
    const err = (await caught) as Error;
    expect(err.name).toBe("AbortError");
  });
});

describe("reconnectProviderAccount", () => {
  it("merges the new grant over the stored credentials", async () => {
    apiGet.mockResolvedValue({ apiToken: "at_old", teamId: "team-9" });
    apiPut.mockResolvedValue({});
    const pending = reconnectProviderAccount("org-1", "acc-1", "acme");
    post("https://app.example.test", {
      type: "infrawrench:provider-oauth",
      ok: true,
      pluginId: "acme",
      credentials: { apiToken: "at_new", __oauth: "sealed" },
    });
    await pending;
    expect(apiPut).toHaveBeenCalledWith("/api/org/org-1/accounts/acc-1/credentials", {
      credentials: { apiToken: "at_new", __oauth: "sealed", teamId: "team-9" },
    });
  });
});
